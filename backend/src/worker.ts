import "dotenv/config";
import { CONSUMERS, type NotificationConsumer } from "./lib/consumers";
import { RETRY_LADDER, ensureTopics, kafka, TOPICS } from "./lib/kafka";
import { decodeEvent } from "./lib/outbox";
import { prisma } from "./lib/prisma";
import {
  attemptOf,
  closeRetryProducer,
  delayFor,
  groupOf,
  isRetryTopic,
  republish,
  retryDestination,
} from "./lib/retry";

/**
 * A channel worker: one Kafka consumer group per consumer.
 *
 * Consumer groups ARE the fan-out. One topic, N groups, each getting every
 * message and tracking its own offsets — so adding a channel is a new group and
 * no producer change at all. See docs/adr/0025-kafka-topics-and-partitioning.md
 *
 * Run all consumers in one process, or one per process:
 *
 *   node dist/worker.js               every consumer group
 *   node dist/worker.js log-worker    just that one
 *
 * One per process is what a real deployment does, because it is what lets email
 * and SMS scale independently — which is most of why a broker is here at all.
 */

/**
 * The provider's own words, off the ledger row, so a message arriving in the
 * DLQ says why rather than merely that.
 *
 * Best effort on purpose: this runs on the failure path, and a second failure
 * here must not stop the message reaching the DLQ. An empty reason is a worse
 * DLQ entry; a lost one is a lost notification.
 */
async function lastLedgerError(
  consumer: NotificationConsumer,
  eventId: string
): Promise<string> {
  if (!consumer.channel) return "no channel on this consumer";

  try {
    const row = await prisma.notificationDelivery.findUnique({
      where: { eventId_channel: { eventId, channel: consumer.channel } },
      select: { lastError: true },
    });
    return row?.lastError ?? "no ledger row";
  } catch (err) {
    return `could not read ledger: ${String(err)}`;
  }
}

/**
 * OFFSETS ARE COMMITTED BY HAND, AFTER THE HANDLER RETURNS.
 *
 * With autoCommit on, the offset advances on a timer regardless of whether the
 * handler finished, so a consumer that dies mid-send has already recorded the
 * message as done and it is never retried — a silently dropped notification.
 *
 * Committing after the handler inverts the failure: a crash between the send
 * and the commit redelivers, which is a duplicate rather than a loss. That is
 * the trade this pipeline makes everywhere, and it is only safe because the
 * delivery ledger deduplicates on eventId.
 * See docs/adr/0026-delivery-idempotency.md
 */
async function runConsumer(consumer: NotificationConsumer): Promise<void> {
  const client = kafka(`retailstore-2n-${consumer.group}`);
  const kc = client.consumer({
    kafkaJS: {
      groupId: consumer.group,
      autoCommit: false,
      allowAutoTopicCreation: false,
      fromBeginning: true,
    },
  });

  await kc.connect();

  /**
   * Every group subscribes to the main topic AND every rung of the ladder.
   *
   * A group cannot selectively subscribe to "the retries that are mine", so it
   * reads them all and drops the ones tagged for another group. The alternative
   * — a set of delay topics per channel — multiplies topic count by the number
   * of channels to save a header comparison.
   */
  const topics = [TOPICS.main, ...RETRY_LADDER.map((r) => r.topic)];
  await kc.subscribe({ topics });

  console.log(`[worker] ${consumer.group} subscribed to ${topics.join(", ")}`);

  await kc.run({
    eachMessage: async ({ topic, partition, message }) => {
      // Kafka's next-offset convention: commit the offset AFTER this one.
      const commit = () =>
        kc.commitOffsets([
          { topic, partition, offset: String(Number(message.offset) + 1) },
        ]);

      /**
       * A retry belongs to exactly one group. Committing past somebody else's
       * is correct: this group's offsets are its own, and the group the message
       * IS for reads it from its own position in the same partition.
       */
      const intendedFor = groupOf(message.headers);
      if (intendedFor && intendedFor !== consumer.group) {
        await commit();
        return;
      }

      const onLadder = isRetryTopic(topic);

      /**
       * THE DELAY, AND WHY IT IS NOT A SLEEP.
       *
       * Awaiting inside eachMessage holds the poll loop. Hold it past
       * max.poll.interval.ms — five minutes by default, and the 15m rung is
       * three times that — and the broker decides this consumer is dead and
       * rebalances the group, forever, in a loop.
       *
       * So: pause the partition, seek back so this same message is redelivered,
       * and resume once the message is old enough. The consumer keeps polling
       * and stays a member of its group the whole time; only this one partition
       * stops. No offset is committed, so a restart mid-wait redelivers rather
       * than skipping.
       */
      if (onLadder) {
        const readyAt = Number(message.timestamp) + delayFor(topic);
        const waitMs = readyAt - Date.now();

        if (waitMs > 0) {
          kc.pause([{ topic, partitions: [partition] }]);
          kc.seek({ topic, partition, offset: message.offset });
          setTimeout(() => {
            try {
              kc.resume([{ topic, partitions: [partition] }]);
            } catch (err) {
              // Resuming a consumer that has since disconnected or been
              // rebalanced away throws. Harmless: whoever owns the partition
              // now will read this message from the uncommitted offset.
              console.warn(`[worker] ${consumer.group}: resume failed`, err);
            }
          }, waitMs).unref();
          return;
        }
      }

      const event = decodeEvent(message.value);

      if (!event) {
        /**
         * A poison pill. Committed past deliberately: rethrowing would stall
         * this partition forever on one unreadable message, which is a far
         * worse outcome than losing it. Logged loudly because it should never
         * happen — the only producer is our own relay.
         */
        console.error(
          `[worker] ${consumer.group}: undecodable message at ` +
            `${topic}/${partition}/${message.offset}, skipping`
        );
        await commit();
        return;
      }

      /**
       * `reclaim` is set for ladder messages only. It is what lets this attempt
       * take over the FAILED ledger row its predecessor left behind — without
       * it the unique constraint would read every retry as a duplicate and the
       * ladder would deliver nothing. See deliveryLedger.claim().
       */
      const outcome = await consumer.handle(event, { reclaim: onLadder });

      if (outcome === "retry") {
        const attempt = attemptOf(message.headers);
        const destination = retryDestination(attempt);

        await republish({
          event,
          group: consumer.group,
          originTopic: topic,
          destination,
          lastError: await lastLedgerError(consumer, event.eventId),
        });

        console.warn(
          `[worker] ${consumer.group}: ${event.eventId} → ${destination.topic}` +
            (destination.kind === "retry"
              ? ` in ${destination.delayMs}ms (attempt ${destination.attempt})`
              : ` (ladder exhausted after ${attempt} attempt(s))`)
        );
      }

      await commit();
    },
  });

  const shutdown = async () => {
    console.log(`\n[worker] ${consumer.group} disconnecting`);
    try {
      await kc.disconnect();
      await closeRetryProducer();
      await prisma.$disconnect();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

async function main() {
  if (process.env.NOTIFY_TRANSPORT?.trim().toLowerCase() !== "kafka") {
    console.error(
      "\nConfiguration error:\n" +
        "  The worker only runs under NOTIFY_TRANSPORT=kafka.\n" +
        "  With inline transport the relay calls the consumers directly and\n" +
        "  there is nothing here to consume.\n"
    );
    process.exit(1);
  }

  const requested = process.argv[2];
  const selected = requested
    ? CONSUMERS.filter((c) => c.group === requested)
    : CONSUMERS;

  if (selected.length === 0) {
    console.error(
      `\nUnknown consumer "${requested}". Available: ` +
        `${CONSUMERS.map((c) => c.group).join(", ")}\n`
    );
    process.exit(1);
  }

  await ensureTopics("retailstore-2n-worker-admin");
  await Promise.all(selected.map(runConsumer));
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
