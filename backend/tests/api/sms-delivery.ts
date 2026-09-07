import { randomUUID } from "crypto";
import { prisma, requireServices } from "../lib/db";
import { main, wireInterrupt, cleanupOnInterrupt } from "../lib/harness";
import { smsConsumer } from "../../src/lib/consumers/sms";
import { InvalidPhoneNumber, maskPhone, toE164 } from "../../src/lib/phone";
import { quietHoursNow } from "../../src/lib/quietHours";
import { sweepDeferredOnce } from "../../src/lib/deferredDeliveries";
import { __clearStubMessages, stubMessages } from "../../src/lib/smsProvider";
import { issueAndSendCode, removePhone, verifyCode } from "../../src/lib/smsVerification";
import type { NotificationEvent } from "../../src/lib/outbox";
import {
  DeliveryChannel,
  DeliveryStatus,
  NotificationType,
} from "../../src/generated/prisma/enums";

/**
 * SMS: consent, verification, and the gates before a message costs money.
 *
 * WHAT THIS SUITE IS FOR
 * SMS is the channel where being wrong is most expensive — every send is
 * billed, arrives on a lock screen, and is regulated. So the claims worth
 * asserting are mostly about NOT sending:
 *
 *   1. Nothing is sent to a number nobody proved. `phoneVerifiedAt` is the
 *      gate, and an unverified number must be indistinguishable from no number.
 *   2. A six-digit code is single-use, expiring, and attempt-capped. Unlike a
 *      32-byte token it is genuinely guessable, so the caps ARE the security.
 *   3. `Address.phone` never leaks into `User.phone`. That is the trap ADR 0027
 *      exists to close, and the cost of getting it wrong is texting a stranger.
 *
 * Runs against SMS_PROVIDER=stub, which is the default. Nothing here reaches
 * Twilio, and no secret is needed — the same arrangement as the payment and
 * identity seams.
 */

const TAG = `rs2.sms.${Date.now()}`;

let userId = "";
let otherUserId = "";

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    eventId: randomUUID(),
    type: NotificationType.REFUND_ISSUED,
    userId,
    aggregateType: "Refund",
    aggregateId: randomUUID(),
    payload: {
      notificationId: randomUUID(),
      title: "A refund was issued",
      body: "Your money is on its way back.",
      link: null,
    },
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * An event whose notification actually EXISTS.
 *
 * The deferred sweeper reads the text back from `notifications` rather than
 * snapshotting it onto the delivery row, because that table is the source of
 * truth and a copy would be free to drift. So anything testing the sweeper has
 * to have a real row to read — an event pointing at a notification id that was
 * never written is, correctly, a message the sweeper refuses to invent.
 */
async function eventWithNotification(): Promise<NotificationEvent> {
  const base = event();
  const created = await prisma.notification.create({
    data: {
      userId,
      type: base.type,
      title: base.payload.title,
      body: base.payload.body,
      link: base.payload.link,
    },
    select: { id: true },
  });
  return { ...base, payload: { ...base.payload, notificationId: created.id } };
}

async function rowFor(eventId: string) {
  return prisma.notificationDelivery.findUnique({
    where: { eventId_channel: { eventId, channel: DeliveryChannel.SMS } },
  });
}

/** Runs the consumer with quiet hours off, so the window is not under test. */
async function handle(e: NotificationEvent) {
  const before = process.env.SMS_QUIET_HOURS;
  process.env.SMS_QUIET_HOURS = "off";
  try {
    return await smsConsumer.handle(e);
  } finally {
    if (before === undefined) delete process.env.SMS_QUIET_HOURS;
    else process.env.SMS_QUIET_HOURS = before;
  }
}

void main(
  "sms delivery",

  async (t) => {
    await requireServices({ api: false, db: true });

    if ((process.env.SMS_PROVIDER ?? "stub") !== "stub") {
      t.note(
        `SMS_PROVIDER is "${process.env.SMS_PROVIDER}" — this suite would send real ` +
          "messages and bill a real account."
      );
      t.check(false, "runs on the stub provider", process.env.SMS_PROVIDER);
      return;
    }

    /* ============================================================ *
     * 1. E.164, before anything else touches a number.
     * ============================================================ */
    t.section("1. Normalising what people type");

    t.check(toE164("+447700900123") === "+447700900123", "an E.164 number passes through");
    t.check(toE164("+44 7700 900 123") === "+447700900123", "spaces are removed");
    t.check(toE164("+44-7700-900123") === "+447700900123", "so are dashes");
    t.check(toE164("+1 (555) 010-9999") === "+15550109999", "and brackets");
    /**
     * "00" is the international prefix most of the world dials. Accepting it
     * costs one line and saves a support conversation with everyone who does.
     */
    t.check(toE164("00447700900123") === "+447700900123", "a 00 prefix becomes +");

    const rejects: Array<[string, string]> = [
      ["07700900123", "a national number with no country code"],
      ["+07700900123", "a leading zero, which no country code has"],
      ["+44770090012a", "letters"],
      ["", "an empty string"],
      ["+1234", "something far too short"],
      ["+1234567890123456", "something longer than E.164 allows"],
    ];
    for (const [input, why] of rejects) {
      let threw = false;
      try {
        toE164(input);
      } catch (err) {
        threw = err instanceof InvalidPhoneNumber;
      }
      t.check(threw, `rejects ${why}`, input);
    }

    /**
     * NOT REJECTED, and the suite says so rather than quietly not testing it:
     * "+44" followed by a national number with its trunk 0 still on is
     * indistinguishable from a valid number without a country-code table. It
     * fails at the next gate instead — no code arrives, so it is never
     * verified, so nothing is ever sent to it.
     */
    t.check(
      toE164("+4407700900123") === "+4407700900123",
      "a trunk 0 after the country code passes normalisation — the code is the real check",
      toE164("+4407700900123")
    );

    t.check(
      maskPhone("+447700900123") === "+44 ••• ••• 123",
      "masking keeps enough to recognise and not enough to dial",
      maskPhone("+447700900123")
    );

    /* ============================================================ *
     * 2. Verification.
     * ============================================================ */
    const user = await prisma.user.create({
      data: {
        email: `${TAG}@retailstore-2n.test`,
        name: "SMS Test",
        passwordHash: "not-a-real-hash",
        emailVerified: true,
      },
      select: { id: true },
    });
    userId = user.id;

    const other = await prisma.user.create({
      data: {
        email: `${TAG}.other@retailstore-2n.test`,
        name: "SMS Other",
        passwordHash: "not-a-real-hash",
        emailVerified: true,
      },
      select: { id: true },
    });
    otherUserId = other.id;

    const NUMBER = `+1555${String(Date.now()).slice(-7)}`;

    t.section("2. Proving the number");

    __clearStubMessages();
    const issued = await issueAndSendCode(userId, NUMBER);
    t.check(issued.phone === NUMBER, "the number is stored E.164", issued.phone);
    t.check(stubMessages().length === 1, "one message was sent", stubMessages().length);
    t.check(stubMessages()[0]?.to === NUMBER, "to that number", stubMessages()[0]?.to);
    t.check(
      /\b\d{6}\b/.test(stubMessages()[0]?.body ?? ""),
      "containing a six-digit code",
      stubMessages()[0]?.body
    );

    /**
     * THE NUMBER IS NOT ON THE USER YET. An unverified number sitting in the
     * column that governs delivery is one bug away from being texted, which is
     * the entire reason PhoneVerification holds it instead.
     */
    const midway = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, phoneVerifiedAt: true },
    });
    t.check(midway?.phone === null, "and User.phone is still empty", midway?.phone);
    t.check(midway?.phoneVerifiedAt === null, "and unverified", midway?.phoneVerifiedAt);

    const wrong = await verifyCode(userId, "000000");
    const wrongOk = wrong.ok === false && wrong.reason === "wrong-code";
    t.check(wrongOk, "a wrong code is refused", wrong);

    const code = issued.devCode!;
    const good = await verifyCode(userId, code);
    t.check(good.ok === true, "the right code is accepted", good);

    const verified = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, phoneVerifiedAt: true, smsConsentAt: true },
    });
    t.check(verified?.phone === NUMBER, "now the number is on the account", verified?.phone);
    t.check(!!verified?.phoneVerifiedAt, "verified");
    /**
     * Consent is recorded separately from verification, because proving a
     * number works is not the same as agreeing to be messaged on it — and it
     * is the consent that has to be produced if anyone asks.
     */
    t.check(!!verified?.smsConsentAt, "and consent is timestamped separately");

    /** Single-use: the same code must not work twice. */
    const replay = await verifyCode(userId, code);
    t.check(replay.ok === false, "the same code cannot be used again", replay);

    t.section("3. The code is attempt-capped");

    __clearStubMessages();
    const second = await issueAndSendCode(userId, NUMBER);
    for (let i = 0; i < 5; i += 1) await verifyCode(userId, "111111");

    const exhausted = await verifyCode(userId, second.devCode!);
    const capped = exhausted.ok === false && exhausted.reason === "too-many-attempts";
    t.check(
      capped,
      "past the attempt cap even the CORRECT code is refused",
      exhausted
    );

    t.section("4. One number, one account");

    let inUse = false;
    try {
      await issueAndSendCode(otherUserId, NUMBER);
    } catch (err) {
      inUse = (err as Error).name === "PhoneAlreadyInUse";
    }
    t.check(inUse, "a verified number cannot be claimed by a second account");

    t.section("5. Address.phone never becomes a contact number");

    /**
     * THE TRAP ADR 0027 EXISTS TO CLOSE. A parcel's delivery contact is
     * frequently a third party — a gift, a workplace reception, a relative's
     * landline — and it is typed into checkout with no verification at all.
     * Texting it would message somebody who never consented and cannot
     * unsubscribe.
     */
    await prisma.address.create({
      data: {
        userId: otherUserId,
        fullName: "Someone Else",
        line1: "1 Test Street",
        city: "Testville",
        postcode: "TE5 7XX",
        country: "GB",
        phone: "+447700900999",
      },
    });

    const otherUser = await prisma.user.findUnique({
      where: { id: otherUserId },
      select: { phone: true, phoneVerifiedAt: true },
    });
    t.check(
      otherUser?.phone === null,
      "saving an address leaves User.phone untouched",
      otherUser?.phone
    );
    t.check(
      otherUser?.phoneVerifiedAt === null,
      "and grants no verification",
      otherUser?.phoneVerifiedAt
    );

    /* ============================================================ *
     * 6. The consumer.
     * ============================================================ */
    t.section("6. Nothing is sent without a verified number");

    const noPhone = event({ userId: otherUserId });
    await handle(noPhone);
    const noPhoneRow = await rowFor(noPhone.eventId);
    t.check(
      noPhoneRow?.status === DeliveryStatus.SUPPRESSED,
      "an account with no number records SUPPRESSED, not FAILED",
      noPhoneRow?.status
    );
    t.check(
      noPhoneRow?.suppressReason?.includes("no verified phone") === true,
      "with a reason a support answer can quote",
      noPhoneRow?.suppressReason
    );

    /** Consent withdrawn is a DIFFERENT reason from never having a number. */
    await prisma.user.update({ where: { id: userId }, data: { smsConsentAt: null } });
    const noConsent = event();
    await handle(noConsent);
    const noConsentRow = await rowFor(noConsent.eventId);
    t.check(
      noConsentRow?.suppressReason?.includes("consent withdrawn") === true,
      "withdrawn consent is recorded distinctly from no number",
      noConsentRow?.suppressReason
    );
    await prisma.user.update({ where: { id: userId }, data: { smsConsentAt: new Date() } });

    t.section("7. A verified number does get the message");

    __clearStubMessages();
    const sent = event();
    const outcome = await handle(sent);
    t.check(outcome === "sent", "the delivery is reported sent", outcome);

    const sentRow = await rowFor(sent.eventId);
    t.check(sentRow?.status === DeliveryStatus.SENT, "the ledger settles SENT", sentRow?.status);
    t.check(
      !!sentRow?.providerMessageId,
      "with the provider's id recorded",
      sentRow?.providerMessageId
    );
    t.check(stubMessages().length === 1, "and exactly one message left", stubMessages().length);

    /**
     * The body says something happened and where to look — never the amount
     * and never the item. A text is read on a lock screen, possibly by someone
     * other than the recipient.
     */
    const body = stubMessages()[0]?.body ?? "";
    t.check(body.startsWith("RetailStore_2n:"), "the message names the sender", body);
    t.check(body.length <= 160, "and fits one segment", body.length);

    /** Redelivery is ordinary under Kafka, and must not be a second text. */
    __clearStubMessages();
    const again = await handle(sent);
    t.check(again === "duplicate", "a redelivery is refused by the ledger", again);
    t.check(stubMessages().length === 0, "so no second message is sent", stubMessages().length);

    t.section("8. The daily cap");

    /**
     * A circuit breaker, not a preference. A loop that re-emits one event, or
     * a seller cancelling forty lines of a basket, would otherwise be forty
     * texts and a bill the recipient cannot stop except by blocking us.
     */
    const before = process.env.SMS_DAILY_CAP;
    process.env.SMS_DAILY_CAP = "1";
    try {
      __clearStubMessages();
      const overCap = event();
      await handle(overCap);
      const capRow = await rowFor(overCap.eventId);
      t.check(
        capRow?.status === DeliveryStatus.SUPPRESSED,
        "past the cap the message is suppressed",
        capRow?.status
      );
      t.check(
        capRow?.suppressReason?.includes("daily SMS cap") === true,
        "with the cap named in the reason",
        capRow?.suppressReason
      );
      t.check(stubMessages().length === 0, "and nothing is sent", stubMessages().length);
    } finally {
      if (before === undefined) delete process.env.SMS_DAILY_CAP;
      else process.env.SMS_DAILY_CAP = before;
    }

    t.section("9. Quiet hours");

    const qBefore = process.env.SMS_QUIET_HOURS;
    const tzBefore = process.env.SMS_QUIET_HOURS_TZ;
    try {
      process.env.SMS_QUIET_HOURS_TZ = "UTC";

      /**
       * The window WRAPS midnight, and that is the bug worth a test: a naive
       * `now >= from && now < to` is false all night, which makes the feature
       * do nothing while looking configured.
       */
      process.env.SMS_QUIET_HOURS = "22:00-08:00";
      const at23 = quietHoursNow(new Date(Date.UTC(2026, 0, 1, 23, 0)));
      const at03 = quietHoursNow(new Date(Date.UTC(2026, 0, 1, 3, 0)));
      const at12 = quietHoursNow(new Date(Date.UTC(2026, 0, 1, 12, 0)));
      t.check(at23.inWindow, "23:00 is inside a window that wraps midnight");
      t.check(at03.inWindow, "and so is 03:00, on the other side of it");
      t.check(!at12.inWindow, "midday is not");

      /** A same-day window must still work. */
      process.env.SMS_QUIET_HOURS = "01:00-05:00";
      t.check(
        quietHoursNow(new Date(Date.UTC(2026, 0, 1, 3, 0))).inWindow,
        "a window inside one day works too"
      );
      t.check(
        !quietHoursNow(new Date(Date.UTC(2026, 0, 1, 23, 0))).inWindow,
        "and excludes what is outside it"
      );

      /**
       * A typo must not silently stop every message, and must not crash a
       * worker either.
       */
      process.env.SMS_QUIET_HOURS = "not-a-window";
      t.check(
        !quietHoursNow().inWindow,
        "a malformed window disables the feature rather than blocking everything"
      );

      process.env.SMS_QUIET_HOURS = "off";
      t.check(!quietHoursNow().inWindow, '"off" disables it');

      /**
       * opensAt is what a deferred row is parked until, so it has to be the
       * moment the window CLOSES — including when that is tomorrow.
       */
      process.env.SMS_QUIET_HOURS = "22:00-08:00";
      const opensFrom23 = quietHoursNow(new Date(Date.UTC(2026, 0, 1, 23, 0)));
      t.check(
        opensFrom23.opensAt?.toISOString() === new Date(Date.UTC(2026, 0, 2, 8, 0)).toISOString(),
        "at 23:00 the window opens at 08:00 TOMORROW",
        opensFrom23.opensAt?.toISOString()
      );
      const at0300 = quietHoursNow(new Date(Date.UTC(2026, 0, 2, 3, 0)));
      t.check(
        at0300.opensAt?.toISOString() === new Date(Date.UTC(2026, 0, 2, 8, 0)).toISOString(),
        "at 03:00 it opens at 08:00 the same day",
        at0300.opensAt?.toISOString()
      );
      t.check(
        quietHoursNow(new Date(Date.UTC(2026, 0, 1, 12, 0))).opensAt === null,
        "and outside the window there is nothing to wait for"
      );

      // And the consumer honours it end to end.
      process.env.SMS_QUIET_HOURS = "00:00-23:59";
      __clearStubMessages();
      const quiet = await eventWithNotification();
      const quietOutcome = await smsConsumer.handle(quiet);
      t.check(quietOutcome === "deferred", "inside the window the delivery defers", quietOutcome);

      const quietRow = await rowFor(quiet.eventId);
      t.check(
        quietRow?.status === DeliveryStatus.DEFERRED,
        "the row is DEFERRED, not SUPPRESSED — the message is still owed",
        quietRow?.status
      );
      t.check(!!quietRow?.notBefore, "with the moment it may be sent", quietRow?.notBefore);
      t.check(
        quietRow?.suppressReason?.includes("quiet hours") === true,
        "and the window named, so a support answer can quote it",
        quietRow?.suppressReason
      );
      t.check(stubMessages().length === 0, "and nothing is sent yet", stubMessages().length);

      t.section("9b. The sweeper sends what quiet hours parked");

      /**
       * NOT YET DUE. The sweeper must not send early — that is the whole point
       * of parking rather than dropping, and an off-by-one here texts somebody
       * at 3am, which is the exact outcome the feature exists to prevent.
       */
      __clearStubMessages();
      const early = await sweepDeferredOnce(new Date(Date.now() - 60_000));
      t.check(early.sent === 0, "a row that is not due yet is left alone", early);
      t.check(stubMessages().length === 0, "and nothing is sent", stubMessages().length);

      /**
       * Now due. Achieved by moving the row's notBefore into the past rather
       * than by moving `now` into the future — advancing now would also make
       * the row look a day OLD, and the age cap would correctly drop it. The
       * thing under test is the boundary, not the clock.
       *
       * The window is reopened first, or the send would simply re-defer.
       */
      process.env.SMS_QUIET_HOURS = "off";
      await prisma.notificationDelivery.update({
        where: { id: quietRow!.id },
        data: { notBefore: new Date(Date.now() - 60_000) },
      });

      __clearStubMessages();
      const swept = await sweepDeferredOnce();
      t.check(swept.sent === 1, "once due, the sweeper sends it", swept);
      t.check(stubMessages().length === 1, "exactly one message leaves", stubMessages().length);

      const sweptRow = await rowFor(quiet.eventId);
      t.check(sweptRow?.status === DeliveryStatus.SENT, "the row settles SENT", sweptRow?.status);
      /**
       * notBefore has to be cleared, or the sweeper's own index keeps handing
       * back a row it has already sent.
       */
      t.check(sweptRow?.notBefore === null, "and notBefore is cleared", sweptRow?.notBefore);

      /** A second pass must not send it again. */
      __clearStubMessages();
      const twice = await sweepDeferredOnce();
      t.check(twice.sent === 0, "a second pass finds nothing to do", twice);
      t.check(stubMessages().length === 0, "so no second message", stubMessages().length);

      t.section("9c. Two sweepers racing one parked message");

      /**
       * `SELECT then UPDATE` passes under no contention and sends twice under
       * load. The claim is a conditional write for the same reason the outbox
       * relay uses SKIP LOCKED.
       */
      process.env.SMS_QUIET_HOURS = "00:00-23:59";
      const raced = await eventWithNotification();
      await smsConsumer.handle(raced);
      process.env.SMS_QUIET_HOURS = "off";

      const racedRow = await rowFor(raced.eventId);
      await prisma.notificationDelivery.update({
        where: { id: racedRow!.id },
        data: { notBefore: new Date(Date.now() - 60_000) },
      });

      __clearStubMessages();
      const [a, b] = await Promise.all([sweepDeferredOnce(), sweepDeferredOnce()]);
      t.check(a.sent + b.sent === 1, "exactly one sweeper sends it", [a, b]);
      t.check(stubMessages().length === 1, "so the provider is called once", stubMessages().length);

      t.section("9d. A message parked too long is dropped, with a reason");

      process.env.SMS_QUIET_HOURS = "00:00-23:59";
      const stale = await eventWithNotification();
      await smsConsumer.handle(stale);
      process.env.SMS_QUIET_HOURS = "off";

      /**
       * A refund text two days late re-alarms somebody about something already
       * resolved, and arrives with no explanation of why it is late. The cap is
       * for the case where the sweeper was down, not the overnight wait.
       */
      const staleRowBefore = await rowFor(stale.eventId);
      await prisma.notificationDelivery.update({
        where: { id: staleRowBefore!.id },
        data: {
          notBefore: new Date(Date.now() - 60_000),
          // Backdated, so the AGE is what this asserts on rather than a clock
          // pushed far enough forward that everything looks old.
          createdAt: new Date(Date.now() - 6 * 3600_000),
        },
      });

      const ageBefore = process.env.SMS_DEFER_MAX_AGE_HOURS;
      process.env.SMS_DEFER_MAX_AGE_HOURS = "1";
      try {
        __clearStubMessages();
        const dropped = await sweepDeferredOnce();
        t.check(dropped.expired === 1, "it is dropped rather than sent late", dropped);
        t.check(stubMessages().length === 0, "nothing is sent", stubMessages().length);

        const staleRow = await rowFor(stale.eventId);
        t.check(
          staleRow?.status === DeliveryStatus.SUPPRESSED,
          "and the row settles SUPPRESSED",
          staleRow?.status
        );
        t.check(
          staleRow?.suppressReason?.includes("too long") === true,
          "with a reason, rather than vanishing into a cleanup",
          staleRow?.suppressReason
        );
      } finally {
        if (ageBefore === undefined) delete process.env.SMS_DEFER_MAX_AGE_HOURS;
        else process.env.SMS_DEFER_MAX_AGE_HOURS = ageBefore;
      }
    } finally {
      if (qBefore === undefined) delete process.env.SMS_QUIET_HOURS;
      else process.env.SMS_QUIET_HOURS = qBefore;
      if (tzBefore === undefined) delete process.env.SMS_QUIET_HOURS_TZ;
      else process.env.SMS_QUIET_HOURS_TZ = tzBefore;
    }

    t.section("10. Removing the number");

    await removePhone(userId);
    const cleared = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, phoneVerifiedAt: true, smsConsentAt: true },
    });
    /**
     * All three clear together. Leaving the number behind would hold the unique
     * index against its owner using it elsewhere, and would keep a number
     * nobody consented to hold.
     */
    t.check(cleared?.phone === null, "the number is gone", cleared?.phone);
    t.check(cleared?.phoneVerifiedAt === null, "verification is gone");
    t.check(cleared?.smsConsentAt === null, "and so is consent");
  },

  async () => {
    __clearStubMessages();
    for (const id of [userId, otherUserId].filter(Boolean)) {
      await prisma.notificationDelivery.deleteMany({ where: { userId: id } });
      await prisma.outboxEvent.deleteMany({ where: { userId: id } });
      await prisma.user.deleteMany({ where: { id } });
    }
  }
);

wireInterrupt();
cleanupOnInterrupt(async () => {
  for (const id of [userId, otherUserId].filter(Boolean)) {
    await prisma.notificationDelivery.deleteMany({ where: { userId: id } });
    await prisma.outboxEvent.deleteMany({ where: { userId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
});
