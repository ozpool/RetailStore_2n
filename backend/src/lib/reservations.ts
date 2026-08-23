import { prisma } from "./prisma";
import { ListingStatus, ReservationStatus } from "../generated/prisma/enums";

/**
 * Stock holds, serialised with row-level locking.
 *
 * THE RACE
 * Almost every listing here is quantity 1. Two buyers pressing "reserve" at the
 * same moment both read `status = ACTIVE, quantity = 1`, both decide it's
 * available, and both write — selling one object twice. Read-then-write across
 * two statements is not atomic no matter how fast it is.
 *
 * THE FIX
 * `SELECT … FOR UPDATE` inside a transaction takes an exclusive lock on the
 * listing row. A second transaction touching the same row blocks until the
 * first commits, then reads the *updated* state and correctly sees no stock.
 * Concurrency on a given listing becomes strictly serial; different listings
 * are unaffected because the lock is per row.
 *
 * WHY NOT A CONDITIONAL UPDATE
 * For a bare status flip, `UPDATE … WHERE status = 'ACTIVE'` plus a rowcount
 * check is atomic on its own and needs no explicit lock — and it would be the
 * better choice for that. It isn't enough here: reserving has to read stock,
 * reclaim anything expired, decide availability, decrement, and insert a
 * reservation row, all as one indivisible step. That is what a lock is for.
 *
 * LOCK ORDERING
 * Every path locks the listing row first and only then touches reservations.
 * A single, consistent order is what keeps this deadlock-free.
 */

/** Short by design: an abandoned checkout should return stock quickly. */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

/** Guards against a transaction sitting on a lock forever under contention. */
export const TX_OPTIONS = { timeout: 10_000, maxWait: 10_000 };

export class ReservationError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "ReservationError";
    this.code = code;
    this.status = status;
  }
}

export type LockedListing = {
  id: string;
  quantity: number;
  status: string;
  sellerId: string;
  deletedAt: Date | null;
};

/**
 * Takes the row lock and returns the listing's committed state.
 *
 * Values are interpolated through Prisma's tagged template, which parameterises
 * them — this is not string concatenation. Raw SQL is used only because the
 * query builder cannot express FOR UPDATE.
 */
export async function lockListing(
  tx: Pick<typeof prisma, "$queryRaw">,
  listingId: string
): Promise<LockedListing | null> {
  const rows = await tx.$queryRaw<LockedListing[]>`
    SELECT "id", "quantity", "status"::text AS "status", "sellerId", "deletedAt"
    FROM "listings"
    WHERE "id" = ${listingId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Returns stock from holds that have timed out.
 *
 * Called while the listing row is locked, so a reservation attempt always sees
 * up-to-date availability. This is NOT sufficient on its own: a fully-held
 * listing is hidden from the catalog, so nobody can trigger this path for it.
 * releaseExpiredHolds() below is what actually recovers that stock.
 */
async function reclaimExpired(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  listingId: string,
  now: Date
): Promise<number> {
  const expired = await tx.reservation.findMany({
    where: { listingId, status: ReservationStatus.HELD, expiresAt: { lte: now } },
    select: { id: true, quantity: true },
  });

  if (expired.length === 0) return 0;

  await tx.reservation.updateMany({
    where: { id: { in: expired.map((r) => r.id) } },
    data: { status: ReservationStatus.EXPIRED, releasedAt: now },
  });

  return expired.reduce((sum, r) => sum + r.quantity, 0);
}

export type ReservationResult = {
  id: string;
  listingId: string;
  quantity: number;
  expiresAt: Date;
  remainingQuantity: number;
};

export async function reserveListing(input: {
  userId: string;
  listingId: string;
  quantity: number;
}): Promise<ReservationResult> {
  const { userId, listingId, quantity } = input;

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new ReservationError("INVALID_QUANTITY", "Quantity must be at least 1.", 400);
  }

  return prisma.$transaction(async (tx) => {
    const now = new Date();

    // Everything below happens while this row is locked.
    const listing = await lockListing(tx, listingId);

    if (!listing || listing.deletedAt !== null) {
      throw new ReservationError("NOT_FOUND", "Listing not found.", 404);
    }
    if (listing.sellerId) {
      const owner = await tx.sellerProfile.findUnique({
        where: { id: listing.sellerId },
        select: { userId: true },
      });
      if (owner?.userId === userId) {
        throw new ReservationError(
          "OWN_LISTING",
          "You can't reserve your own listing.",
          400
        );
      }
    }

    const reclaimed = await reclaimExpired(tx, listingId, now);
    const available = listing.quantity + reclaimed;

    // Checked before stock: a buyer who already holds this needs to hear that,
    // not "someone else took the last one" — which would be untrue, because the
    // someone else is them.
    const existing = await tx.reservation.findFirst({
      where: { listingId, userId, status: ReservationStatus.HELD },
      select: { id: true },
    });
    if (existing) {
      throw new ReservationError(
        "ALREADY_HELD",
        "You already have this item on hold."
      );
    }

    // ACTIVE and RESERVED both mean "listed for sale"; RESERVED only says stock
    // is currently held, so availability is a stock question rather than a
    // status one. Anything else is genuinely not for sale.
    if (listing.status === ListingStatus.SOLD) {
      throw new ReservationError("UNAVAILABLE", "That item has already sold.");
    }
    if (
      listing.status !== ListingStatus.ACTIVE &&
      listing.status !== ListingStatus.RESERVED
    ) {
      throw new ReservationError("UNAVAILABLE", "That item isn't available right now.");
    }

    if (available < quantity) {
      throw new ReservationError(
        "INSUFFICIENT_STOCK",
        available === 0
          ? "Someone else just reserved the last one."
          : `Only ${available} left.`
      );
    }

    const remaining = available - quantity;

    await tx.listing.update({
      where: { id: listingId },
      data: {
        quantity: remaining,
        // No stock left means nobody else should see it as buyable, but it is
        // not SOLD until money moves.
        status: remaining === 0 ? ListingStatus.RESERVED : ListingStatus.ACTIVE,
      },
    });

    const reservation = await tx.reservation.create({
      data: {
        listingId,
        userId,
        quantity,
        status: ReservationStatus.HELD,
        expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS),
      },
      select: { id: true, quantity: true, expiresAt: true },
    });

    return {
      id: reservation.id,
      listingId,
      quantity: reservation.quantity,
      expiresAt: reservation.expiresAt,
      remainingQuantity: remaining,
    };
  }, TX_OPTIONS);
}

export async function releaseReservation(input: {
  userId: string;
  reservationId: string;
}): Promise<void> {
  const { userId, reservationId } = input;

  await prisma.$transaction(async (tx) => {
    const reservation = await tx.reservation.findFirst({
      where: { id: reservationId, userId },
      select: { id: true, listingId: true, quantity: true, status: true },
    });

    if (!reservation) {
      throw new ReservationError("NOT_FOUND", "Reservation not found.", 404);
    }
    if (reservation.status !== ReservationStatus.HELD) {
      throw new ReservationError(
        "NOT_HELD",
        "That hold is no longer active."
      );
    }

    // Same order as reserveListing: listing row first.
    const listing = await lockListing(tx, reservation.listingId);
    if (!listing) {
      throw new ReservationError("NOT_FOUND", "Listing not found.", 404);
    }

    const now = new Date();
    const restored = listing.quantity + reservation.quantity;

    await tx.reservation.update({
      where: { id: reservation.id },
      data: { status: ReservationStatus.RELEASED, releasedAt: now },
    });

    await tx.listing.update({
      where: { id: reservation.listingId },
      data: {
        quantity: restored,
        // Returning stock makes it buyable again, unless it has since sold.
        status:
          listing.status === ListingStatus.SOLD
            ? ListingStatus.SOLD
            : ListingStatus.ACTIVE,
      },
    });
  }, TX_OPTIONS);
}

export async function listMyReservations(userId: string) {
  const now = new Date();
  return prisma.reservation.findMany({
    where: { userId, status: ReservationStatus.HELD, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      listingId: true,
      quantity: true,
      expiresAt: true,
      createdAt: true,
      listing: {
        select: {
          slug: true,
          title: true,
          priceCents: true,
          currency: true,
          images: { orderBy: { position: "asc" }, take: 1, select: { url: true } },
        },
      },
    },
  });
}

/**
 * Releases every hold that has passed its expiry, returning the stock.
 *
 * WHY THIS HAS TO EXIST
 * Reclaim also happens lazily inside reserveListing, and ADR 0012 originally
 * called this sweeper "an optimisation, not a fix". That was wrong, and it
 * deadlocked in practice:
 *
 *   1. the last unit of a listing is held, so status flips to RESERVED
 *   2. RESERVED listings are excluded from the catalog
 *   3. the hold expires — but nobody can attempt to reserve a listing they
 *      cannot see, so the lazy reclaim inside reserveListing never runs
 *   4. the listing stays invisible forever
 *
 * Availability that can only be restored by someone requesting the very thing
 * that is hidden is not recoverable. It needs an external trigger.
 *
 * Locks each listing row before adjusting stock, in the same order as every
 * other path here, so it cannot deadlock against a live reservation.
 */
export async function releaseExpiredHolds(): Promise<number> {
  const now = new Date();

  const expired = await prisma.reservation.findMany({
    where: { status: ReservationStatus.HELD, expiresAt: { lte: now } },
    select: { id: true, listingId: true, quantity: true },
  });

  let released = 0;

  for (const hold of expired) {
    try {
      await prisma.$transaction(async (tx) => {
        const listing = await lockListing(tx, hold.listingId);
        if (!listing) return;

        // Re-read under the lock: a concurrent reserveListing may have already
        // reclaimed this one between the query above and the lock.
        const still = await tx.reservation.findFirst({
          where: { id: hold.id, status: ReservationStatus.HELD },
          select: { id: true, quantity: true },
        });
        if (!still) return;

        await tx.reservation.update({
          where: { id: still.id },
          data: { status: ReservationStatus.EXPIRED, releasedAt: now },
        });

        const restored = listing.quantity + still.quantity;
        await tx.listing.update({
          where: { id: hold.listingId },
          data: {
            quantity: restored,
            // Back on sale unless it sold in the meantime.
            status:
              listing.status === ListingStatus.SOLD
                ? ListingStatus.SOLD
                : ListingStatus.ACTIVE,
          },
        });

        released++;
      }, TX_OPTIONS);
    } catch (err) {
      // One stuck listing must not stop the rest of the sweep.
      console.error(`Failed to release expired hold ${hold.id}`, err);
    }
  }

  return released;
}

/** Runs the sweep on an interval. Returns a stop function. */
export function startReservationSweeper(intervalMs = 60_000) {
  async function tick() {
    try {
      const n = await releaseExpiredHolds();
      if (n > 0) console.log(`Reservation sweeper released ${n} expired hold(s)`);
    } catch (err) {
      console.error("Reservation sweeper failed", err);
    }
  }

  void tick();
  const timer = setInterval(tick, intervalMs);
  // Don't hold the process open on shutdown.
  timer.unref?.();
  return () => clearInterval(timer);
}
