import { CONSUMERS } from "./consumers";
import { brokers, isKafkaConfigured, kafka, TOPICS } from "./kafka";
import { encodeEvent, type NotificationEvent } from "./outbox";

/**
 * How a published event gets from the relay to the consumers.
 *
 * TWO TRANSPORTS, ONE INTERFACE — the same shape as the payment and identity
 * seams, and for the same reason.
 *
 *   inline  the relay calls the consumer functions in-process. No broker. The
 *           default, and what the suite and CI run against: 870 assertions
 *           should not wait on a Kafka cluster, and a pull request from a fork
 *           must pass without one.
 *
 *   kafka   the real transport. Local, and everywhere real.
 *
 * WHAT `inline` STILL TESTS, WHICH IS ALMOST EVERYTHING. The outbox write, the
 * transaction it shares with the notification, the relay's claim query, the
 * consumer handlers, and (from phase 2) preference resolution and the
 * idempotency guard all run exactly as they do in production. Only the wire is
 * missing. What it cannot show is rebalance behaviour, offset commit ordering,
 * and the retry ladder — which is why those get their own broker-gated suite
 * rather than being assumed.
 */

export type TransportKind = "inline" | "kafka";

export type NotifyTransport = {
  readonly kind: TransportKind;
  publish(events: NotificationEvent[]): Promise<void>;
  close(): Promise<void>;
};

export function notifyTransportKind(): TransportKind {
  return configuredKind();
}

function configuredKind(): TransportKind {
  const raw = process.env.NOTIFY_TRANSPORT?.trim().toLowerCase();
  if (raw === "kafka") return "kafka";
  if (raw === "inline" || !raw) return "inline";

  // An unrecognised value falls back rather than guessing "kafka", which would
  // make the server refuse to start over a typo. Same as MAIL_TRANSPORT.
  console.warn(`[notify] unknown NOTIFY_TRANSPORT "${raw}", using inline`);
  return "inline";
}

/* ------------------------------------------------------------------ *
 * inline
 * ------------------------------------------------------------------ */

const inlineTransport: NotifyTransport = {
  kind: "inline",

  async publish(events) {
    for (const event of events) {
      for (const consumer of CONSUMERS) {
        /**
         * One consumer's failure must not stop the others, exactly as one
         * consumer group falling over does not stop the rest under Kafka. The
         * inline path has to fail the same way the real one does, or it is
         * testing something other than what ships.
         */
        try {
          await consumer.handle(event);
        } catch (err) {
          console.error(
            `[notify] consumer ${consumer.group} failed on ${event.eventId}`,
            err
          );
        }
      }
    }
  },

  async close() {
    // Nothing to close. Present so callers need not care which transport they have.
  },
};

/* ------------------------------------------------------------------ *
 * kafka
 * ------------------------------------------------------------------ */

function createKafkaTransport(): NotifyTransport {
  const producer = kafka("retailstore-2n-relay").producer({
    kafkaJS: {
      /**
       * acks -1 is "all in-sync replicas". Anything less means the relay can
       * mark a row published while the only broker holding it is one that has
       * not yet replicated — and the outbox row is then gone as a record of
       * work still owed.
       */
      acks: -1,
      /**
       * The producer deduplicates its own retries, so a network-level retry
       * does not itself become a duplicate. It does NOT make the pipeline
       * exactly-once — the relay can still republish a whole batch after a
       * crash, which is the case ADR 0026 handles.
       */
      idempotent: true,
      /**
       * Off, so a typo in a topic name is an error rather than a new empty
       * topic. Topics are created explicitly by ensureTopics().
       */
      allowAutoTopicCreation: false,
    },
  });

  let connected = false;

  return {
    kind: "kafka",

    async publish(events) {
      if (!connected) {
        await producer.connect();
        connected = true;
      }

      await producer.send({
        topic: TOPICS.main,
        messages: events.map((event) => ({
          /**
           * THE PARTITION KEY. Every event for one person lands on one
           * partition, so their notifications cannot overtake each other —
           * which is what stops a refund notice arriving before the "can't be
           * sent" notice that explains it. See ADR 0025.
           */
          key: event.userId,
          value: encodeEvent(event),
          headers: {
            "event-id": event.eventId,
            "event-type": event.type,
          },
        })),
      });
    },

    async close() {
      if (connected) {
        await producer.disconnect();
        connected = false;
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

let transport: NotifyTransport | null = null;

export function getTransport(): NotifyTransport {
  if (!transport) {
    transport = configuredKind() === "kafka" ? createKafkaTransport() : inlineTransport;
  }
  return transport;
}

/** For tests that need to swap transports inside one process. */
export async function resetTransport(): Promise<void> {
  if (transport) await transport.close();
  transport = null;
}

/**
 * Checked at startup, before the port is bound — same as the payment, identity,
 * and mail checks. NOTIFY_TRANSPORT=kafka with no brokers configured is a
 * misconfiguration that would otherwise surface as notifications silently
 * piling up in the outbox while the app looks perfectly healthy.
 */
export function assertNotifyConfigured(): string {
  const kind = configuredKind();

  if (kind === "kafka") {
    if (!isKafkaConfigured()) {
      throw new Error(
        "NOTIFY_TRANSPORT=kafka requires KAFKA_BROKERS (e.g. localhost:9092)."
      );
    }
    return `kafka → ${brokers().join(", ")} (topic ${TOPICS.main})`;
  }

  return `inline — ${CONSUMERS.length} consumer(s), no broker`;
}
