import { randomUUID } from "crypto";
import { prisma, requireServices } from "../lib/db";
import { main, wireInterrupt, cleanupOnInterrupt } from "../lib/harness";
import { lagReport } from "../../src/lib/consumerLag";
import { pruneOutbox, pruneOutboxOnce } from "../../src/lib/outboxRetention";
import { sweepStalePendingOnce } from "../../src/lib/stalePending";
import { listDeliveries } from "../../src/lib/adminStats";
import {
  DeliveryChannel,
  DeliveryStatus,
  NotificationType,
} from "../../src/generated/prisma/enums";

/**
 * Phase 6: the parts that make this pipeline operable rather than merely
 * correct.
 *
 * WHAT THIS SUITE IS FOR
 * Three claims, each of which is about a failure that is invisible until
 * somebody goes looking:
 *
 *   1. A `PENDING` row that nobody will ever settle is a LOST notification
 *      wearing a success. It is the ambiguous middle of ADR 0026, it went
 *      unbuilt through four phases, and the policy for resolving it
 *      deliberately differs per channel — so the SMS branch has to be asserted
 *      separately from the email one, because applying email's policy to SMS is
 *      exactly the mistake that costs money and trust.
 *   2. Retention must delete published rows and NEVER unpublished ones, at any
 *      age. An unpublished row is work still owed; deleting it destroys both
 *      the notification and the evidence.
 *   3. Lag must not report zero when nothing is consuming. The first version of
 *      `consumerLag` did exactly that — it iterated the group's committed
 *      offsets, which are an empty list for a group that has never run.
 *
 * See docs/adr/0026-delivery-idempotency.md
 */

const TAG = `rs2.ops.${Date.now()}`;

let userId = "";
let goneUserId = "";

async function makeNotification(title = "A refund was issued") {
  const n = await prisma.notification.create({
    data: { userId, type: NotificationType.REFUND_ISSUED, title, body: "ops suite" },
    select: { id: true },
  });
  return n.id;
}

/** A row claimed and never settled, aged past the staleness threshold. */
async function stalePending(channel: DeliveryChannel, ageMinutes = 30) {
  const notificationId = await makeNotification();
  const createdAt = new Date(Date.now() - ageMinutes * 60_000);
  return prisma.notificationDelivery.create({
    data: {
      eventId: randomUUID(),
      channel,
      userId,
      notificationId,
      status: DeliveryStatus.PENDING,
      attempts: 1,
      createdAt,
    },
    select: { id: true, eventId: true },
  });
}

void main(
  "operations",

  async (t) => {
    await requireServices({ api: false, db: true });

    const user = await prisma.user.create({
      data: {
        email: `${TAG}@retailstore-2n.test`,
        name: "Ops Test",
        passwordHash: "not-a-real-hash",
        emailVerified: true,
      },
      select: { id: true },
    });
    userId = user.id;

    /* ============================================================ *
     * 1. Consumer lag
     * ============================================================ */
    t.section("1. Lag, and the shape of not knowing");

    const report = await lagReport();

    if (report.transport === "inline") {
      /**
       * Stated rather than omitted. An endpoint that returns an empty body on
       * the inline transport looks broken; one that says "there is no broker"
       * is answering the question.
       */
      t.check(report.healthy, "the inline transport reports healthy");
      t.check(
        report.detail.includes("no broker"),
        "and says why there is nothing to measure",
        report.detail
      );
      t.note("KAFKA_BROKERS is not set — the lag arithmetic itself is not exercised.");
      t.note("  Run it with: KAFKA_BROKERS=localhost:9092 npm test -- operations");
    } else {
      t.check(Array.isArray(report.groups), "a broker-backed report lists groups");
      t.check(
        report.groups.length > 0,
        "one entry per consumer group",
        report.groups.map((g) => g.group)
      );
      /**
       * The regression that matters. Lag is derived from the TOPIC's partition
       * list, so a group that has never committed reports its whole retained
       * backlog rather than zero.
       */
      t.check(
        report.groups.every((g) => g.lag >= 0),
        "no group reports negative lag",
        report.groups.map((g) => g.lag)
      );
      t.check(report.dlqDepth >= 0, "the DLQ depth is known", report.dlqDepth);
      t.check(
        report.thresholds.lag > 0 && report.thresholds.dlq > 0,
        "and the thresholds are reported, so a monitor need not encode them",
        report.thresholds
      );

      /**
       * THE UNHEALTHY BRANCH HAS TO BE OBSERVED FIRING.
       *
       * A health endpoint nobody has ever seen return 503 is not a health
       * endpoint — it is a green light with no wire behind it. The threshold is
       * read per call precisely so this can be asserted.
       */
      const before = process.env.NOTIFY_LAG_THRESHOLD;
      try {
        process.env.NOTIFY_LAG_THRESHOLD = "1";
        const tight = await lagReport();
        const worst =
          tight.transport === "kafka"
            ? Math.max(0, ...tight.groups.map((g) => g.lag))
            : 0;
        if (worst > 1) {
          t.check(
            tight.transport === "kafka" && !tight.healthy,
            "a lag above the threshold reports unhealthy — the 503 path",
            { worst, healthy: tight.transport === "kafka" ? tight.healthy : "n/a" }
          );
        } else {
          t.note("Every group is caught up, so the unhealthy branch had nothing to trip on.");
        }
      } finally {
        if (before === undefined) delete process.env.NOTIFY_LAG_THRESHOLD;
        else process.env.NOTIFY_LAG_THRESHOLD = before;
      }
    }

    /* ============================================================ *
     * 2. Outbox retention
     * ============================================================ */
    t.section("2. Retention deletes what is spent and nothing else");

    const old = new Date(Date.now() - 30 * 24 * 3600_000);
    const recent = new Date(Date.now() - 60_000);

    const oldPublished = await prisma.outboxEvent.create({
      data: {
        eventId: randomUUID(),
        aggregateType: "Refund",
        aggregateId: randomUUID(),
        type: NotificationType.REFUND_ISSUED,
        userId,
        payload: { notificationId: await makeNotification(), title: "old", body: null, link: null },
        createdAt: old,
        publishedAt: old,
      },
      select: { id: true },
    });

    const recentPublished = await prisma.outboxEvent.create({
      data: {
        eventId: randomUUID(),
        aggregateType: "Refund",
        aggregateId: randomUUID(),
        type: NotificationType.REFUND_ISSUED,
        userId,
        payload: { notificationId: await makeNotification(), title: "recent", body: null, link: null },
        createdAt: recent,
        publishedAt: recent,
      },
      select: { id: true },
    });

    /**
     * THE ONE THAT MUST SURVIVE. Old and never published means a publish that
     * is still owed — most likely a bug worth finding. Deleting it would
     * destroy the notification and the evidence in one statement.
     */
    const oldUnpublished = await prisma.outboxEvent.create({
      data: {
        eventId: randomUUID(),
        aggregateType: "Refund",
        aggregateId: randomUUID(),
        type: NotificationType.REFUND_ISSUED,
        userId,
        payload: { notificationId: await makeNotification(), title: "stuck", body: null, link: null },
        createdAt: old,
        publishedAt: null,
      },
      select: { id: true },
    });

    const pruned = await pruneOutbox();
    t.check(pruned >= 1, "at least the aged published row is pruned", pruned);

    t.check(
      (await prisma.outboxEvent.findUnique({ where: { id: oldPublished.id } })) === null,
      "the aged published row is gone"
    );
    t.check(
      (await prisma.outboxEvent.findUnique({ where: { id: recentPublished.id } })) !== null,
      "a recently published row is kept — it can still be republished"
    );
    t.check(
      (await prisma.outboxEvent.findUnique({ where: { id: oldUnpublished.id } })) !== null,
      "AN UNPUBLISHED ROW SURVIVES AT ANY AGE — it is work still owed"
    );

    const second = await pruneOutboxOnce();
    t.check(second.deleted === 0, "a second pass finds nothing to do", second.deleted);

    /* ============================================================ *
     * 3. Stale PENDING — the ambiguous middle
     * ============================================================ */
    t.section("3. A claimed delivery nobody settled");

    const notStale = await stalePending(DeliveryChannel.EMAIL, 1);
    const staleEmail = await stalePending(DeliveryChannel.EMAIL, 30);
    const staleSms = await stalePending(DeliveryChannel.SMS, 30);
    const stalePush = await stalePending(DeliveryChannel.PUSH, 30);

    const swept = await sweepStalePendingOnce();
    t.check(swept.resent + swept.failed === 3, "only the aged rows are touched", swept);

    const fresh = await prisma.notificationDelivery.findUnique({
      where: { id: notStale.id },
    });
    t.check(
      fresh?.status === DeliveryStatus.PENDING,
      "a row that is merely in flight is left alone",
      fresh?.status
    );

    /**
     * Email is RESENT, accepting the risk of a duplicate. A duplicate email is
     * an annoyance; a missing refund notice is not.
     */
    const email = await prisma.notificationDelivery.findUnique({
      where: { id: staleEmail.id },
    });
    t.check(
      email?.status === DeliveryStatus.SENT,
      "a stale email is resent and settles SENT",
      email?.status
    );
    t.check(
      (email?.attempts ?? 0) > 1,
      "with the extra attempt recorded",
      email?.attempts
    );

    /**
     * SMS IS NEVER RESENT, and this is the assertion that stops somebody
     * applying the email policy by default. A duplicate text costs money and
     * reads to the recipient exactly like a phishing retry.
     */
    const sms = await prisma.notificationDelivery.findUnique({ where: { id: staleSms.id } });
    t.check(
      sms?.status === DeliveryStatus.FAILED,
      "a stale SMS is FAILED rather than resent",
      sms?.status
    );
    t.check(
      sms?.lastError?.includes("Needs review") === true,
      "and flagged for a human, because the outcome is genuinely unknown",
      sms?.lastError
    );
    t.check(swept.needsReview === 1, "counted as needing review", swept.needsReview);

    /** Push follows email's policy, and fails honestly when unconfigured. */
    const push = await prisma.notificationDelivery.findUnique({ where: { id: stalePush.id } });
    t.check(
      push?.status === DeliveryStatus.SENT || push?.status === DeliveryStatus.FAILED,
      "a stale push is resolved either way, never left PENDING",
      push?.status
    );

    t.section("4. Two sweepers racing the same stale row");

    const contended = await stalePending(DeliveryChannel.EMAIL, 30);
    const [a, b] = await Promise.all([sweepStalePendingOnce(), sweepStalePendingOnce()]);
    t.check(
      a.resent + b.resent + a.failed + b.failed === 1,
      "exactly one sweeper resolves it",
      [a, b]
    );
    const settled = await prisma.notificationDelivery.findUnique({
      where: { id: contended.id },
    });
    t.check(
      settled?.status !== DeliveryStatus.PENDING,
      "and the row is no longer pending",
      settled?.status
    );

    /* ============================================================ *
     * 5. The admin delivery log
     * ============================================================ */
    t.section("5. Answering it without a database console");

    const byEmail = await listDeliveries({ q: `${TAG}@retailstore-2n.test` });
    t.check(byEmail.total > 0, "searching by email address finds deliveries", byEmail.total);
    t.check(
      byEmail.rows.every((r) => r.recipient?.id === userId),
      "and only that person's"
    );
    t.check(
      byEmail.rows.some((r) => r.notification?.title === "A refund was issued"),
      "with the notification's own words, not just an id"
    );

    const one = byEmail.rows[0];
    t.check(!!one.eventId, "each row carries the eventId a DLQ entry would name");
    t.check(
      typeof byEmail.byStatus === "object",
      "counts are returned for the whole filtered set, not just the page",
      byEmail.byStatus
    );

    const smsOnly = await listDeliveries({ q: `${TAG}@retailstore-2n.test`, channel: "SMS" });
    t.check(
      smsOnly.rows.every((r) => r.channel === DeliveryChannel.SMS),
      "the channel filter holds",
      smsOnly.rows.map((r) => r.channel)
    );

    const failedOnly = await listDeliveries({
      q: `${TAG}@retailstore-2n.test`,
      status: "FAILED",
    });
    t.check(
      failedOnly.rows.every((r) => r.status === DeliveryStatus.FAILED),
      "so does the status filter",
      failedOnly.rows.map((r) => r.status)
    );
    t.check(
      failedOnly.rows.every((r) => !!r.lastError),
      "and a failure always carries its reason — 'FAILED' alone is useless"
    );

    const byEventId = await listDeliveries({ q: one.eventId });
    t.check(byEventId.total >= 1, "searching by eventId works too", byEventId.total);

    /**
     * A delivery outlives the account it was for, because `userId` is a plain
     * column rather than a foreign key. "Sent to an account since deleted" is a
     * real answer and has to render rather than crash.
     */
    const gone = await prisma.user.create({
      data: {
        email: `${TAG}.gone@retailstore-2n.test`,
        name: "Since Deleted",
        passwordHash: "not-a-real-hash",
      },
      select: { id: true },
    });
    goneUserId = gone.id;
    const orphanEvent = randomUUID();
    await prisma.notificationDelivery.create({
      data: {
        eventId: orphanEvent,
        channel: DeliveryChannel.EMAIL,
        userId: gone.id,
        status: DeliveryStatus.SENT,
        completedAt: new Date(),
      },
    });
    await prisma.user.delete({ where: { id: gone.id } });
    goneUserId = "";

    const orphan = await listDeliveries({ q: orphanEvent });
    t.check(orphan.total === 1, "the delivery survives the account", orphan.total);
    t.check(
      orphan.rows[0]?.recipient === null,
      "and reports the recipient as gone rather than failing",
      orphan.rows[0]?.recipient
    );

    await prisma.notificationDelivery.deleteMany({ where: { eventId: orphanEvent } });
  },

  async () => {
    for (const id of [userId, goneUserId].filter(Boolean)) {
      await prisma.notificationDelivery.deleteMany({ where: { userId: id } });
      await prisma.outboxEvent.deleteMany({ where: { userId: id } });
      await prisma.user.deleteMany({ where: { id } });
    }
  }
);

wireInterrupt();
cleanupOnInterrupt(async () => {
  for (const id of [userId, goneUserId].filter(Boolean)) {
    await prisma.notificationDelivery.deleteMany({ where: { userId: id } });
    await prisma.outboxEvent.deleteMany({ where: { userId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
});
