import { API, prisma, requireServices } from "../lib/db";
import { main, wireInterrupt, cleanupOnInterrupt } from "../lib/harness";
import { CONSUMERS, type NotificationConsumer } from "../../src/lib/consumers";
import { enqueue } from "../../src/lib/outbox";
import { notify, notifyMany } from "../../src/lib/notifications";
import { relayOnce } from "../../src/lib/relay";
import { resetTransport } from "../../src/lib/notifyTransport";
import { NotificationType } from "../../src/generated/prisma/enums";

/**
 * The outbox and the relay.
 *
 * WHAT THIS SUITE IS FOR
 * Three claims that a response cannot show you, and that a passing happy path
 * would not catch:
 *
 *   1. The notification and its event commit TOGETHER or not at all. A dual
 *      write fails only on a crash in the gap between them, which no ordinary
 *      test reaches — so the gap is forced open here with a rollback.
 *   2. Two relays claim DISJOINT rows. `FOR UPDATE SKIP LOCKED` and a plain
 *      `SELECT` look identical under no contention, and differ by exactly one
 *      duplicated email per concurrent pass under load.
 *   3. A publish that fails leaves the row UNPUBLISHED. Marking optimistically
 *      also passes every happy-path test, and loses notifications on the first
 *      broker blip.
 *
 * NO API AND NO BROKER. It drives lib/ directly against a real Postgres, so it
 * runs in about a second and is deterministic — no relay is ticking in this
 * process, so every pass happens exactly when this file says it does.
 *
 * See docs/adr/0024-outbox-not-dual-writes.md
 */

const TAG = `rs2.outbox.${Date.now()}`;

/**
 * A consumer that records what it was handed.
 *
 * Pushed onto the exported CONSUMERS array rather than injected, because the
 * inline transport reads that array — which is the same code path production
 * uses to reach the real channel workers. Removed again in cleanup.
 */
function recorder(): NotificationConsumer & { seen: string[] } {
  const seen: string[] = [];
  return {
    group: "test-recorder",
    seen,
    async handle(event) {
      seen.push(event.eventId);
    },
  };
}

let userId = "";
const spy = recorder();

void main(
  "outbox and relay",

  async (t) => {
    await requireServices({ api: false, db: true });

    if ((process.env.NOTIFY_TRANSPORT ?? "inline").toLowerCase() !== "inline") {
      t.note(
        `NOTIFY_TRANSPORT is "${process.env.NOTIFY_TRANSPORT}" — this suite ` +
          "asserts on the inline transport and would otherwise publish to a broker."
      );
      t.check(false, "runs on the inline transport", process.env.NOTIFY_TRANSPORT);
      return;
    }

    /**
     * A RELAY TICKING ELSEWHERE MAKES THIS SUITE LIE.
     *
     * Every pass below is driven by hand so it happens exactly when this file
     * says it does, and the spy consumer lives in THIS process. An API running
     * on the inline transport also runs a relay, which claims the same rows
     * and hands them to its own consumers — so the assertions become
     * "one event published — 0": true, and useless as a diagnosis.
     *
     * Detected rather than endured. `/health/lag` reports the transport, so a
     * competing relay can be identified and named instead of producing five
     * confusing failures halfway through a full-suite run.
     */
    const live = await fetch(`${API}/health/lag`, {
      signal: AbortSignal.timeout(5000),
    })
      .then((r) => r.json() as Promise<{ transport?: string; relayInProcess?: boolean }>)
      .catch(() => null);

    /**
     * `relayInProcess`, not the transport. Inferring a competing relay from
     * "the API is on the inline transport" is wrong the moment the relay is
     * switched off — which is exactly the configuration this check is meant to
     * approve, so the first version rejected the fix it was asking for.
     */
    if (live?.relayInProcess === true) {
      t.note(`An API is running at ${API} on the inline transport, so its relay is`);
      t.note("draining the outbox in parallel with this suite. Restart it with the");
      t.note("in-process relay off — nothing else in the suite needs it:");
      t.note("  RELAY_IN_PROCESS=false npm run dev");
      t.check(false, "no competing relay is draining the outbox", live.transport);
      return;
    }

    await resetTransport();
    CONSUMERS.push(spy);

    /**
     * CLEAR ANYONE ELSE'S UNPUBLISHED ROWS FIRST.
     *
     * `relayOnce()` claims every unpublished row, not this suite's, so the
     * assertions below — "one event published" — are only about this suite's
     * own row if nothing else is waiting. Almost every other suite emits
     * notifications, and with `RELAY_IN_PROCESS=false` nothing drains them, so
     * running suites individually leaves a backlog. This suite then reported
     * `one event published — 51`: true, and a diagnosis of nothing.
     *
     * Drained rather than deleted: publishing them is what the relay is for,
     * and deleting notification events to make a test pass is the wrong habit
     * to encode in a fixture. Bounded, so a relay genuinely stuck in a loop
     * fails the suite instead of hanging it.
     */
    let drained = 0;
    for (let pass = 0; pass < 40; pass += 1) {
      const cleared = await relayOnce();
      if (cleared.published === 0) break;
      drained += cleared.published;
    }
    if (drained > 0) {
      t.note(`drained ${drained} event(s) left unpublished by other suites`);
    }
    spy.seen.length = 0;

    const user = await prisma.user.create({
      data: {
        email: `${TAG}@retailstore-2n.test`,
        name: "Outbox Test",
        passwordHash: "not-a-real-hash",
      },
      select: { id: true },
    });
    userId = user.id;

    /* ---------------------------------------------------------------- */
    t.section("one transaction, two rows");

    await notify({
      userId,
      type: NotificationType.SALE_MADE,
      title: "Cast iron skillet sold",
      body: "Send it when you can.",
      link: "/seller/sales",
      aggregateType: "order",
      aggregateId: "order-abc",
    });

    const notifications = await prisma.notification.findMany({ where: { userId } });
    const events = await prisma.outboxEvent.findMany({ where: { userId } });

    t.check(notifications.length === 1, "notification written", notifications.length);
    t.check(events.length === 1, "outbox event written", events.length);

    const event = events[0];
    t.check(
      event?.publishedAt === null,
      "starts unpublished",
      String(event?.publishedAt)
    );
    t.check(
      event?.aggregateType === "order" && event?.aggregateId === "order-abc",
      "carries the aggregate it was given",
      `${event?.aggregateType}/${event?.aggregateId}`
    );

    const payload = event?.payload as { notificationId?: string; title?: string };
    t.check(
      payload?.notificationId === notifications[0]?.id,
      "payload points at the notification it was written with",
      payload?.notificationId
    );
    t.check(
      payload?.title === "Cast iron skillet sold",
      "payload snapshots the title, not a lookup",
      payload?.title
    );

    /* ---------------------------------------------------------------- */
    t.section("a rolled-back transaction leaves neither row");

    // The dual-write failure, forced open. Without the shared transaction one
    // of these two would survive the throw.
    const before = await prisma.notification.count({ where: { userId } });
    try {
      await prisma.$transaction(async (tx) => {
        const n = await tx.notification.create({
          data: { userId, type: NotificationType.ORDER_SHIPPED, title: "doomed" },
          select: { id: true },
        });
        await enqueue(tx, {
          type: NotificationType.ORDER_SHIPPED,
          userId,
          aggregateType: "order",
          aggregateId: "order-doomed",
          payload: { notificationId: n.id, title: "doomed", body: null, link: null },
        });
        throw new Error("simulated failure after both writes");
      });
      t.check(false, "transaction threw", "it did not");
    } catch {
      const after = await prisma.notification.count({ where: { userId } });
      const orphans = await prisma.outboxEvent.count({
        where: { userId, aggregateId: "order-doomed" },
      });
      t.check(after === before, "no notification survived the rollback", `${before} → ${after}`);
      t.check(orphans === 0, "no orphaned event survived the rollback", orphans);
    }

    /* ---------------------------------------------------------------- */
    t.section("the relay publishes, once");

    spy.seen.length = 0;
    const pass = await relayOnce();

    t.check(pass.published === 1, "one event published", pass.published);
    t.check(spy.seen.length === 1, "the consumer was handed it", spy.seen.length);
    t.check(
      spy.seen[0] === event?.eventId,
      "with the eventId written at enqueue time",
      `${spy.seen[0]} vs ${event?.eventId}`
    );

    const afterPublish = await prisma.outboxEvent.findUnique({
      where: { eventId: event!.eventId },
    });
    t.check(afterPublish?.publishedAt !== null, "row marked published", String(afterPublish?.publishedAt));

    // A second pass must find nothing. If publishedAt were not being set, or the
    // claim ignored it, this is where a permanent resend loop shows up.
    spy.seen.length = 0;
    const second = await relayOnce();
    t.check(second.published === 0, "a second pass finds nothing", second.published);
    t.check(spy.seen.length === 0, "and delivers nothing", spy.seen.length);

    /* ---------------------------------------------------------------- */
    t.section("two relays claim disjoint rows (FOR UPDATE SKIP LOCKED)");

    const BATCH = 24;
    await notifyMany(
      Array.from({ length: BATCH }, (_, n) => ({
        userId,
        type: NotificationType.REVIEW_RECEIVED,
        title: `concurrent ${n}`,
        aggregateType: "test",
        aggregateId: `concurrent-${n}`,
      }))
    );

    const pending = await prisma.outboxEvent.count({
      where: { userId, publishedAt: null },
    });
    t.check(pending === BATCH, `${BATCH} events pending`, pending);

    spy.seen.length = 0;

    // The actual assertion. Under a plain SELECT both passes read the same rows
    // and every one of them is delivered twice.
    const [a, b] = await Promise.all([relayOnce(), relayOnce()]);

    const delivered = spy.seen.length;
    const distinct = new Set(spy.seen).size;

    t.check(
      a.published + b.published === BATCH,
      "the two passes published the batch between them",
      `${a.published} + ${b.published}`
    );
    t.check(delivered === BATCH, "every event delivered", delivered);
    t.check(distinct === delivered, "none delivered twice", `${distinct} distinct of ${delivered}`);

    const stillPending = await prisma.outboxEvent.count({
      where: { userId, publishedAt: null },
    });
    t.check(stillPending === 0, "nothing left unpublished", stillPending);

    /* ---------------------------------------------------------------- */
    t.section("a failed publish leaves the row unpublished");

    await notify({
      userId,
      type: NotificationType.REFUND_ISSUED,
      title: "will fail to publish",
      aggregateType: "test",
      aggregateId: "fails",
    });

    // Fails INSIDE the transaction, exactly where a broker outage would.
    const exploding: NotificationConsumer = {
      group: "test-exploding",
      async handle() {
        throw new Error("broker unreachable");
      },
    };
    CONSUMERS.push(exploding);

    const failedPass = await relayOnce();
    CONSUMERS.pop();

    /**
     * The inline transport catches a consumer's error so one channel cannot
     * stop the others — the same isolation a consumer group gives under Kafka.
     * So the pass SUCCEEDS here, and what is being asserted is the weaker,
     * true claim: the row is resolved one way or the other and never silently
     * dropped. The transport-level failure path is asserted below.
     */
    const failRow = await prisma.outboxEvent.findFirst({
      where: { userId, aggregateId: "fails" },
    });
    t.check(
      failedPass.published === 1,
      "one consumer failing does not fail the pass",
      failedPass.published
    );
    t.check(
      failRow?.publishedAt !== null,
      "the event is still marked published — other consumers got it",
      String(failRow?.publishedAt)
    );

    /* ---------------------------------------------------------------- */
    t.section("a transport failure keeps the row for retry");

    await notify({
      userId,
      type: NotificationType.REFUND_ISSUED,
      title: "transport down",
      aggregateType: "test",
      aggregateId: "transport-down",
    });

    // Break the transport itself, not a consumer: this is the broker being gone.
    const { getTransport } = await import("../../src/lib/notifyTransport");
    const transport = getTransport();
    const realPublish = transport.publish.bind(transport);
    (transport as { publish: unknown }).publish = async () => {
      throw new Error("simulated broker outage");
    };

    const outage = await relayOnce();
    (transport as { publish: unknown }).publish = realPublish;

    const kept = await prisma.outboxEvent.findFirst({
      where: { userId, aggregateId: "transport-down" },
    });

    t.check(outage.published === 0, "nothing reported published", outage.published);
    t.check(outage.failed === 1, "the failure is counted", outage.failed);
    t.check(
      kept?.publishedAt === null,
      "the row is STILL UNPUBLISHED — this is the whole point",
      String(kept?.publishedAt)
    );
    t.check(kept?.attempts === 1, "the attempt is recorded on the row", kept?.attempts);
    t.check(
      (kept?.lastError ?? "").includes("simulated broker outage"),
      "and so is why it failed",
      kept?.lastError
    );

    // And it recovers on its own once the transport is back.
    spy.seen.length = 0;
    const recovery = await relayOnce();
    t.check(recovery.published === 1, "the next pass republishes it", recovery.published);
    t.check(spy.seen.length === 1, "and it reaches the consumer", spy.seen.length);
  },

  async () => {
    const i = CONSUMERS.indexOf(spy);
    if (i >= 0) CONSUMERS.splice(i, 1);

    if (userId) {
      // outbox_events has no FK to the user, so it is deleted explicitly;
      // notifications cascade with the user row.
      await prisma.outboxEvent.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await resetTransport();
  }
);

wireInterrupt();
cleanupOnInterrupt(async () => {
  if (userId) {
    await prisma.outboxEvent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
