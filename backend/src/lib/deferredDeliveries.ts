import { prisma } from "./prisma";
import { markSuppressed, redeliverDeferred } from "./deliveryLedger";
import { sendSmsToUser } from "./consumers/sms";
import { DeliveryChannel, DeliveryStatus } from "../generated/prisma/enums";

/**
 * Sends the messages that quiet hours parked.
 *
 * WHY THIS IS A SWEEPER AND NOT A KAFKA DELAY TOPIC
 * The retry ladder already knows how to make a message wait, so the obvious
 * move is a fourth rung. It does not work: a rung waits by PAUSING its
 * partition, and an eight-hour pause holds that partition open all night for
 * every other message behind it. The ladder is built for minutes.
 *
 * A sweeper is also the shape this codebase already uses three times over —
 * `startReservationSweeper`, `startOrderSweeper`, and the outbox relay — and
 * for the same reason each of those exists: recovering state that nothing in
 * the request path will ever reach again.
 *
 * WHY THE LEDGER IS THE QUEUE
 * The row already exists, already carries the idempotency guard, and is
 * already what a support question is answered from. A second queue holding the
 * same fact would be a second thing to keep in step with the first.
 */

/** How often to look. The window boundary is not precise enough to need more. */
const DEFAULT_INTERVAL_MS = 60_000;

/** Rows per pass. Bounded so one long outage cannot produce one enormous pass. */
const BATCH = 100;

/**
 * Past this, a parked message is dropped rather than sent.
 *
 * A "your refund was issued" text arriving two days late is worse than none: it
 * re-alarms somebody about something already resolved, and it arrives with no
 * explanation of why it is late. The cap exists for the case where the sweeper
 * was down, not for the ordinary overnight wait — which is hours.
 */
function maxAgeMs(): number {
  const hours = Number(process.env.SMS_DEFER_MAX_AGE_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3600_000;
}

export type SweepResult = { sent: number; expired: number; skipped: number };

/**
 * One pass. Exported so a test can drive it deterministically rather than
 * waiting on a timer — the same arrangement as `relayOnce`.
 */
export async function sweepDeferredOnce(now: Date = new Date()): Promise<SweepResult> {
  const due = await prisma.notificationDelivery.findMany({
    where: { status: DeliveryStatus.DEFERRED, notBefore: { lte: now } },
    orderBy: { notBefore: "asc" },
    take: BATCH,
    select: { id: true, channel: true, notificationId: true, createdAt: true },
  });

  const result: SweepResult = { sent: 0, expired: 0, skipped: 0 };
  const cutoff = now.getTime() - maxAgeMs();

  for (const row of due) {
    /**
     * Too old to be useful. Settled as SUPPRESSED with a reason, so the row
     * still answers "why did I not get a text" — which "it was silently
     * dropped by a cleanup" does not.
     */
    if (row.createdAt.getTime() < cutoff) {
      await markSuppressed(row.id, "deferred too long to still be worth sending");
      result.expired += 1;
      continue;
    }

    /**
     * SMS is the only channel that defers. Anything else here is a bug or a
     * future channel, and sending it through the SMS path would be worse than
     * leaving it alone and saying so.
     */
    if (row.channel !== DeliveryChannel.SMS) {
      console.warn(`[deferred] ${row.id} is ${row.channel}, which does not defer; skipping`);
      result.skipped += 1;
      continue;
    }

    /**
     * The text is read back from the notification rather than snapshotted onto
     * the delivery row. `notifications` is the source of truth — lib/
     * notifications.ts says so — and a copy here would be a second version of
     * the same sentence, free to drift.
     */
    const notification = row.notificationId
      ? await prisma.notification.findUnique({
          where: { id: row.notificationId },
          select: { userId: true, title: true, body: true },
        })
      : null;

    if (!notification) {
      await markSuppressed(row.id, "the notification it belonged to no longer exists");
      result.expired += 1;
      continue;
    }

    const outcome = await redeliverDeferred(
      row.id,
      () =>
        sendSmsToUser({
          userId: notification.userId,
          title: notification.title,
          body: notification.body,
        }),
      now
    );

    if (outcome === "sent") result.sent += 1;
    else result.skipped += 1;
  }

  return result;
}

/**
 * Shaped like startReservationSweeper and startOrderSweeper — a timer that
 * runs immediately and then on an interval, unref'd so it never holds the
 * process open on shutdown.
 */
export function startDeferredSweeper(intervalMs = DEFAULT_INTERVAL_MS) {
  async function tick() {
    try {
      const { sent, expired } = await sweepDeferredOnce();
      if (sent > 0 || expired > 0) {
        console.log(
          `Deferred sweeper sent ${sent} message(s)` +
            (expired > 0 ? `, dropped ${expired} as too old` : "")
        );
      }
    } catch (err) {
      console.error("Deferred sweeper failed", err);
    }
  }

  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
