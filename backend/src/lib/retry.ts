import { RETRY_LADDER, TOPICS, kafka } from "./kafka";
import { encodeEvent, type NotificationEvent } from "./outbox";

/**
 * The retry ladder: where a message goes after a transient failure.
 *
 * WHY A TOPIC AND NOT A SLEEP
 * A consumer that waits in place holds its partition. One recipient behind a
 * provider having a bad minute would stall every other user hashed to that
 * partition, turning a per-recipient failure into a per-channel outage. So the
 * consumer commits its offset, the message waits somewhere else, and a worker
 * reading that somewhere else picks it up once the delay has elapsed. The main
 * partition never stops moving. See ADR 0025.
 *
 * WHY THE ATTEMPT COUNT IS A HEADER AND NOT IN THE EVENT
 * The event body is the domain fact — who, what, when. How many times we have
 * tried to deliver it is transport bookkeeping, and putting it in the payload
 * would mean the bytes a consumer sees differ from the bytes the outbox wrote,
 * which is exactly the sort of drift that makes a replay behave unlike the
 * original run.
 */

/** How many rungs this message has already used. Absent means none. */
export const ATTEMPT_HEADER = "retry-attempt";

/**
 * Which consumer group the retry is FOR.
 *
 * Every group subscribes to every ladder topic, because a group cannot
 * subscribe to a topic that might not exist yet. Without this header, an email
 * failure republished to retry.5s would also be consumed by push-worker, which
 * would then reprocess a push it already delivered. The ledger would refuse
 * the duplicate and nothing would break — but the work, the log lines, and the
 * confusion are all avoidable for the cost of one header.
 */
export const GROUP_HEADER = "retry-group";

/** Why the previous attempt failed, carried for whoever reads the DLQ. */
export const ERROR_HEADER = "retry-last-error";

/** The topic the message was on when it failed, for the same reason. */
export const ORIGIN_HEADER = "retry-origin";

/**
 * Kafka allows a header key to repeat, so the client hands back an array in
 * that case. We never write duplicates, but a type that pretends they are
 * impossible would be a lie that only shows up as a crash on somebody else's
 * message.
 */
type HeaderValue = Buffer | string | (Buffer | string)[] | undefined;
type Headers = Record<string, HeaderValue> | undefined;

function headerString(headers: Headers, name: string): string | undefined {
  const raw = headers?.[name];
  const one = Array.isArray(raw) ? raw[0] : raw;
  if (one === undefined || one === null) return undefined;
  return Buffer.isBuffer(one) ? one.toString("utf8") : String(one);
}

/**
 * Rungs already used by this message.
 *
 * A missing, malformed, or negative header reads as 0 rather than throwing. A
 * message that cannot be counted is one we have no evidence has been retried,
 * and starting it at the bottom of the ladder is the conservative reading —
 * the ledger stops it from being delivered twice either way.
 */
export function attemptOf(headers: Headers): number {
  const raw = headerString(headers, ATTEMPT_HEADER);
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function groupOf(headers: Headers): string | undefined {
  return headerString(headers, GROUP_HEADER);
}

/** Is this one of the delay topics, as opposed to the main one? */
export function isRetryTopic(topic: string): boolean {
  return RETRY_LADDER.some((rung) => rung.topic === topic);
}

/** How long a message on `topic` must age before it may be processed. */
export function delayFor(topic: string): number {
  return RETRY_LADDER.find((rung) => rung.topic === topic)?.delayMs ?? 0;
}

export type Destination =
  | { kind: "retry"; topic: string; delayMs: number; attempt: number }
  | { kind: "dlq"; topic: string; attempt: number };

/**
 * Where a message that just failed transiently should go next.
 *
 * Falling off the end of the ladder is the DLQ, not a drop. A message nobody
 * can deliver after 5s, 1m, and 15m represents something a person has to look
 * at, and the alternative — logging it and moving on — is how a systematic
 * failure stays invisible until somebody asks why a customer never heard back.
 */
export function retryDestination(attempt: number): Destination {
  const rung = RETRY_LADDER[attempt];
  if (!rung) return { kind: "dlq", topic: TOPICS.dlq, attempt };
  return {
    kind: "retry",
    topic: rung.topic,
    delayMs: rung.delayMs,
    attempt: attempt + 1,
  };
}

/* ------------------------------------------------------------------ *
 * Producing
 * ------------------------------------------------------------------ */

let producer: ReturnType<ReturnType<typeof kafka>["producer"]> | null = null;
let connected = false;

async function retryProducer() {
  if (!producer) {
    producer = kafka("retailstore-2n-retry").producer({
      kafkaJS: {
        // Same settings as the relay's producer, and for the same reasons: a
        // retry that is acknowledged by one broker and then lost is a
        // notification silently dropped at the point we were trying hardest
        // not to drop it.
        acks: -1,
        idempotent: true,
        allowAutoTopicCreation: false,
      },
    });
  }
  if (!connected) {
    await producer.connect();
    connected = true;
  }
  return producer;
}

export async function closeRetryProducer(): Promise<void> {
  if (producer && connected) {
    await producer.disconnect();
    connected = false;
  }
}

/**
 * Puts a failed message back on the wire, one rung further along.
 *
 * The partition key stays `event.userId`, so a retried notification still
 * cannot overtake another notification for the same person on the topic it
 * lands on. Losing that on the way through the ladder would reintroduce the
 * out-of-order delivery ADR 0025 keys the main topic to prevent.
 */
export async function republish(args: {
  event: NotificationEvent;
  group: string;
  originTopic: string;
  destination: Destination;
  lastError: string;
}): Promise<void> {
  const { event, group, originTopic, destination, lastError } = args;
  const p = await retryProducer();

  await p.send({
    topic: destination.topic,
    messages: [
      {
        key: event.userId,
        value: encodeEvent(event),
        headers: {
          "event-id": event.eventId,
          "event-type": event.type,
          [ATTEMPT_HEADER]: String(destination.attempt),
          [GROUP_HEADER]: group,
          [ORIGIN_HEADER]: originTopic,
          [ERROR_HEADER]: lastError.slice(0, 500),
        },
      },
    ],
  });
}
