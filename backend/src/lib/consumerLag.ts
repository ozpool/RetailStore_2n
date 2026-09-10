import { CONSUMERS } from "./consumers";
import { RETRY_LADDER, TOPICS, isKafkaConfigured, kafka } from "./kafka";
import { notifyTransportKind } from "./notifyTransport";
import { relayEnabledInProcess } from "./relay";

/**
 * How far behind the channel workers are, and how much is in the dead-letter
 * queue.
 *
 * WHY LAG IS THE NUMBER THAT MATTERS
 * Everything else about this pipeline can look healthy while it is failing.
 * The API answers, the relay publishes, the outbox drains, every worker process
 * is up — and notifications still arrive four hours late because one consumer
 * group is not keeping up. Nothing already exposed would show that: the outbox
 * is empty precisely BECAUSE the events were published successfully.
 *
 * Lag is the difference between what has been produced and what a group has
 * committed. It is the only figure that answers "is anyone actually getting
 * these".
 *
 * WHY THE DLQ IS REPORTED AS A DEPTH AND NOT AS AN EVENT
 * A message reaching the dead-letter queue is not urgent on its own — the
 * ladder took sixteen minutes to give up on it and one failure is usually a
 * bad address. A DLQ that is GROWING is the incident. So the depth is exposed
 * for something else to threshold and alert on, rather than this endpoint
 * deciding what counts as an emergency.
 *
 * WHAT THIS DOES NOT DO
 * It does not alert. There is no alerting stack here, and pretending otherwise
 * would be worse than saying so — see docs/adr/0020-replication-and-backups.md,
 * which draws the same line around a Postgres standby with no orchestrator.
 * What it does is make the number scrapeable, with a `healthy` flag so a
 * monitor does not have to encode the thresholds itself.
 */

/**
 * Lag above which the pipeline is reported unhealthy.
 *
 * Deliberately generous. Measured throughput is 109-189 events/sec per group
 * (see scripts/notification-throughput-demo.ts), so 5,000 is roughly half a
 * minute of backlog — comfortably above a normal burst and well below the point
 * where somebody's refund notice is an hour old.
 */
function lagThreshold(): number {
  const n = Number(process.env.NOTIFY_LAG_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

/**
 * DLQ depth above which the pipeline is reported unhealthy.
 *
 * Read per call rather than captured at module load, so a deployment can change
 * it without a rebuild and — the reason it was changed — so a test can assert
 * that the unhealthy branch fires at all. A health endpoint that has never been
 * observed returning 503 is not a health endpoint.
 */
function dlqThreshold(): number {
  const n = Number(process.env.NOTIFY_DLQ_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

/** How long to wait on the broker before giving up on a health check. */
const TIMEOUT_MS = 5000;

export type GroupLag = {
  group: string;
  /** Total across every partition of every topic the group reads. */
  lag: number;
  /** Per topic, because a group behind on a retry rung is not the same problem. */
  byTopic: Record<string, number>;
  /**
   * Partitions this group has never committed. Their whole retained backlog is
   * included in `lag`, because that is what the group still owes — but the
   * count is exposed separately so "never started" is distinguishable from
   * "fallen behind", which matters on a first deploy.
   */
  uncommitted: number;
};

export type LagReport =
  | {
      transport: "inline";
      healthy: true;
      /** Stated rather than omitted: inline has no broker and no lag to have. */
      detail: string;
      /**
       * Whether this process is ticking the outbox relay.
       *
       * Reported because a test that drives the relay by hand needs to know
       * whether anything else is draining the same table — the transport alone
       * does not answer that, and guessing from it produced a false positive
       * the first time this was used.
       */
      relayInProcess: boolean;
    }
  | {
      transport: "kafka";
      healthy: boolean;
      groups: GroupLag[];
      dlqDepth: number;
      thresholds: { lag: number; dlq: number };
      /** Topics that do not exist yet — a first boot, not an outage. */
      missingTopics?: string[];
      /** Set when the broker could not be reached at all. */
      error?: string;
    };

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
    ),
  ]);
}

/**
 * Every topic a worker subscribes to.
 *
 * The rungs are included because a group stalled on `retry.15m` is a real
 * failure that the main topic's lag would show as zero — the retries are
 * exactly the messages somebody is still waiting for.
 */
function watchedTopics(): string[] {
  return [TOPICS.main, ...RETRY_LADDER.map((r) => r.topic)];
}

export async function lagReport(): Promise<LagReport> {
  if (notifyTransportKind() !== "kafka" || !isKafkaConfigured()) {
    return {
      transport: "inline",
      healthy: true,
      relayInProcess: relayEnabledInProcess(),
      detail:
        "inline transport — the relay hands events straight to the consumers, " +
        "so there is no broker and no lag",
    };
  }

  const admin = kafka("retailstore-2n-health").admin();

  try {
    await withTimeout(admin.connect(), "connect");

    /**
     * End offsets first, and for every watched topic at once. The order
     * matters slightly: reading committed offsets before end offsets can
     * report NEGATIVE lag if the group commits in between, and a negative lag
     * in a dashboard is the kind of thing that gets the whole panel ignored.
     */
    const ends = new Map<string, Map<number, number>>();
    /** Retention deletes from the front, so a backlog starts at the low mark. */
    const lows = new Map<string, Map<number, number>>();
    const missing: string[] = [];

    for (const topic of watchedTopics()) {
      try {
        const offsets = await withTimeout(
          admin.fetchTopicOffsets(topic),
          `fetchTopicOffsets(${topic})`
        );
        ends.set(topic, new Map(offsets.map((o) => [o.partition, Number(o.high)])));
        lows.set(topic, new Map(offsets.map((o) => [o.partition, Number(o.low)])));
      } catch (err) {
        /**
         * A topic that does not exist yet is not an outage. On a first boot
         * `ensureTopics` may not have run, or its metadata may not have
         * propagated — and failing the whole report for that means the endpoint
         * reports 503 on every fresh deployment until a worker starts, which
         * teaches people to ignore it.
         *
         * Recorded and skipped. If it is still missing when there is traffic,
         * lag will be zero and the DLQ depth will be -1, both of which are
         * visible.
         */
        missing.push(topic);
        void err;
      }
    }

    const groups: GroupLag[] = [];

    for (const consumer of CONSUMERS) {
      /**
       * ITERATE THE TOPIC'S PARTITIONS, NOT THE GROUP'S COMMITTED OFFSETS.
       *
       * This was the bug in the first version, and it was the exact failure
       * this file exists to prevent. `fetchOffsets` returns an EMPTY ARRAY for
       * a group that has never committed — not a list of -1s — so a loop over
       * its result does nothing, and the endpoint cheerfully reported zero lag
       * while forty events sat unconsumed on the topic.
       *
       * The topic's partition list is the authoritative set of work. Committed
       * offsets are looked up against it, and a partition missing from them is
       * a partition nobody has read.
       */
      let committedByTopic = new Map<string, Map<number, number>>();
      try {
        const fetched = await withTimeout(
          admin.fetchOffsets({ groupId: consumer.group, topics: [...ends.keys()] }),
          `fetchOffsets(${consumer.group})`
        );
        committedByTopic = new Map(
          fetched.map((entry) => [
            entry.topic,
            new Map(entry.partitions.map((p) => [p.partition, Number(p.offset)])),
          ])
        );
      } catch {
        // Group unknown to the coordinator: nothing has ever run. Left empty,
        // which the loop below reads as "every partition is unconsumed".
        committedByTopic = new Map();
      }

      const byTopic: Record<string, number> = {};
      let total = 0;
      let uncommitted = 0;

      for (const [topic, partitionHighs] of ends) {
        const committed = committedByTopic.get(topic);
        let topicLag = 0;

        for (const [partition, high] of partitionHighs) {
          const low = lows.get(topic)?.get(partition) ?? 0;
          const offset = committed?.get(partition);

          if (offset === undefined || offset < 0) {
            /**
             * Never committed. The backlog is everything still retained, from
             * the low watermark — because that is genuinely what this group
             * still owes, and reporting 0 here is how "no worker is running"
             * became invisible.
             *
             * It is counted in `uncommitted` as well, so a dashboard can tell
             * a group that has never started from one that has fallen behind.
             * The distinction matters on a first deploy, where this figure is
             * briefly large and entirely expected.
             */
            uncommitted += 1;
            topicLag += Math.max(0, high - low);
            continue;
          }

          topicLag += Math.max(0, high - offset);
        }

        if (topicLag > 0) byTopic[topic] = topicLag;
        total += topicLag;
      }

      groups.push({ group: consumer.group, lag: total, byTopic, uncommitted });
    }

    let dlqDepth = 0;
    try {
      const dlqOffsets = await withTimeout(
        admin.fetchTopicOffsets(TOPICS.dlq),
        "fetchTopicOffsets(dlq)"
      );
      dlqDepth = dlqOffsets.reduce(
        (sum, o) => sum + Math.max(0, Number(o.high) - Number(o.low)),
        0
      );
    } catch {
      // -1 rather than 0: "not known" and "empty" are different answers, and
      // a dashboard showing a confident zero for a queue it could not read is
      // exactly the wrong outcome.
      dlqDepth = -1;
    }

    const worst = groups.reduce((a, g) => Math.max(a, g.lag), 0);

    return {
      transport: "kafka",
      healthy: worst <= lagThreshold() && dlqDepth >= 0 && dlqDepth <= dlqThreshold(),
      groups,
      dlqDepth,
      thresholds: { lag: lagThreshold(), dlq: dlqThreshold() },
      ...(missing.length > 0 ? { missingTopics: missing } : {}),
    };
  } catch (err) {
    /**
     * UNREACHABLE IS UNHEALTHY. A health endpoint that returns 200 because it
     * could not determine anything is worse than one that fails: the monitor
     * goes green and the person on call finds out from a customer.
     */
    return {
      transport: "kafka",
      healthy: false,
      groups: [],
      dlqDepth: -1,
      thresholds: { lag: lagThreshold(), dlq: dlqThreshold() },
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await admin.disconnect().catch(() => {});
  }
}
