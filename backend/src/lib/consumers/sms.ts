import { DeferDelivery, NothingToDeliverTo, PermanentFailure, deliver } from "../deliveryLedger";
import { prisma } from "../prisma";
import { SmsSendError, sendSms } from "../smsProvider";
import { quietHoursNow } from "../quietHours";
import type { NotificationConsumer } from "../consumers";
import { DeliveryChannel, DeliveryStatus } from "../../generated/prisma/enums";

/**
 * The SMS channel.
 *
 * As with email and push, everything that makes this safe is in
 * deliveryLedger.deliver(). This file knows what is specific to SMS, and SMS is
 * the channel where being wrong is most expensive: every message costs money,
 * arrives on a device that buzzes at 3am, and — unlike an email nobody reads —
 * is regulated.
 *
 * So there are three gates here that the other channels do not have.
 */

/**
 * Messages per user per day, across every event type.
 *
 * A CIRCUIT BREAKER, NOT A PREFERENCE. Preferences are what the recipient
 * chose; this is protection against a bug they did not. A loop that re-emits
 * one event, or a seller cancelling forty lines of one basket, would otherwise
 * be forty texts and a bill — and the person on the other end has no way to
 * stop it except blocking the sender, which they will not undo.
 */
function dailyCap(): number {
  const raw = Number(process.env.SMS_DAILY_CAP);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * SMS bodies are deliberately thin.
 *
 * 160 characters is one segment and each further segment is charged again, but
 * cost is the smaller reason. The larger one is that a text is read on a lock
 * screen, possibly by someone other than the recipient, so it says that
 * something happened and where to look — never the amount, never the item.
 */
function compose(title: string, body: string | null): string {
  const line = body ? `${title} — ${body}` : title;
  const trimmed = line.length > 130 ? `${line.slice(0, 127)}...` : line;
  return `RetailStore_2n: ${trimmed}`;
}

/**
 * Everything that decides whether one SMS may be sent, and sends it.
 *
 * SHARED ON PURPOSE. The consumer calls it for a message off the topic, and
 * the deferred sweeper calls it for a message that was parked overnight. If
 * these were two copies, the gates would drift — and the copy that drifted
 * would be the one that runs at 8am on a refund, unattended.
 *
 * Throws rather than returns, because the ledger is what interprets the
 * outcome: NothingToDeliverTo settles SUPPRESSED, DeferDelivery parks the row,
 * PermanentFailure keeps it off the retry ladder, anything else rides it.
 */
export async function sendSmsToUser(input: {
  userId: string;
  title: string;
  body: string | null;
}): Promise<{ providerMessageId: string }> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { phone: true, phoneVerifiedAt: true, smsConsentAt: true },
  });

  if (!user) {
    throw new PermanentFailure(`no such user ${input.userId}`);
  }

  /**
   * THE GATE. Not a preference and not a failure — most accounts simply never
   * added a number, exactly as most never granted push permission. Recording
   * it as FAILED would paint the ledger red for the ordinary state of the
   * majority.
   */
  if (!user.phone || !user.phoneVerifiedAt) {
    throw new NothingToDeliverTo("no verified phone number");
  }

  /**
   * Verified but not consented. Distinct from the above on purpose: this is
   * somebody who proved the number and then turned SMS off, and the ledger
   * should say which of the two happened.
   */
  if (!user.smsConsentAt) {
    throw new NothingToDeliverTo("phone verified but SMS consent withdrawn");
  }

  /**
   * QUIET HOURS DEFER. The row is parked with the moment the window closes and
   * a sweeper sends it then — see lib/deferredDeliveries.ts.
   *
   * Dropping instead would be defensible only by arguing that the other
   * channels carry the same event, which is true today and is not a property
   * anyone should have to keep true. Parking costs one column and one timer.
   */
  const quiet = quietHoursNow();
  if (quiet.inWindow && quiet.opensAt) {
    throw new DeferDelivery(quiet.opensAt, `quiet hours (${quiet.window})`);
  }

  const sentToday = await prisma.notificationDelivery.count({
    where: {
      userId: input.userId,
      channel: DeliveryChannel.SMS,
      status: DeliveryStatus.SENT,
      completedAt: { gte: startOfToday() },
    },
  });

  const cap = dailyCap();
  if (sentToday >= cap) {
    throw new NothingToDeliverTo(`daily SMS cap reached (${cap})`);
  }

  try {
    return await sendSms({
      to: user.phone,
      body: compose(input.title, input.body),
    });
  } catch (err) {
    /**
     * The provider classified it; this turns that into the type the ladder
     * reads. A rejected number, or a recipient who replied STOP, must never
     * ride the ladder — retrying an opt-out is the one failure here that is
     * also unlawful.
     */
    if (err instanceof SmsSendError && err.permanent) {
      throw new PermanentFailure(err.message);
    }
    throw err;
  }
}

export const smsConsumer: NotificationConsumer = {
  group: "sms-worker",
  channel: DeliveryChannel.SMS,

  async handle(event, opts) {
    return deliver(
      event,
      DeliveryChannel.SMS,
      () =>
        sendSmsToUser({
          userId: event.userId,
          title: event.payload.title,
          body: event.payload.body,
        }),
      opts
    );
  },
};
