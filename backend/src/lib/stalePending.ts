import { prisma } from "./prisma";
import { markFailed, markSent } from "./deliveryLedger";
import { sendNotificationEmail } from "./mailer";
import { unsubscribeHeaders, unsubscribeUrl } from "./unsubscribe";
import { isPushConfigured, sendPushToUser } from "./push";
import { DeliveryChannel, DeliveryStatus } from "../generated/prisma/enums";

/**
 * Resolves deliveries that were claimed and never settled.
 *
 * THE HOLE THIS CLOSES, AND HOW IT WAS FOUND
 * The ledger claims a delivery BEFORE calling the provider, which is what makes
 * a redelivery safe. The cost is a window: a consumer killed between the claim
 * and the settle leaves a `PENDING` row, and on redelivery that row collides
 * with the strict claim and is read as an ordinary duplicate. Nothing sends,
 * nothing retries, and the row looks like proof the work was done.
 *
 * ADR 0026 calls this the ambiguous middle and specifies exactly this sweeper.
 * It went unbuilt through four phases. `scripts/consumer-failure-demo.ts` is
 * what made it undeniable: it had to be taught that a `PENDING` row is a LOSS
 * and not a delivery, because its first version counted one as success.
 *
 * WHY THE POLICY DIFFERS PER CHANNEL, WHICH LOOKS LIKE INCONSISTENCY
 * It is not. The outcome is unknown either way — no email or SMS provider
 * offers "did you already accept this?" keyed by our id — so every option here
 * is a guess, and the right guess depends on what a wrong one costs.
 *
 *   Email, push   RESEND. A duplicate is a minor annoyance; a missing refund
 *                 notice is not. Push additionally collapses on the device by
 *                 tag, so a duplicate is often invisible.
 *   SMS           NEVER RESEND. Mark FAILED for a human. A duplicate text
 *                 costs real money and, worse, reads like a phishing retry to
 *                 the recipient — who cannot tell one from the other.
 *
 * Encoding that next to the channel is what stops somebody applying the email
 * policy to SMS because it was the default.
 */

/**
 * How long a `PENDING` row has to sit before it is presumed abandoned.
 *
 * Generously long on purpose. A row is legitimately `PENDING` for as long as a
 * provider call takes, and SMTP to a slow host can take tens of seconds. Ten
 * minutes is far beyond any real call and far short of anyone noticing a
 * missing notification.
 */
function staleAfterMs(): number {
  const minutes = Number(process.env.DELIVERY_STALE_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 10) * 60_000;
}

const BATCH = 200;

export type StaleResult = {
  resent: number;
  failed: number;
  /** Rows a human has to look at — every one of them an SMS. */
  needsReview: number;
};

function frontendOrigin(): string {
  return process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
}

function absolute(link: string | null): string | null {
  if (!link) return null;
  if (/^https?:\/\//i.test(link)) return link;
  return `${frontendOrigin()}${link.startsWith("/") ? "" : "/"}${link}`;
}

/**
 * Claims one stale row for this sweeper.
 *
 * A CONDITIONAL UPDATE, as everywhere else. `status: PENDING` plus the age
 * bound in the where clause is the claim, so two API replicas running this
 * sweeper cannot both resend the same message. `attempts` is incremented so the
 * row carries the fact that something other than the original consumer touched
 * it.
 */
async function claimStale(id: string, before: Date): Promise<boolean> {
  const { count } = await prisma.notificationDelivery.updateMany({
    where: { id, status: DeliveryStatus.PENDING, createdAt: { lt: before } },
    data: { attempts: { increment: 1 } },
  });
  return count === 1;
}

export async function sweepStalePendingOnce(now: Date = new Date()): Promise<StaleResult> {
  const before = new Date(now.getTime() - staleAfterMs());
  const result: StaleResult = { resent: 0, failed: 0, needsReview: 0 };

  const stale = await prisma.notificationDelivery.findMany({
    where: { status: DeliveryStatus.PENDING, createdAt: { lt: before } },
    orderBy: { createdAt: "asc" },
    take: BATCH,
    select: { id: true, eventId: true, channel: true, userId: true, notificationId: true },
  });

  for (const row of stale) {
    if (!(await claimStale(row.id, before))) continue;

    /**
     * SMS stops here, before anything is sent, and that ordering is the point:
     * the decision not to resend must not depend on a later branch being
     * reached.
     */
    if (row.channel === DeliveryChannel.SMS) {
      await markFailed(
        row.id,
        new Error(
          "claimed but never settled — a consumer died mid-send. Not resent: a " +
            "duplicate SMS costs money and reads as a phishing retry. Needs review."
        ),
        true
      );
      result.failed += 1;
      result.needsReview += 1;
      continue;
    }

    /**
     * The text is read back from `notifications` rather than from the event,
     * which is long gone from the topic by the time this runs. Same reasoning
     * as the deferred sweeper: that table is the source of truth.
     */
    const notification = row.notificationId
      ? await prisma.notification.findUnique({
          where: { id: row.notificationId },
          select: { userId: true, title: true, body: true, link: true, type: true },
        })
      : null;

    if (!notification) {
      await markFailed(
        row.id,
        new Error("claimed but never settled, and the notification no longer exists"),
        true
      );
      result.failed += 1;
      continue;
    }

    try {
      if (row.channel === DeliveryChannel.EMAIL) {
        const user = await prisma.user.findUnique({
          where: { id: notification.userId },
          select: { email: true, emailVerified: true },
        });
        if (!user?.emailVerified) {
          throw new Error("address is no longer verified");
        }

        const token = {
          userId: notification.userId,
          channel: DeliveryChannel.EMAIL,
          scope: notification.type,
        };
        const sent = await sendNotificationEmail({
          to: user.email,
          title: notification.title,
          body: notification.body,
          actionUrl: absolute(notification.link),
          actionLabel: "Open RetailStore_2n",
          unsubscribeUrl: unsubscribeUrl(token),
          headers: unsubscribeHeaders(token),
        });
        await markSent(row.id, sent.messageId);
        result.resent += 1;
        continue;
      }

      // Push.
      if (!isPushConfigured()) throw new Error("push is not configured on this server");
      const pushed = await sendPushToUser(notification.userId, {
        title: notification.title,
        body: notification.body,
        url: notification.link,
        /**
         * The SAME tag the original send would have used, so if the first
         * attempt did land the device replaces it rather than showing two.
         * That is most of why resending push is cheap.
         */
        tag: row.eventId,
      });
      if (pushed.sent === 0) throw new Error("no devices subscribed");
      await markSent(row.id, null);
      result.resent += 1;
    } catch (err) {
      await markFailed(row.id, err, true);
      result.failed += 1;
    }
  }

  return result;
}

/**
 * Every five minutes. The staleness threshold is ten, so nothing waits much
 * longer than fifteen — and unlike the deferred sweeper, a delay here is a
 * notification already late rather than one deliberately held.
 */
export function startStalePendingSweeper(intervalMs = 300_000) {
  async function tick() {
    try {
      const { resent, failed, needsReview } = await sweepStalePendingOnce();
      if (resent > 0 || failed > 0) {
        console.log(
          `Stale-pending sweeper resent ${resent}, failed ${failed}` +
            (needsReview > 0 ? `, ${needsReview} SMS need review` : "")
        );
      }
    } catch (err) {
      console.error("Stale-pending sweeper failed", err);
    }
  }

  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
