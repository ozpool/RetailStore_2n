import { randomUUID } from "crypto";
import { prisma, requireServices } from "../lib/db";
import { main, wireInterrupt, cleanupOnInterrupt } from "../lib/harness";
import { PermanentFailure, deliver } from "../../src/lib/deliveryLedger";
import { RETRY_LADDER, TOPICS } from "../../src/lib/kafka";
import {
  ATTEMPT_HEADER,
  GROUP_HEADER,
  attemptOf,
  delayFor,
  groupOf,
  isRetryTopic,
  retryDestination,
} from "../../src/lib/retry";
import type { NotificationEvent } from "../../src/lib/outbox";
import {
  DeliveryChannel,
  DeliveryStatus,
  NotificationType,
} from "../../src/generated/prisma/enums";

/**
 * The retry ladder.
 *
 * WHAT THIS SUITE IS FOR
 * The ladder's whole job is to tell two failures apart and treat them
 * differently. Every claim below is one a happy path cannot reach:
 *
 *   1. A transient failure is RETRYABLE and a permanent one is not. Collapsing
 *      them passes every ordinary test and shows up as a bounced address being
 *      retried four times, which is how a sending domain gets blocked.
 *   2. A retry can RECLAIM its own failed ledger row. The unique constraint
 *      that makes redelivery safe (ADR 0026) also makes a retry look exactly
 *      like a duplicate — so without a deliberate reclaim the ladder is an
 *      elaborate no-op that silently delivers nothing.
 *   3. Reclaim is NARROW. Only a FAILED row, only when the retry path asks for
 *      it, and only one winner when two workers race. A reclaim that took over
 *      a PENDING row would send somebody's notification twice.
 *
 * NO BROKER FOR SECTIONS 1-3. The routing table is pure, and the reclaim
 * discipline is Postgres — both run against the real stack in about a second.
 * What genuinely needs a broker is in section 4, gated on KAFKA_BROKERS the
 * way the Redis sections of `cache` and `ratelimit` are gated on REDIS_URL,
 * and it SKIPS LOUDLY rather than passing quietly.
 *
 * See docs/adr/0025-kafka-topics-and-partitioning.md
 */

const TAG = `rs2.retry.${Date.now()}`;

let userId = "";

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    eventId: randomUUID(),
    type: NotificationType.ORDER_SHIPPED,
    userId,
    aggregateType: "Order",
    aggregateId: randomUUID(),
    payload: {
      notificationId: randomUUID(),
      title: "Your order shipped",
      body: null,
      link: null,
    },
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A send that always fails, the way a provider having a bad minute does. */
const transientFail = async (): Promise<{ providerMessageId?: string | null }> => {
  throw new Error("connect ETIMEDOUT smtp.example.test:587");
};

/** A send that fails the way a rejected address does. */
const permanentFail = async (): Promise<{ providerMessageId?: string | null }> => {
  throw new PermanentFailure("550 5.1.1 recipient rejected");
};

const succeed = async () => ({ providerMessageId: "provider-1" });

async function rowFor(eventId: string, channel: DeliveryChannel) {
  return prisma.notificationDelivery.findUnique({
    where: { eventId_channel: { eventId, channel } },
  });
}

void main(
  "retry ladder",

  async (t) => {
    await requireServices({ api: false, db: true });

    /* ============================================================ *
     * 1. Routing. Pure functions, no broker, no database.
     * ============================================================ */
    t.section("1. Where a failed message goes next");

    const first = retryDestination(0);
    t.check(
      first.kind === "retry" && first.topic === TOPICS.retry5s,
      "a first failure goes to the 5s rung",
      first
    );
    t.check(
      first.kind === "retry" && first.delayMs === 5_000,
      "and carries that rung's delay",
      first
    );
    t.check(
      first.attempt === 1,
      "with the attempt count incremented for the next hop",
      first.attempt
    );

    const second = retryDestination(1);
    t.check(
      second.kind === "retry" && second.topic === TOPICS.retry1m,
      "the second goes to the 1m rung",
      second
    );

    const third = retryDestination(2);
    t.check(
      third.kind === "retry" && third.topic === TOPICS.retry15m,
      "the third goes to the 15m rung",
      third
    );

    /**
     * The end of the ladder is the DLQ, not a drop. A message nobody could
     * deliver in three attempts is something a person has to see.
     */
    const exhausted = retryDestination(RETRY_LADDER.length);
    t.check(
      exhausted.kind === "dlq" && exhausted.topic === TOPICS.dlq,
      "falling off the end lands in the DLQ",
      exhausted
    );
    t.check(
      retryDestination(99).kind === "dlq",
      "and so does an attempt count past the end",
      retryDestination(99)
    );

    t.section("2. Reading the headers a retry carries");

    t.check(attemptOf(undefined) === 0, "no headers means no attempts yet");
    t.check(attemptOf({}) === 0, "nor does an empty header set");
    t.check(
      attemptOf({ [ATTEMPT_HEADER]: Buffer.from("2") }) === 2,
      "a Buffer header parses"
    );
    t.check(
      attemptOf({ [ATTEMPT_HEADER]: "3" }) === 3,
      "and so does a string header"
    );
    /**
     * A header that cannot be counted reads as zero rather than throwing. The
     * ledger stops a double send either way, so the conservative reading costs
     * nothing and an exception here would stall a partition.
     */
    t.check(
      attemptOf({ [ATTEMPT_HEADER]: "banana" }) === 0,
      "garbage reads as zero rather than throwing"
    );
    t.check(
      attemptOf({ [ATTEMPT_HEADER]: ["4", "9"] }) === 4,
      "a repeated header takes the first value"
    );

    t.check(
      groupOf({ [GROUP_HEADER]: "email-worker" }) === "email-worker",
      "the target group is readable"
    );
    t.check(groupOf({}) === undefined, "and absent when unset");

    t.check(isRetryTopic(TOPICS.retry5s), "a rung is a retry topic");
    t.check(!isRetryTopic(TOPICS.main), "the main topic is not");
    t.check(!isRetryTopic(TOPICS.dlq), "and neither is the DLQ");
    t.check(delayFor(TOPICS.retry15m) === 900_000, "each rung knows its delay");
    t.check(delayFor(TOPICS.main) === 0, "the main topic has none");

    /* ============================================================ *
     * 3. The ledger, and what may be reclaimed.
     * ============================================================ */
    const user = await prisma.user.create({
      data: {
        email: `${TAG}@retailstore-2n.test`,
        name: "Retry Test",
        passwordHash: "not-a-real-hash",
        emailVerified: true,
      },
      select: { id: true },
    });
    userId = user.id;

    t.section("3. Transient and permanent are different outcomes");

    const transient = event();
    const t1 = await deliver(transient, DeliveryChannel.EMAIL, transientFail);
    t.check(t1 === "retry", "a transient failure asks for a retry", t1);

    const tRow = await rowFor(transient.eventId, DeliveryChannel.EMAIL);
    t.check(tRow?.status === DeliveryStatus.FAILED, "and is FAILED on the ledger", tRow?.status);
    t.check(tRow?.attempts === 1, "at one attempt", tRow?.attempts);
    t.check(
      !!tRow?.lastError && !tRow.lastError.startsWith("permanent:"),
      "recorded without the permanent marker",
      tRow?.lastError
    );

    const permanent = event();
    const p1 = await deliver(permanent, DeliveryChannel.EMAIL, permanentFail);
    t.check(p1 === "failed", "a permanent failure does not", p1);

    const pRow = await rowFor(permanent.eventId, DeliveryChannel.EMAIL);
    t.check(
      pRow?.lastError?.startsWith("permanent:") === true,
      "and says so on the row, for whoever reads the admin panel",
      pRow?.lastError
    );

    t.section("4. Reclaim is what makes the ladder work at all");

    /**
     * THE CASE THE WHOLE DESIGN TURNS ON. Without `reclaim`, this second
     * attempt collides with the row the first one left behind and is read as
     * an ordinary redelivery — so the ladder would run its three rungs and
     * deliver nothing, silently.
     */
    const withoutReclaim = await deliver(transient, DeliveryChannel.EMAIL, succeed);
    t.check(
      withoutReclaim === "duplicate",
      "without reclaim a retry looks exactly like a duplicate",
      withoutReclaim
    );
    const stillFailed = await rowFor(transient.eventId, DeliveryChannel.EMAIL);
    t.check(
      stillFailed?.status === DeliveryStatus.FAILED,
      "and the row is untouched",
      stillFailed?.status
    );

    const withReclaim = await deliver(transient, DeliveryChannel.EMAIL, succeed, {
      reclaim: true,
    });
    t.check(withReclaim === "sent", "with reclaim the retry actually sends", withReclaim);

    const sentRow = await rowFor(transient.eventId, DeliveryChannel.EMAIL);
    t.check(sentRow?.status === DeliveryStatus.SENT, "the row settles SENT", sentRow?.status);
    t.check(sentRow?.attempts === 2, "and counts the second attempt", sentRow?.attempts);
    t.check(
      sentRow?.lastError === null,
      "with the stale error cleared, so the row is not read as still-failing",
      sentRow?.lastError
    );

    t.section("5. Reclaim refuses everything it should");

    /**
     * A SENT row is finished. Reclaiming one would resend a notification that
     * already arrived — the exact duplicate the ledger exists to prevent.
     */
    const afterSent = await deliver(transient, DeliveryChannel.EMAIL, succeed, {
      reclaim: true,
    });
    t.check(afterSent === "duplicate", "a SENT row is never reclaimed", afterSent);

    /**
     * A PENDING row is somebody's live attempt. Taking it over is how one
     * event becomes two messages.
     */
    const pending = event();
    await prisma.notificationDelivery.create({
      data: {
        eventId: pending.eventId,
        channel: DeliveryChannel.EMAIL,
        userId,
        notificationId: pending.payload.notificationId,
        status: DeliveryStatus.PENDING,
        attempts: 1,
      },
    });
    const onPending = await deliver(pending, DeliveryChannel.EMAIL, succeed, {
      reclaim: true,
    });
    t.check(onPending === "duplicate", "a PENDING row is left to its owner", onPending);

    /**
     * A SUPPRESSED row was a decision, not a fault. There is nothing to retry.
     */
    const suppressed = event();
    await prisma.notificationDelivery.create({
      data: {
        eventId: suppressed.eventId,
        channel: DeliveryChannel.EMAIL,
        userId,
        notificationId: suppressed.payload.notificationId,
        status: DeliveryStatus.SUPPRESSED,
        suppressReason: "the recipient turned this off",
        completedAt: new Date(),
      },
    });
    const onSuppressed = await deliver(suppressed, DeliveryChannel.EMAIL, succeed, {
      reclaim: true,
    });
    t.check(
      onSuppressed === "duplicate",
      "a SUPPRESSED row is not a failure to retry",
      onSuppressed
    );

    t.section("6. Two workers racing one retry");

    /**
     * `SELECT then UPDATE` passes this under no contention and sends twice
     * under load, which is the whole reason the claim is a conditional write.
     */
    const raced = event();
    await deliver(raced, DeliveryChannel.EMAIL, transientFail);

    let sends = 0;
    const contend = () =>
      deliver(
        raced,
        DeliveryChannel.EMAIL,
        async () => {
          sends += 1;
          return { providerMessageId: "raced" };
        },
        { reclaim: true }
      );

    const [a, b] = await Promise.all([contend(), contend()]);
    const outcomes = [a, b].sort();
    t.check(
      outcomes[0] === "duplicate" && outcomes[1] === "sent",
      "exactly one wins the reclaim",
      outcomes
    );
    t.check(sends === 1, "so the provider is called exactly once", sends);

    const racedRow = await rowFor(raced.eventId, DeliveryChannel.EMAIL);
    t.check(
      racedRow?.attempts === 2,
      "and only the winner's attempt is counted",
      racedRow?.attempts
    );

    /* ============================================================ *
     * 7. What only a broker can show.
     * ============================================================ */
    t.section("7. End to end through a real broker");

    if (!process.env.KAFKA_BROKERS?.trim()) {
      /**
       * SKIPPED LOUDLY. A section that quietly passes when its dependency is
       * missing is worse than no section — it reports green for something
       * nobody ran. Same convention as the Redis sections of `cache`.
       */
      t.note("KAFKA_BROKERS is not set — the broker section is skipped.");
      t.note("  Run it with: docker compose --profile messaging up -d");
      t.note("  then: KAFKA_BROKERS=localhost:9092 npm test -- retry-ladder");
      t.note("Still unproven without it:");
      t.note("  - a failed message is republished onto the rung, with its history");
      t.note("  - a message that exhausts the ladder arrives in the DLQ");
      t.note("  - a rung's message is skipped by the groups it is not tagged for");
      t.note("  - a rung's message is not processed before its delay elapses");
      t.note("  - an offset is committed only after the ledger row is settled");
      return;
    }

    const { ensureTopics, kafka } = await import("../../src/lib/kafka");
    const { republish, closeRetryProducer } = await import("../../src/lib/retry");

    /**
     * GATED ON A REACHABLE BROKER, NOT MERELY ON THE VARIABLE BEING SET.
     *
     * `KAFKA_BROKERS` pointing at a broker that is not running produced five
     * hard failures and a "Broker transport failure" that says nothing about
     * what to do — during a full-suite run where the variable was exported out
     * of habit and Compose was down. A stale environment variable is a
     * configuration mistake, and the loud skip is what this file already does
     * for a missing one.
     */
    try {
      await ensureTopics("retailstore-2n-test-admin");
    } catch (err) {
      t.note(
        `KAFKA_BROKERS is set to "${process.env.KAFKA_BROKERS}" but the broker did not answer:`
      );
      t.note(`  ${err instanceof Error ? err.message : String(err)}`);
      t.note("Start it, or unset KAFKA_BROKERS to skip this section deliberately:");
      t.note("  docker compose --profile messaging up -d kafka");
      return;
    }

    t.check(true, "the topics exist, or were created");

    /**
     * PRODUCE FIRST, THEN READ FROM THE BEGINNING.
     *
     * The obvious shape — subscribe, wait a moment, produce — is a race this
     * suite lost on its first real run against a broker: joining a group and
     * being assigned partitions takes longer than the sleep, so the messages
     * were produced to a consumer that was not yet listening and the assertions
     * saw an empty list. Sleeping longer would only make the race rarer.
     *
     * Producing first removes it. The group id is unique per run and
     * `fromBeginning` is true, so this consumer reads the whole topic; the
     * eventIds are unique per run, so anything an earlier run left behind is
     * filtered out rather than mistaken for this one's.
     */
    const onward = event();
    await republish({
      event: onward,
      group: "email-worker",
      originTopic: TOPICS.main,
      destination: retryDestination(0),
      lastError: "connect ETIMEDOUT smtp.example.test:587",
    });

    const dead = event();
    await republish({
      event: dead,
      group: "push-worker",
      originTopic: TOPICS.retry15m,
      destination: retryDestination(RETRY_LADDER.length),
      lastError: "still unreachable after three rungs",
    });

    await closeRetryProducer();

    type Seen = {
      topic: string;
      key: string | null;
      eventId: string;
      attempt: number;
      group: string | undefined;
      error: string | undefined;
    };
    const seen: Seen[] = [];
    const wanted = new Set([onward.eventId, dead.eventId]);

    const consumer = kafka("retailstore-2n-test").consumer({
      kafkaJS: {
        groupId: `${TAG}.reader`,
        fromBeginning: true,
        allowAutoTopicCreation: false,
      },
    });

    await consumer.connect();
    await consumer.subscribe({ topics: [TOPICS.retry5s, TOPICS.dlq] });
    await consumer.run({
      eachMessage: async ({ topic, message }) => {
        /**
         * Anything undecodable is skipped rather than thrown on. A delay topic
         * is shared with whatever previous runs and manual probes left there,
         * and one unparseable message must not fail a suite that is asking
         * about two specific events — the same reasoning the worker applies to
         * a poison pill.
         */
        let decoded: { eventId?: string };
        try {
          decoded = JSON.parse(String(message.value)) as { eventId?: string };
        } catch {
          return;
        }
        if (!decoded.eventId || !wanted.has(decoded.eventId)) return;
        seen.push({
          topic,
          key: message.key ? String(message.key) : null,
          eventId: decoded.eventId,
          attempt: attemptOf(message.headers),
          group: groupOf(message.headers),
          error: message.headers?.["retry-last-error"]?.toString(),
        });
      },
    });

    const deadline = Date.now() + 40_000;
    while (seen.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }

    await consumer.disconnect();

    const rung = seen.find((m) => m.eventId === onward.eventId);
    t.check(!!rung, "the failed message arrives on a rung", seen);
    t.check(rung?.topic === TOPICS.retry5s, "the 5s rung specifically", rung?.topic);
    t.check(rung?.attempt === 1, "carrying its attempt count", rung?.attempt);
    t.check(
      rung?.group === "email-worker",
      "and the group it is for, so other groups skip it",
      rung?.group
    );
    t.check(
      rung?.error?.includes("ETIMEDOUT") === true,
      "with the reason it failed",
      rung?.error
    );
    /**
     * The partition key survives the hop. Losing it here would let a retried
     * notification overtake a later one for the same person — the ordering
     * ADR 0025 keys the main topic to protect.
     */
    t.check(rung?.key === userId, "keyed by userId, as on the main topic", rung?.key);

    const dlq = seen.find((m) => m.eventId === dead.eventId);
    t.check(!!dlq, "an exhausted message arrives in the DLQ", seen);
    t.check(dlq?.topic === TOPICS.dlq, "the DLQ specifically", dlq?.topic);
    t.check(
      dlq?.error?.includes("three rungs") === true,
      "with the failure history that sent it there",
      dlq?.error
    );

        t.note("Still needing a running worker process, not just a broker:");
    t.note("  - a rung's message is not processed before its delay elapses");
    t.note("  - an offset is committed only after the ledger row is settled");
  },

  async () => {
    if (userId) {
      await prisma.notificationDelivery.deleteMany({ where: { userId } });
      await prisma.outboxEvent.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
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
