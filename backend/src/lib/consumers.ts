import type { DeliveryOutcome } from "./deliveryLedger";
import type { DeliveryChannel } from "../generated/prisma/enums";
import type { NotificationEvent } from "./outbox";
import { emailConsumer } from "./consumers/email";
import { pushConsumer } from "./consumers/push";
import { smsConsumer } from "./consumers/sms";

/**
 * The channel consumers.
 *
 * Each is a plain async function. That is the whole point of the transport
 * seam: under NOTIFY_TRANSPORT=inline the relay calls these directly, and under
 * kafka each one becomes a consumer group reading the same topic. Identical
 * code on both paths, so the suite exercises the real handler and only the
 * broker is absent.
 *
 * WHAT IS HERE
 * Email (phase 2), push (phase 3), and SMS (phase 4) are all real. SMS still
 * defaults to a stub PROVIDER — `SMS_PROVIDER=stub` — which is a different
 * thing from a stub consumer: the whole path runs, preferences are resolved,
 * the ledger is claimed and settled, and only the carrier is absent. That is
 * what lets CI exercise SMS without a secret and without billing anyone.
 *
 * EVERY CONSUMER GOES THROUGH deliveryLedger.deliver(). That is what resolves
 * preferences, claims the delivery, and settles the outcome — and it is the
 * only reason a redelivered event is not a second message. A consumer that
 * sends without it is a bug, not a shortcut.
 *
 * See docs/plans/0001-multi-channel-notifications.md.
 */

/**
 * Passed down from the worker, and the only thing that differs between a
 * message off the main topic and the same message off a retry topic.
 */
export type HandleOptions = {
  /**
   * This is a retry of a delivery this pipeline already attempted, so the
   * consumer may take over its own earlier FAILED ledger row. Never set on the
   * main topic — see deliveryLedger.claim().
   */
  reclaim?: boolean;
};

export type NotificationConsumer = {
  /** Becomes the Kafka consumer group id. Stable — changing it replays. */
  readonly group: string;
  /**
   * The ledger channel this consumer settles, when it settles one.
   *
   * Optional because the log consumer delivers nothing. Where it is set, a
   * message on its way to the dead-letter queue can be annotated with the
   * actual provider error off the ledger row, instead of arriving with only
   * "it failed" — which is the difference between a DLQ somebody can triage
   * and one they have to go database-spelunking behind.
   */
  readonly channel?: DeliveryChannel;
  /**
   * Returns what happened, so the worker can decide whether to put the message
   * back on the ladder. A consumer with nothing to report — the log consumer —
   * returns void, which the worker reads as "no delivery, nothing to retry".
   */
  handle(
    event: NotificationEvent,
    opts?: HandleOptions
  ): Promise<DeliveryOutcome | void>;
};

/**
 * Proves the pipeline end to end, and stays useful afterwards as the thing you
 * point at a topic to see what is actually flowing through it.
 */
export const logConsumer: NotificationConsumer = {
  group: "log-worker",
  async handle(event) {
    console.log(
      `[notify] ${event.type} → user ${event.userId} ` +
        `(event ${event.eventId}, ${event.aggregateType} ${event.aggregateId}) ` +
        `${JSON.stringify(event.payload.title)}`
    );
  },
};

export const CONSUMERS: NotificationConsumer[] = [
  logConsumer,
  emailConsumer,
  pushConsumer,
  smsConsumer,
];
