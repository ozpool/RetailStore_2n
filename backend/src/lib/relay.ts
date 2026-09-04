import { prisma } from "./prisma";
import { getTransport } from "./notifyTransport";
import type { NotificationEvent, NotificationPayload, TxClient } from "./outbox";

/**
 * The outbox relay: reads committed events and publishes them.
 *
 * WHY IT CLAIMS WITH `FOR UPDATE SKIP LOCKED`
 * `FOR UPDATE` is the same lock discipline as lib/reservations.ts. `SKIP
 * LOCKED` is what makes more than one relay safe: a row already claimed by
 * another relay is passed over rather than waited on, so N relays divide the
 * backlog instead of queueing behind each other.
 *
 * Without SKIP LOCKED a second relay blocks on the first's batch — correct, but
 * pointless. Without FOR UPDATE at all, two relays read the same unpublished
 * rows and publish every one of them twice.
 *
 * WHY THE PUBLISH HAPPENS INSIDE THE TRANSACTION
 * This is the one place in the codebase where an external call sits inside an
 * open transaction, and it is deliberate. The lock IS the claim: released at
 * commit, so it has to still be held while the publish is in flight or a second
 * relay could claim the same rows mid-publish.
 *
 * The cost is a transaction held open for the duration of a broker round trip,
 * which is bounded by the producer's own timeout and by TX_TIMEOUT_MS below. At
 * one batch a second against a broker in the same network this is single-digit
 * milliseconds. If it ever is not, the fix is a two-phase claim with a
 * `claimedAt` column and a claim-expiry sweep — more moving parts, and not
 * earned yet.
 *
 * WHY PUBLISH-THEN-MARK, AND NOT THE REVERSE
 * A crash between the publish and the commit leaves the rows unpublished, so
 * the next pass publishes them again. That is a duplicate, and duplicates are
 * handled downstream by the delivery ledger (ADR 0026). Marking first would
 * turn the same crash into a lost notification, which nothing downstream can
 * recover, because no record survives saying it was owed.
 *
 * See docs/adr/0024-outbox-not-dual-writes.md
 */

/** How many events one pass claims. */
const BATCH_SIZE = 100;

/**
 * Bounds the transaction described above. Generous relative to a healthy
 * publish and far below anything that would look like a stuck relay.
 */
const TX_TIMEOUT_MS = 15_000;

export const DEFAULT_POLL_MS = 1_000;

/**
 * Whether THIS process should tick the relay itself.
 *
 * The answer is yes on the inline transport, where there is no broker and a
 * separate container for a function call would be ceremony — and no when
 * `RELAY_IN_PROCESS` is switched off, which exists for the test suite.
 * `tests/api/outbox.ts` drives `relayOnce()` by hand and registers its spy
 * consumer in the TEST process, so a relay ticking here claims the same rows
 * and hands them to the wrong consumers.
 *
 * Exported rather than inlined at the call site because two places need the
 * same answer: the boot sequence, which acts on it, and `/health/lag`, which
 * reports it so a test can tell whether it is competing with anything.
 */
export function relayEnabledInProcess(): boolean {
  return !["false", "0", "off", "no"].includes(
    (process.env.RELAY_IN_PROCESS ?? "").trim().toLowerCase()
  );
}

type ClaimedRow = {
  id: string;
  eventId: string;
  type: string;
  userId: string;
  aggregateType: string;
  aggregateId: string;
  payload: NotificationPayload;
  createdAt: Date;
};

/**
 * Raw SQL because the query builder cannot express FOR UPDATE SKIP LOCKED.
 * Values go through Prisma's tagged template, which parameterises them — this
 * is not string concatenation.
 */
async function claim(tx: TxClient, limit: number): Promise<ClaimedRow[]> {
  return tx.$queryRaw<ClaimedRow[]>`
    SELECT "id", "eventId", "type"::text AS "type", "userId",
           "aggregateType", "aggregateId", "payload", "createdAt"
    FROM "outbox_events"
    WHERE "publishedAt" IS NULL
    ORDER BY "createdAt"
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `;
}

function toEvent(row: ClaimedRow): NotificationEvent {
  return {
    eventId: row.eventId,
    type: row.type as NotificationEvent["type"],
    userId: row.userId,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: row.payload,
    occurredAt: row.createdAt.toISOString(),
  };
}

/**
 * Records a failed batch on the rows themselves.
 *
 * Runs AFTER the transaction rolled back, so it needs its own write — anything
 * done inside the failed transaction is gone with it. Best-effort: if this also
 * fails, the rows simply stay unpublished and are retried, which is the
 * behaviour that matters.
 *
 * Worth the extra write because a broker outage is otherwise visible only in a
 * log nobody is tailing, while `SELECT count(*) FROM outbox_events WHERE
 * "publishedAt" IS NULL` is the first thing anyone asks during an incident.
 */
async function recordFailure(ids: string[], err: unknown): Promise<void> {
  try {
    await prisma.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: {
        attempts: { increment: 1 },
        lastError: String(err instanceof Error ? err.message : err).slice(0, 500),
      },
    });
  } catch {
    // Deliberately silent. The rows are still unpublished, which is the part
    // that has to be true.
  }
}

export type RelayPassResult = { published: number; failed: number };

/**
 * One pass. Exported so the suite can drive the relay deterministically instead
 * of waiting on a timer.
 */
export async function relayOnce(batchSize = BATCH_SIZE): Promise<RelayPassResult> {
  let claimedIds: string[] = [];

  try {
    const published = await prisma.$transaction(
      async (tx) => {
        const rows = await claim(tx, batchSize);
        if (rows.length === 0) return 0;

        claimedIds = rows.map((r) => r.id);

        await getTransport().publish(rows.map(toEvent));

        await tx.outboxEvent.updateMany({
          where: { id: { in: claimedIds } },
          data: { publishedAt: new Date() },
        });

        return rows.length;
      },
      { timeout: TX_TIMEOUT_MS, maxWait: TX_TIMEOUT_MS }
    );

    return { published, failed: 0 };
  } catch (err) {
    console.error(`[relay] batch of ${claimedIds.length} failed to publish`, err);
    if (claimedIds.length > 0) await recordFailure(claimedIds, err);
    return { published: 0, failed: claimedIds.length };
  }
}

/**
 * Drains the backlog, then reports. Used at startup and by the suite; the loop
 * below calls relayOnce directly so a large backlog cannot starve the timer.
 */
export async function drain(): Promise<number> {
  let total = 0;
  for (;;) {
    const { published } = await relayOnce();
    if (published === 0) return total;
    total += published;
  }
}

/**
 * Starts the polling loop. Returns a stop function.
 *
 * Shaped like startOrderSweeper and startReservationSweeper — a timer that
 * refuses to overlap itself. The difference is what it means when it falls
 * behind: those two recover state nothing else can reach and are idle almost
 * always, while this one is on the critical path of every notification. That is
 * why it also runs as its own process (src/relay.ts) rather than only here.
 */
export function startRelay(intervalMs = DEFAULT_POLL_MS) {
  let running = false;

  const tick = async () => {
    // A pass that outlives its interval must not have a second one started on
    // top of it — two overlapping passes claim different rows and both hold
    // transactions open, which is how a slow broker turns into lock pressure.
    if (running) return;
    running = true;
    try {
      await relayOnce();
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Does not hold the process open on its own, matching the existing sweepers.
  timer.unref?.();

  return () => clearInterval(timer);
}
