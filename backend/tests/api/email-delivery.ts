import { prisma, requireServices } from "../lib/db";
import { main, wireInterrupt, cleanupOnInterrupt } from "../lib/harness";
import { notify } from "../../src/lib/notifications";
import { relayOnce } from "../../src/lib/relay";
import { resetTransport } from "../../src/lib/notifyTransport";
import { setPreference, preferencesFor, isOffered } from "../../src/lib/channelPolicy";
import { mintUnsubscribeToken, readUnsubscribeToken } from "../../src/lib/unsubscribe";
import {
  DeliveryChannel,
  DeliveryStatus,
  NotificationType,
} from "../../src/generated/prisma/enums";

/**
 * Email delivery: the ledger, preferences, and unsubscribe tokens.
 *
 * WHAT THIS SUITE IS FOR
 * The whole point of phase 2 is that a redelivered event does not become a
 * second email. That cannot be observed from a response — a duplicate send and
 * a correctly-deduplicated one both look like success from the outside — so it
 * is asserted here against the ledger rows.
 *
 * MAIL_TRANSPORT=console, so nothing is actually sent. The consumer runs in
 * full: preferences resolve, the delivery is claimed, the message is composed,
 * and the outcome is settled. Only the SMTP handshake is absent, which is the
 * same trade the rest of the suite makes.
 *
 * See docs/adr/0026-delivery-idempotency.md and
 *     docs/adr/0027-notification-consent-and-preferences.md
 */

const TAG = `rs2.email.${Date.now()}`;
let userId = "";

/** The event a notification produced, for asserting deliveries against. */
async function eventIdFor(aggregateId: string): Promise<string> {
  const row = await prisma.outboxEvent.findFirst({
    where: { userId, aggregateId },
    select: { eventId: true },
  });
  if (!row) throw new Error(`no outbox event for ${aggregateId}`);
  return row.eventId;
}

async function deliveriesFor(eventId: string) {
  return prisma.notificationDelivery.findMany({
    where: { eventId },
    orderBy: { channel: "asc" },
  });
}

void main(
  "email delivery",

  async (t) => {
    await requireServices({ api: false, db: true });

    if ((process.env.NOTIFY_TRANSPORT ?? "inline").toLowerCase() !== "inline") {
      t.check(false, "runs on the inline transport", process.env.NOTIFY_TRANSPORT);
      return;
    }

    await resetTransport();

    const user = await prisma.user.create({
      data: {
        email: `${TAG}@retailstore-2n.test`,
        name: "Email Test",
        passwordHash: "not-a-real-hash",
        // The consumer refuses to mail an unverified address, so this has to be
        // true for anything to be sent at all — asserted on its own below.
        emailVerified: true,
      },
      select: { id: true },
    });
    userId = user.id;

    /* ---------------------------------------------------------------- */
    t.section("an on-by-default type is delivered, once");

    await notify({
      userId,
      type: NotificationType.REFUND_ISSUED,
      title: "$32 refunded",
      body: "It can take a few days to appear on your statement.",
      link: "/orders/abc",
      aggregateType: "test",
      aggregateId: "refund-1",
    });

    const refundEvent = await eventIdFor("refund-1");
    await relayOnce();

    const first = await deliveriesFor(refundEvent);
    const email = first.find((d) => d.channel === DeliveryChannel.EMAIL);

    t.check(!!email, "an email delivery row exists", first.map((d) => d.channel));
    t.check(
      email?.status === DeliveryStatus.SENT,
      "marked SENT",
      `${email?.status} ${email?.lastError ?? ""}`
    );
    t.check(email?.userId === userId, "attributed to the recipient", email?.userId);
    t.check(email?.attempts === 1, "one attempt", email?.attempts);

    /* ---------------------------------------------------------------- */
    t.section("a redelivery does NOT send a second email");

    // Exactly what a relay restart or a consumer rebalance produces: the same
    // event, handed to the same consumer, a second time.
    await prisma.outboxEvent.updateMany({
      where: { userId, aggregateId: "refund-1" },
      data: { publishedAt: null },
    });

    const replay = await relayOnce();
    t.check(replay.published === 1, "the event was republished", replay.published);

    const afterReplay = await deliveriesFor(refundEvent);
    const emailRows = afterReplay.filter((d) => d.channel === DeliveryChannel.EMAIL);

    t.check(
      emailRows.length === 1,
      "STILL exactly one email delivery — the unique constraint held",
      emailRows.length
    );
    t.check(
      emailRows[0]?.attempts === 1,
      "and it was not re-attempted",
      emailRows[0]?.attempts
    );

    /* ---------------------------------------------------------------- */
    t.section("a type email is not used for is SUPPRESSED, not sent");

    // REVIEW_RECEIVED is push-only by policy — see lib/channelPolicy.ts.
    t.check(
      !isOffered(NotificationType.REVIEW_RECEIVED, DeliveryChannel.EMAIL),
      "policy says email is not offered for REVIEW_RECEIVED"
    );

    await notify({
      userId,
      type: NotificationType.REVIEW_RECEIVED,
      title: "5-star review",
      aggregateType: "test",
      aggregateId: "review-1",
    });
    const reviewEvent = await eventIdFor("review-1");
    await relayOnce();

    const reviewRows = await deliveriesFor(reviewEvent);
    const reviewEmail = reviewRows.find((d) => d.channel === DeliveryChannel.EMAIL);

    t.check(
      reviewEmail?.status === DeliveryStatus.SUPPRESSED,
      "recorded as SUPPRESSED rather than dropped",
      reviewEmail?.status
    );
    t.check(
      (reviewEmail?.suppressReason ?? "").length > 0,
      "with a reason somebody can read",
      reviewEmail?.suppressReason
    );

    /* ---------------------------------------------------------------- */
    t.section("turning a channel off suppresses it");

    await setPreference({
      userId,
      type: NotificationType.ORDER_SHIPPED,
      channel: DeliveryChannel.EMAIL,
      enabled: false,
    });

    await notify({
      userId,
      type: NotificationType.ORDER_SHIPPED,
      title: "On its way",
      aggregateType: "test",
      aggregateId: "shipped-1",
    });
    const shippedEvent = await eventIdFor("shipped-1");
    await relayOnce();

    const shippedEmail = (await deliveriesFor(shippedEvent)).find(
      (d) => d.channel === DeliveryChannel.EMAIL
    );

    t.check(
      shippedEmail?.status === DeliveryStatus.SUPPRESSED,
      "suppressed by the recipient's choice",
      shippedEmail?.status
    );
    t.check(
      (shippedEmail?.suppressReason ?? "").includes("turned off"),
      "and the reason says so",
      shippedEmail?.suppressReason
    );

    /* ---------------------------------------------------------------- */
    t.section("preferences: absent means default, explicit wins both ways");

    const prefs = await preferencesFor(userId);
    const shipped = prefs.find((p) => p.type === NotificationType.ORDER_SHIPPED);
    const shippedEmailPref = shipped?.channels.find(
      (c) => c.channel === DeliveryChannel.EMAIL
    );
    const saleSms = prefs
      .find((p) => p.type === NotificationType.SALE_MADE)
      ?.channels.find((c) => c.channel === DeliveryChannel.SMS);
    const refundEmailPref = prefs
      .find((p) => p.type === NotificationType.REFUND_ISSUED)
      ?.channels.find((c) => c.channel === DeliveryChannel.EMAIL);

    t.check(
      shippedEmailPref?.enabled === false && shippedEmailPref?.isDefault === false,
      "an explicit off reads back as a choice, not a default",
      JSON.stringify(shippedEmailPref)
    );
    t.check(
      refundEmailPref?.enabled === true && refundEmailPref?.isDefault === true,
      "an untouched on-by-default reads as a default",
      JSON.stringify(refundEmailPref)
    );
    t.check(
      saleSms?.enabled === false && saleSms?.isDefault === true,
      "SALE_MADE over SMS is opt-in, so off by default",
      JSON.stringify(saleSms)
    );

    const reviewChannels = prefs.find(
      (p) => p.type === NotificationType.REVIEW_RECEIVED
    )?.channels;
    t.check(
      !reviewChannels?.some((c) => c.channel === DeliveryChannel.EMAIL),
      "a channel that is never used is not offered as a switch",
      JSON.stringify(reviewChannels)
    );

    const suspendedChannels = prefs.find(
      (p) => p.type === NotificationType.ACCOUNT_SUSPENDED
    )?.channels;
    t.check(
      !suspendedChannels?.some((c) => c.channel === DeliveryChannel.PUSH),
      "ACCOUNT_SUSPENDED offers no push — they cannot open the app",
      JSON.stringify(suspendedChannels)
    );

    /* ---------------------------------------------------------------- */
    t.section("an unverified address is a failure, not a suppression");

    await prisma.user.update({ where: { id: userId }, data: { emailVerified: false } });

    await notify({
      userId,
      type: NotificationType.REFUND_ISSUED,
      title: "$5 refunded",
      aggregateType: "test",
      aggregateId: "refund-unverified",
    });
    const unverifiedEvent = await eventIdFor("refund-unverified");
    await relayOnce();

    const unverifiedEmail = (await deliveriesFor(unverifiedEvent)).find(
      (d) => d.channel === DeliveryChannel.EMAIL
    );

    t.check(
      unverifiedEmail?.status === DeliveryStatus.FAILED,
      "FAILED, because the recipient did not choose this",
      unverifiedEmail?.status
    );
    t.check(
      (unverifiedEmail?.lastError ?? "").includes("not verified"),
      "and the reason is recorded",
      unverifiedEmail?.lastError
    );

    await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });

    /* ---------------------------------------------------------------- */
    t.section("unsubscribe tokens");

    const token = mintUnsubscribeToken({
      userId,
      channel: DeliveryChannel.EMAIL,
      scope: NotificationType.SALE_MADE,
    });
    const read = readUnsubscribeToken(token);

    t.check(read?.userId === userId, "a minted token round-trips", read?.userId);
    t.check(read?.scope === NotificationType.SALE_MADE, "carrying its scope", read?.scope);

    // Flip one character of the signature. Every byte of it has to matter.
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    t.check(readUnsubscribeToken(tampered) === null, "a tampered signature is refused");

    // Re-sign nothing: swap the body, keep the MAC.
    const [, mac] = [token.slice(0, token.lastIndexOf(".")), token.slice(token.lastIndexOf(".") + 1)];
    const forgedBody = Buffer.from(`${userId}.EMAIL.REFUND_ISSUED`, "utf8").toString("base64url");
    t.check(
      readUnsubscribeToken(`${forgedBody}.${mac}`) === null,
      "a swapped payload under the same MAC is refused"
    );

    t.check(readUnsubscribeToken(undefined) === null, "no token is refused");
    t.check(readUnsubscribeToken("garbage") === null, "garbage is refused");

    /* ---------------------------------------------------------------- */
    t.section("nothing is left pending");

    const stuck = await prisma.notificationDelivery.count({
      where: { userId, status: DeliveryStatus.PENDING },
    });
    t.check(stuck === 0, "no delivery stuck in PENDING", stuck);
  },

  async () => {
    if (userId) {
      await prisma.notificationDelivery.deleteMany({ where: { userId } });
      await prisma.outboxEvent.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await resetTransport();
  }
);

wireInterrupt();
cleanupOnInterrupt(async () => {
  if (userId) {
    await prisma.notificationDelivery.deleteMany({ where: { userId } });
    await prisma.outboxEvent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
