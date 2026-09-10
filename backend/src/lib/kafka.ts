/**
 * TYPE-ONLY, AND DELIBERATELY SO — the runtime import is in kafka() below.
 *
 * @confluentinc/kafka-javascript is a native addon: importing it at module
 * scope dlopens librdkafka the moment anything in this file is touched. This
 * file also exports TOPICS and RETRY_LADDER, which are plain data that the
 * inline transport, the outbox, and several tests all read — so a top-level
 * import made the ENTIRE application, on the transport that exists precisely
 * so no broker is needed, refuse to start unless a platform-specific binary
 * was present and loadable.
 *
 * That is not hypothetical. A node_modules installed on one platform and used
 * on another gives `ERR_DLOPEN_FAILED` from `require`, and the failure lands
 * nowhere near Kafka: the API will not boot with NOTIFY_TRANSPORT=inline, and
 * `npm test` cannot collect a suite that only wanted a topic name.
 *
 * A type import is erased at compile time, so this costs nothing and the
 * binary is loaded only by code that is actually about to talk to a broker.
 */
import type { KafkaJS } from "@confluentinc/kafka-javascript";

/**
 * Kafka client, topic names, and topic creation.
 *
 * The client is @confluentinc/kafka-javascript rather than kafkajs. Both expose
 * the same API — the Confluent package ships a KafkaJS-compatible surface over
 * librdkafka — and the deciding fact is maintenance: kafkajs last published in
 * February 2023, the Confluent package publishes regularly. That was open
 * question 2 in plan 0001, and this is the answer.
 *
 * Topic design, and why the partition key is userId, is
 * docs/adr/0025-kafka-topics-and-partitioning.md.
 */

const PREFIX = "retailstore-2n.notifications";

export const TOPICS = {
  main: `${PREFIX}.v1`,
  retry5s: `${PREFIX}.retry.5s.v1`,
  retry1m: `${PREFIX}.retry.1m.v1`,
  retry15m: `${PREFIX}.retry.15m.v1`,
  dlq: `${PREFIX}.dlq.v1`,
} as const;

/**
 * The retry ladder, in order. A message that fails transiently moves to the
 * next topic; a message that falls off the end lands in the DLQ.
 *
 * Delay topics rather than in-process sleeps, because a consumer that waits
 * blocks its whole partition — one recipient with a dead phone number holding
 * up every other user hashed there. See ADR 0025.
 */
export const RETRY_LADDER = [
  { topic: TOPICS.retry5s, delayMs: 5_000 },
  { topic: TOPICS.retry1m, delayMs: 60_000 },
  { topic: TOPICS.retry15m, delayMs: 900_000 },
] as const;

export function brokers(): string[] {
  const raw = process.env.KAFKA_BROKERS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
}

export function isKafkaConfigured(): boolean {
  return brokers().length > 0;
}

/**
 * Replication comes from environment, never a literal.
 *
 * A hardcoded 3 makes the single-broker Compose stack fail to create topics; a
 * hardcoded 1 makes a real cluster silently unreplicated, which is discovered
 * during the incident it causes.
 */
function replicationFactor(): number {
  const raw = Number(process.env.KAFKA_REPLICATION_FACTOR);
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

function minInSyncReplicas(): string {
  const raw = Number(process.env.KAFKA_MIN_INSYNC_REPLICAS);
  return String(Number.isInteger(raw) && raw > 0 ? raw : 1);
}

let client: KafkaJS.Kafka | null = null;

export function kafka(clientId: string): KafkaJS.Kafka {
  if (!client) {
    const list = brokers();
    if (list.length === 0) {
      throw new Error(
        "KAFKA_BROKERS is not set. Set it, or run with NOTIFY_TRANSPORT=inline."
      );
    }

    /**
     * Loaded here rather than at the top of the file, so that the native addon
     * is required only once something genuinely needs a broker. See the note on
     * the type import above for what a module-scope import breaks.
     */
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rt = require("@confluentinc/kafka-javascript") as typeof import("@confluentinc/kafka-javascript");

    client = new rt.KafkaJS.Kafka({ kafkaJS: { brokers: list, clientId } });
  }
  return client;
}

/**
 * Retention per topic, in milliseconds.
 *
 * The main topic keeps a week so a consumer group can be reset and replayed
 * after a template bug. The delay topics keep a day, which is far longer than
 * the ladder they serve. The DLQ keeps a month, because a message reaching it
 * represents a failure somebody has to look at, and a week is not long enough
 * for that to survive a holiday.
 */
const TOPIC_SPEC: { topic: string; partitions: number; retentionMs: number }[] = [
  { topic: TOPICS.main, partitions: 12, retentionMs: 7 * 24 * 3600_000 },
  { topic: TOPICS.retry5s, partitions: 6, retentionMs: 24 * 3600_000 },
  { topic: TOPICS.retry1m, partitions: 6, retentionMs: 24 * 3600_000 },
  { topic: TOPICS.retry15m, partitions: 6, retentionMs: 24 * 3600_000 },
  { topic: TOPICS.dlq, partitions: 3, retentionMs: 30 * 24 * 3600_000 },
];

/**
 * Creates the topics if they do not exist. Idempotent — an existing topic is
 * left exactly as it is, including its partition count.
 *
 * EXPLICIT, BECAUSE AUTO-CREATION HIDES TYPOS. With auto-creation on, a
 * misspelled topic name produces a brand new empty topic with default settings
 * instead of an error, and the symptom is a consumer that connects fine and
 * receives nothing.
 *
 * This does NOT raise the partition count of an existing topic. Doing so
 * rehashes keys and breaks per-user ordering during the change, so it is a
 * deliberate operation rather than a side effect of a deploy.
 */
export async function ensureTopics(clientId: string): Promise<string[]> {
  const admin = kafka(clientId).admin();
  await admin.connect();

  try {
    const existing = new Set(await admin.listTopics());
    const missing = TOPIC_SPEC.filter((t) => !existing.has(t.topic));

    if (missing.length > 0) {
      await admin.createTopics({
        topics: missing.map((t) => ({
          topic: t.topic,
          numPartitions: t.partitions,
          replicationFactor: replicationFactor(),
          configEntries: [
            { name: "retention.ms", value: String(t.retentionMs) },
            { name: "min.insync.replicas", value: minInSyncReplicas() },
          ],
        })),
      });
    }

    return missing.map((t) => t.topic);
  } finally {
    await admin.disconnect();
  }
}
