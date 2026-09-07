import { prisma } from "./prisma";

/**
 * Deletes outbox rows that have been published and are past their usefulness.
 *
 * WHY THIS IS NEEDED AT ALL
 * `outbox_events` gets one row per notification, forever. Nothing has ever
 * removed them, and the table is on the write path of every sale, shipment,
 * refund and moderation action — so it grows without bound and takes its
 * indexes with it. The data-model doc has said "published rows are never pruned
 * yet" since the outbox landed. This is that.
 *
 * WHY SEVEN DAYS, AND WHY THAT NUMBER IS NOT ARBITRARY
 * It matches the main topic's retention (ADR 0025). A published outbox row has
 * exactly one remaining use: republishing an event Kafka somehow lost. Once the
 * broker has itself dropped the message, that use is gone — the event cannot be
 * replayed into a topic that no longer holds its neighbours, and the delivery
 * ledger is what answers "was this sent" from then on.
 *
 * Keeping them longer would not be safer, only bigger.
 *
 * UNPUBLISHED ROWS ARE NEVER TOUCHED, AT ANY AGE. A row with a null
 * `publishedAt` is work still owed. If one is a month old that is a bug worth
 * finding, and deleting it would destroy the evidence and the notification at
 * the same time.
 */

function retentionMs(): number {
  const hours = Number(process.env.OUTBOX_RETENTION_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 168) * 3600_000;
}

/**
 * Rows per pass.
 *
 * Bounded because the first run on a table that has never been pruned could
 * otherwise be a single DELETE over millions of rows — one long transaction,
 * one long lock, on a table every checkout writes to. Several small passes are
 * slower in total and invisible to everything else, which is the right trade
 * for a background job.
 */
const BATCH = 1000;

export type PruneResult = { deleted: number; oldestKept: Date | null };

/** One pass. Exported so a test can drive it without waiting on a timer. */
export async function pruneOutboxOnce(now: Date = new Date()): Promise<PruneResult> {
  const cutoff = new Date(now.getTime() - retentionMs());

  /**
   * Selected then deleted by id, rather than a single conditional DELETE.
   *
   * `deleteMany` has no LIMIT, so bounding the batch needs the ids first. The
   * extra round trip is what keeps the lock short.
   */
  const doomed = await prisma.outboxEvent.findMany({
    where: { publishedAt: { not: null, lt: cutoff } },
    select: { id: true },
    take: BATCH,
    orderBy: { createdAt: "asc" },
  });

  if (doomed.length === 0) {
    const oldest = await prisma.outboxEvent.findFirst({
      where: { publishedAt: { not: null } },
      select: { publishedAt: true },
      orderBy: { publishedAt: "asc" },
    });
    return { deleted: 0, oldestKept: oldest?.publishedAt ?? null };
  }

  const { count } = await prisma.outboxEvent.deleteMany({
    where: { id: { in: doomed.map((d) => d.id) } },
  });

  return { deleted: count, oldestKept: null };
}

/** Drains the whole backlog, a batch at a time. */
export async function pruneOutbox(now: Date = new Date()): Promise<number> {
  let total = 0;
  for (;;) {
    const { deleted } = await pruneOutboxOnce(now);
    if (deleted === 0) return total;
    total += deleted;
  }
}

/**
 * Hourly, not per-minute.
 *
 * The retention window is measured in days, so checking sixty times an hour
 * would be sixty queries to discover nothing has aged out. Unlike the
 * reservation and order sweepers, nothing is waiting on this.
 */
export function startOutboxRetentionSweeper(intervalMs = 3600_000) {
  async function tick() {
    try {
      const deleted = await pruneOutbox();
      if (deleted > 0) console.log(`Outbox retention pruned ${deleted} published row(s)`);
    } catch (err) {
      console.error("Outbox retention sweeper failed", err);
    }
  }

  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
