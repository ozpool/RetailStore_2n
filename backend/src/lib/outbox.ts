import { randomUUID } from "crypto";
import type { prisma } from "./prisma";
import type { NotificationType } from "../generated/prisma/enums";

/**
 * The transactional outbox.
 *
 * Every notification that has to reach a channel outside the app is written
 * here, in the same transaction as the notification itself. A relay
 * (lib/relay.ts) publishes committed rows and nothing else.
 *
 * See docs/adr/0024-outbox-not-dual-writes.md for why publishing directly from
 * notify() is not an option, in either order.
 */

/**
 * A Prisma transaction client.
 *
 * Spelled this way rather than imported, matching lib/reservations.ts — the
 * generated client does not export a standalone name for it.
 */
export type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * What a channel worker needs to render and send.
 *
 * A SNAPSHOT, for the same reason the notification's own title and body are
 * snapshots: "Cast iron skillet sold" has to keep saying that after the listing
 * is renamed, and an event that re-derived its text from live rows would break
 * entirely once those rows are gone.
 */
export type NotificationPayload = {
  notificationId: string;
  title: string;
  body: string | null;
  link: string | null;
};

/** The envelope on the wire, and the shape every consumer receives. */
export type NotificationEvent = {
  eventId: string;
  type: NotificationType;
  userId: string;
  aggregateType: string;
  aggregateId: string;
  payload: NotificationPayload;
  occurredAt: string;
};

export type EnqueueInput = {
  type: NotificationType;
  userId: string;
  aggregateType: string;
  aggregateId: string;
  payload: NotificationPayload;
};

/**
 * Writes one event to the outbox.
 *
 * TAKES A TRANSACTION CLIENT, NOT `prisma`. That is the enforcement: this
 * cannot be called outside a transaction, so it cannot be made into the dual
 * write it exists to prevent. If you find yourself wanting to pass the global
 * client here, the thing you actually want is a `$transaction` around both
 * writes.
 *
 * Returns the eventId — generated here, once, and carried unchanged through
 * every republish and redelivery. It is what consumers deduplicate on
 * (ADR 0026), so nothing downstream may invent its own.
 */
export async function enqueue(tx: TxClient, input: EnqueueInput): Promise<string> {
  const eventId = randomUUID();

  await tx.outboxEvent.create({
    data: {
      eventId,
      type: input.type,
      userId: input.userId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload,
    },
  });

  return eventId;
}

/** Several at once — one basket can notify several sellers. */
export async function enqueueMany(
  tx: TxClient,
  inputs: EnqueueInput[]
): Promise<string[]> {
  if (inputs.length === 0) return [];

  const rows = inputs.map((input) => ({
    eventId: randomUUID(),
    type: input.type,
    userId: input.userId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload: input.payload,
  }));

  await tx.outboxEvent.createMany({ data: rows });

  return rows.map((r) => r.eventId);
}

/* ------------------------------------------------------------------ *
 * The wire format
 *
 * JSON, because the envelope is small, human-readable in a console consumer,
 * and readable by anything that might later want to consume it. Avro or
 * protobuf would buy schema enforcement at the cost of a registry, which is
 * another stateful service to run for a five-field envelope.
 * ------------------------------------------------------------------ */

export function encodeEvent(event: NotificationEvent): Buffer {
  return Buffer.from(JSON.stringify(event), "utf8");
}

/**
 * Parses a message off the wire.
 *
 * Returns null rather than throwing on anything unreadable. A malformed message
 * is a poison pill: thrown, it fails the batch, the offset is never committed,
 * and the consumer reprocesses the same bad message forever — a stalled
 * partition caused by one row. Returning null lets the caller record it and
 * move past it.
 */
export function decodeEvent(raw: Buffer | string | null): NotificationEvent | null {
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));

    if (
      typeof parsed?.eventId !== "string" ||
      typeof parsed?.userId !== "string" ||
      typeof parsed?.type !== "string" ||
      typeof parsed?.payload !== "object" ||
      parsed.payload === null
    ) {
      return null;
    }

    return parsed as NotificationEvent;
  } catch {
    return null;
  }
}
