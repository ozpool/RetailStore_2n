import { prisma } from "./prisma";
import { ListingStatus } from "../generated/prisma/enums";

/**
 * Saved listings.
 *
 * The whole point of this feature is that it is inert: saving something must
 * not reserve it, hide it, or change what anyone else sees. Two people can
 * save the same one-of-a-kind chair, and neither has claimed anything. That is
 * why none of this touches Listing.status or quantity — compare
 * lib/reservations.ts, which exists precisely to commit stock.
 *
 * IDEMPOTENCY
 * save() and remove() both succeed when the item is already in that state. A
 * heart is easy to double-tap and easy to open in two tabs, so "already saved"
 * is normal traffic rather than an error worth showing anyone.
 */

const listingSelect = {
  id: true,
  slug: true,
  title: true,
  priceCents: true,
  originalPriceCents: true,
  currency: true,
  condition: true,
  conditionNote: true,
  status: true,
  quantity: true,
  deletedAt: true,
  images: { orderBy: { position: "asc" as const }, take: 1, select: { url: true, alt: true } },
  seller: { select: { shopName: true } },
};

type Row = {
  id: string;
  createdAt: Date;
  listing: {
    id: string;
    slug: string;
    title: string;
    priceCents: number;
    originalPriceCents: number | null;
    currency: string;
    condition: string;
    conditionNote: string | null;
    status: string;
    quantity: number;
    deletedAt: Date | null;
    images: { url: string; alt: string | null }[];
    seller: { shopName: string };
  };
};

function serialize(row: Row) {
  const l = row.listing;
  const sold = l.status === ListingStatus.SOLD;

  return {
    id: row.id,
    savedAt: row.createdAt.toISOString(),
    listing: {
      id: l.id,
      slug: l.slug,
      title: l.title,
      priceCents: l.priceCents,
      originalPriceCents: l.originalPriceCents,
      currency: l.currency,
      condition: l.condition,
      conditionNote: l.conditionNote,
      image: l.images[0]?.url ?? null,
      imageAlt: l.images[0]?.alt ?? null,
      sellerName: l.seller.shopName,
      /**
       * A saved listing can sell, be delisted, or be withdrawn by its seller.
       * Removing it from the wishlist silently would be worse than saying so —
       * the buyer wants to know the thing they were considering has gone, not
       * to quietly find one fewer item than they remember.
       */
      sold,
      available:
        l.deletedAt === null && !sold && l.status === ListingStatus.ACTIVE && l.quantity > 0,
    },
  };
}

export type WishlistEntry = ReturnType<typeof serialize>;

export async function listWishlist(userId: string) {
  const rows = await prisma.wishlistItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, createdAt: true, listing: { select: listingSelect } },
  });

  return rows.map((row) => serialize(row as Row));
}

/**
 * Just the ids.
 *
 * The catalog renders a heart on every tile, so the alternative is either one
 * request per card or shipping the whole wishlist to draw a grid. Ids are all
 * the grid needs.
 */
export async function listWishlistIds(userId: string): Promise<string[]> {
  const rows = await prisma.wishlistItem.findMany({
    where: { userId },
    select: { listingId: true },
  });
  return rows.map((r) => r.listingId);
}

export async function isSaved(userId: string, listingId: string) {
  const row = await prisma.wishlistItem.findUnique({
    where: { userId_listingId: { userId, listingId } },
    select: { id: true },
  });
  return row !== null;
}

export class WishlistError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "WishlistError";
    this.code = code;
    this.status = status;
  }
}

/** Saves a listing. Already-saved is a success, not a conflict. */
export async function save(userId: string, listingId: string) {
  const listing = await prisma.listing.findFirst({
    where: { id: listingId, deletedAt: null },
    select: { id: true },
  });
  if (!listing) {
    throw new WishlistError("NOT_FOUND", "That listing doesn't exist.", 404);
  }

  /**
   * upsert first, and treat a unique violation as success.
   *
   * The upsert alone was assumed to be enough — the comment here used to claim
   * that two simultaneous saves "produce one row rather than a duplicate or a
   * crash". They do produce one row, but the loser of the race CRASHES: Prisma's
   * upsert does not always compile to INSERT ... ON CONFLICT, so both callers
   * can find no row and both attempt the insert. Running the suite against the
   * containers surfaced it as a 500 on concurrent saves; it had never triggered
   * on the host, which is what a race does.
   *
   * Catching the violation is the correct answer rather than a workaround. The
   * operation is idempotent by design — PUT, not POST — and "somebody else
   * inserted the row I was about to insert" is the outcome this endpoint wanted.
   */
  try {
    await prisma.wishlistItem.upsert({
      where: { userId_listingId: { userId, listingId } },
      create: { userId, listingId },
      update: {},
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

/**
 * Whether an error is "that row already exists".
 *
 * Checks the Prisma code AND the driver-adapter error text. Prisma 7 with
 * driver adapters surfaces this as a DriverAdapterError wrapping
 * `UniqueConstraintViolation`, which does not always carry the P2002 code that
 * the engine-based client used to set — so testing only for P2002 misses it.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; message?: string };
  if (e.code === "P2002") return true;
  return /unique.?constraint/i.test(e.message ?? "");
}

/** Removes a listing. Not-saved is a success too. */
export async function remove(userId: string, listingId: string) {
  await prisma.wishlistItem.deleteMany({ where: { userId, listingId } });
}

export function countWishlist(userId: string) {
  return prisma.wishlistItem.count({ where: { userId } });
}
