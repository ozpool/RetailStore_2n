import { invalidate, invalidateMany } from "./cache";
import { RATING_PREFIX, listingKey } from "./cacheKeys";
import { prisma } from "./prisma";
import { events } from "./notifications";
import { OrderStatus } from "../generated/prisma/enums";

/**
 * Reviews.
 *
 * VERIFIED PURCHASE ONLY
 * A review can only be written by someone with a PAID order containing that
 * listing. This is not politeness — an open review box on a marketplace is a
 * reputation weapon: competitors bury each other, sellers inflate themselves,
 * and the star ratings that gate a buyer's decision stop meaning anything.
 * Tying a review to a purchase is the cheapest defence that actually works,
 * and it is why every listing's rating on this site traces back to money that
 * changed hands.
 *
 * The trade is that reviews are rare early on, and the empty state has to be
 * honest about why rather than looking broken.
 *
 * ONE REVIEW PER PERSON PER LISTING
 * Enforced by a unique index on [listingId, authorId], not by checking first
 * and inserting after — the same read-then-write race as everywhere else.
 * Writing again edits the existing review rather than adding a second.
 */

export const MAX_BODY = 2000;

export class ReviewError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
    this.status = status;
  }
}

export type Eligibility = {
  canReview: boolean;
  /** Why not, in words the buyer can act on. */
  reason: string | null;
  code: "OK" | "NOT_PURCHASED" | "OWN_LISTING" | "GONE";
  /** The review this person already wrote, if any. */
  mine: {
    id: string;
    rating: number;
    body: string | null;
    createdAt: string;
    updatedAt: string;
    edited: boolean;
  } | null;
};

/** Did this person actually buy this listing? */
export async function hasPurchased(userId: string, listingId: string) {
  const item = await prisma.orderItem.findFirst({
    where: {
      listingId,
      order: { buyerId: userId, status: OrderStatus.PAID },
    },
    select: { id: true },
  });
  return item !== null;
}

export async function eligibility(userId: string, listingId: string): Promise<Eligibility> {
  const listing = await prisma.listing.findFirst({
    where: { id: listingId, deletedAt: null },
    select: { id: true, seller: { select: { userId: true } } },
  });

  const existing = await prisma.review.findUnique({
    where: { listingId_authorId: { listingId, authorId: userId } },
    select: { id: true, rating: true, body: true, createdAt: true, updatedAt: true },
  });

  const mine = existing
    ? {
        id: existing.id,
        rating: existing.rating,
        body: existing.body,
        createdAt: existing.createdAt.toISOString(),
        updatedAt: existing.updatedAt.toISOString(),
        // A second of slack: createdAt and updatedAt are written microseconds
        // apart on insert and are not exactly equal.
        edited: existing.updatedAt.getTime() - existing.createdAt.getTime() > 1000,
      }
    : null;

  if (!listing) {
    return { canReview: false, code: "GONE", reason: "That listing is no longer here.", mine };
  }

  if (listing.seller.userId === userId) {
    return {
      canReview: false,
      code: "OWN_LISTING",
      reason: "You can't review your own listing.",
      mine,
    };
  }

  if (!(await hasPurchased(userId, listingId))) {
    return {
      canReview: false,
      code: "NOT_PURCHASED",
      reason: "Reviews come from buyers, so you can write one once you've bought this.",
      mine,
    };
  }

  return { canReview: true, code: "OK", reason: null, mine };
}

function validate(rating: number, body: string | null) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ReviewError("INVALID_RATING", "Choose a rating from 1 to 5 stars.");
  }
  if (body !== null && body.length > MAX_BODY) {
    throw new ReviewError("BODY_TOO_LONG", `Keep it under ${MAX_BODY} characters.`);
  }
}

/**
 * Writes a review, or updates the one this person already left.
 *
 * An upsert rather than create-then-handle-conflict: two taps on Post are a
 * normal thing for a person to do, and the second must not be an error.
 */
/**
 * Drops everything a review write makes stale.
 *
 * TWO KEYS, NOT ONE. The obvious one is the rating aggregate. The other is the
 * listing's detail payload, which embeds the twenty most recent reviews AND the
 * star breakdown — so writing a review that does not clear it leaves the new
 * review invisible on the very page it was written from, which reads as the
 * write having failed.
 *
 * Called after the database write, never before: a concurrent read between an
 * early invalidation and the commit would repopulate both keys from the old
 * state, and the stale copy would outlive the write meant to clear it.
 */
async function dropReviewCaches(listingId: string, slug: string) {
  await Promise.all([
    invalidateMany(RATING_PREFIX, [listingId]),
    invalidate(listingKey(slug)),
  ]);
}

export async function upsertReview(input: {
  userId: string;
  listingId: string;
  rating: number;
  body: string | null;
}) {
  const trimmed = input.body?.trim() ? input.body.trim() : null;
  validate(input.rating, trimmed);

  const check = await eligibility(input.userId, input.listingId);
  if (!check.canReview) {
    throw new ReviewError(
      check.code,
      check.reason ?? "You can't review that.",
      check.code === "GONE" ? 404 : 403
    );
  }

  const existed = check.mine !== null;

  const review = await prisma.review.upsert({
    where: { listingId_authorId: { listingId: input.listingId, authorId: input.userId } },
    create: {
      listingId: input.listingId,
      authorId: input.userId,
      rating: input.rating,
      body: trimmed,
    },
    update: { rating: input.rating, body: trimmed },
    select: {
      id: true,
      rating: true,
      body: true,
      createdAt: true,
      updatedAt: true,
      author: { select: { name: true } },
      listing: {
        select: { title: true, slug: true, seller: { select: { userId: true } } },
      },
    },
  });

  // Only on a new review. Editing your own wording is not news to the seller,
  // and notifying on every keystroke-level change is how a bell becomes noise.
  if (!existed && review.listing.seller?.userId) {
    void events.reviewReceived({
      sellerUserId: review.listing.seller.userId,
      itemTitle: review.listing.title,
      rating: review.rating,
      listingSlug: review.listing.slug,
    });
  }

  await dropReviewCaches(input.listingId, review.listing.slug);

  return review;
}

/** Edits a review by id. Scoped to the author, so nobody edits someone else's. */
export async function editReview(input: {
  userId: string;
  reviewId: string;
  rating: number;
  body: string | null;
}) {
  const trimmed = input.body?.trim() ? input.body.trim() : null;
  validate(input.rating, trimmed);

  // 404 rather than 403 for someone else's review: confirming it exists tells
  // an attacker something they shouldn't learn.
  const existing = await prisma.review.findFirst({
    where: { id: input.reviewId, authorId: input.userId },
    // listingId and slug come back so the caches keyed on them can be dropped
    // after the update. Both are needed: one keys the rating, the other the
    // listing page that renders it.
    select: { id: true, listingId: true, listing: { select: { slug: true } } },
  });
  if (!existing) {
    throw new ReviewError("NOT_FOUND", "Review not found.", 404);
  }

  const updated = await prisma.review.update({
    where: { id: existing.id },
    data: { rating: input.rating, body: trimmed },
    select: { id: true, rating: true, body: true, createdAt: true, updatedAt: true },
  });

  await dropReviewCaches(existing.listingId, existing.listing.slug);

  return updated;
}

export async function deleteReview(userId: string, reviewId: string) {
  /**
   * Read before the delete, rather than a single scoped deleteMany.
   *
   * deleteMany returns a count and nothing else, and once the row is gone there
   * is no way to learn which listing it belonged to — so there is nothing left
   * to invalidate, and the rating would stay stale for its full TTL with the
   * review already gone from the page.
   *
   * Still scoped to the author, so the 404-rather-than-403 behaviour is
   * unchanged: someone else's review is indistinguishable from a missing one.
   */
  const existing = await prisma.review.findFirst({
    where: { id: reviewId, authorId: userId },
    select: { id: true, listingId: true, listing: { select: { slug: true } } },
  });
  if (!existing) {
    throw new ReviewError("NOT_FOUND", "Review not found.", 404);
  }

  await prisma.review.delete({ where: { id: existing.id } });
  await dropReviewCaches(existing.listingId, existing.listing.slug);
}

/**
 * How the stars are distributed for one listing.
 *
 * An average alone hides the shape: 3.0 from twenty 3s and 3.0 from ten 5s and
 * ten 1s are very different things to buy from, and on a secondhand marketplace
 * that difference is most of the signal.
 */
export async function ratingBreakdown(listingId: string) {
  const grouped = await prisma.review.groupBy({
    by: ["rating"],
    where: { listingId },
    _count: { rating: true },
  });

  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const g of grouped) counts[g.rating] = g._count.rating;
  return counts;
}

/**
 * Which of these authors actually bought this listing.
 *
 * The API refuses to create a review without a paid order, so anything written
 * through it is verified by construction. Seeded and imported rows are not, and
 * a "Verified purchase" badge printed next to a review nobody paid for is
 * exactly the kind of claim that makes every other badge on the site worthless.
 * So it is computed, not assumed — one query for a whole page of reviews.
 */
export async function verifiedBuyers(
  listingId: string,
  authorIds: string[]
): Promise<Set<string>> {
  if (authorIds.length === 0) return new Set();

  const items = await prisma.orderItem.findMany({
    where: {
      listingId,
      order: { status: OrderStatus.PAID, buyerId: { in: authorIds } },
    },
    select: { order: { select: { buyerId: true } } },
  });

  return new Set(items.map((i) => i.order.buyerId));
}

/** Reviews for a listing, newest first. */
export async function listReviews(listingId: string, take = 20, skip = 0) {
  const [rows, total] = await Promise.all([
    prisma.review.findMany({
      where: { listingId },
      orderBy: { createdAt: "desc" },
      take,
      skip,
      select: {
        id: true,
        rating: true,
        body: true,
        createdAt: true,
        updatedAt: true,
        authorId: true,
        author: { select: { name: true } },
      },
    }),
    prisma.review.count({ where: { listingId } }),
  ]);

  const verified = await verifiedBuyers(listingId, rows.map((r) => r.authorId));

  return {
    total,
    reviews: rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
      edited: r.updatedAt.getTime() - r.createdAt.getTime() > 1000,
      authorId: r.authorId,
      authorName: r.author.name,
      verified: verified.has(r.authorId),
    })),
  };
}
