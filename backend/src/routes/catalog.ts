import { Router } from "express";
import { z } from "zod";
import { cached, cachedMany } from "../lib/cache";
import {
  CATEGORIES_KEY,
  CATEGORY_TTL,
  LISTING_TTL,
  RATING_PREFIX,
  RATING_TTL,
  listingKey,
} from "../lib/cacheKeys";
import { prisma } from "../lib/prisma";
import { ratingBreakdown, verifiedBuyers } from "../lib/reviews";
import { livePlacements } from "../lib/placement";
import { ListingStatus, VerificationStatus } from "../generated/prisma/enums";

export const catalogRouter = Router();

/** Only listings that are actually buyable should ever surface in the catalog. */
const VISIBLE = { status: ListingStatus.ACTIVE, deletedAt: null } as const;

const listingInclude = {
  category: { select: { slug: true, title: true } },
  seller: { select: { shopName: true, kycStatus: true } },
  images: {
    orderBy: { position: "asc" as const },
    select: { url: true, alt: true, position: true },
  },
};

/**
 * Structural rather than derived from Prisma's generated namespace — it accepts
 * the query result either way and keeps this module readable.
 */
type ListingRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: string;
  condition: string;
  conditionNote: string | null;
  priceCents: number;
  originalPriceCents: number | null;
  currency: string;
  quantity: number;
  featured: boolean;
  createdAt: Date;
  category: { slug: string; title: string };
  seller: { shopName: string; kycStatus: string };
  images: { url: string; alt: string | null; position: number }[];
};

type RatingAgg = { average: number | null; count: number };

const NO_RATING: RatingAgg = { average: null, count: 0 };

/**
 * Ratings are computed from review rows rather than stored on the listing, so a
 * displayed score always traces back to real reviews. One grouped query covers
 * a whole page of results.
 *
 * EVERY REQUESTED ID GETS AN ENTRY, including listings with no reviews at all.
 *
 * groupBy only returns rows that have reviews, and most listings do not. Left
 * as-is, every one of them would be a cache MISS on each read — stored as a
 * negative with the short negative TTL, re-queried constantly, and the common
 * case would be the one the cache never helps with. Filling the gaps with
 * NO_RATING makes "this has no reviews" a cached fact like any other.
 */
async function loadRatings(listingIds: string[]): Promise<Map<string, RatingAgg>> {
  const grouped = await prisma.review.groupBy({
    by: ["listingId"],
    where: { listingId: { in: listingIds } },
    _avg: { rating: true },
    _count: { rating: true },
  });

  const withReviews = new Map(
    grouped.map((g) => [
      g.listingId,
      {
        average: g._avg.rating === null ? null : Math.round(g._avg.rating * 10) / 10,
        count: g._count.rating,
      },
    ])
  );

  return new Map(listingIds.map((id) => [id, withReviews.get(id) ?? NO_RATING]));
}

async function ratingsFor(listingIds: string[]): Promise<Map<string, RatingAgg>> {
  if (listingIds.length === 0) return new Map();
  return cachedMany<RatingAgg>(RATING_PREFIX, listingIds, RATING_TTL, loadRatings);
}

/** How long a listing reads as "new". A week, matching the badge's wording. */
const RECENTLY_LISTED_MS = 7 * 24 * 60 * 60 * 1000;

function serializeListing(row: ListingRow, rating: RatingAgg) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    condition: row.condition,
    conditionNote: row.conditionNote,
    priceCents: row.priceCents,
    originalPriceCents: row.originalPriceCents,
    currency: row.currency,
    quantity: row.quantity,
    // Exposed so a detail page can say "on hold" or "sold" instead of
    // pretending an unavailable item is buyable.
    status: row.status,
    featured: row.featured,
    createdAt: row.createdAt.toISOString(),
    /**
     * WHETHER THIS COUNTS AS RECENTLY LISTED — decided here, not in the UI.
     *
     * The card used to work it out with Date.now() during render, which makes
     * the component impure: a server render and a client hydration happen at
     * different instants, so a listing sitting near the boundary can produce
     * different markup in each and a hydration mismatch. It could not bite
     * while the card was only ever rendered on the server, and it was one
     * careless import away from doing so.
     *
     * Sent as a field because it is a fact the server knows and the client
     * should not be re-deriving. Same reasoning as `rating`: computed once,
     * server-side, rather than recalculated by every reader.
     */
    isNew: Date.now() - row.createdAt.getTime() < RECENTLY_LISTED_MS,
    category: row.category,
    seller: {
      shopName: row.seller.shopName,
      // Surfaced so buyers can see identity-verified sellers. Never exposes any
      // part of the underlying verification record.
      verified: row.seller.kycStatus === VerificationStatus.VERIFIED,
    },
    images: row.images,
    rating,
  };
}

/**
 * What is on the homepage because somebody agreed to pay for it.
 *
 * DELIBERATELY NOT CACHED, unlike every other read in this file. A placement
 * going live is a commercial commitment with a start time, and serving it from
 * a sixty-second cache means the thing somebody paid for is absent for the
 * first minute of the window they bought. The query is two indexed lookups on a
 * table with a handful of live rows.
 *
 * `livePlacements()` already excludes listings that are not ACTIVE, so a
 * promoted item that sells disappears here without anything having to notice.
 *
 * The response says `promoted: true` on every listing it returns. That flag is
 * what the card and the banner render their label from, and it travels with the
 * data rather than being inferred by the page — a client that forgets to set it
 * cannot accidentally render a paid placement as an editorial pick.
 *
 * See docs/adr/0034-paid-homepage-placement.md
 */
catalogRouter.get("/promoted", async (_req, res) => {
  try {
    const placements = await livePlacements();
    if (placements.length === 0) return res.json({ hero: null, shelf: [] });

    const rows = await prisma.listing.findMany({
      where: { id: { in: placements.map((p) => p.listingId) }, ...VISIBLE },
      include: listingInclude,
    });
    const ratings = await ratingsFor(rows.map((r) => r.id));
    const byId = new Map(
      rows.map((r) => [r.id, { ...serializeListing(r, ratings.get(r.id) ?? NO_RATING), promoted: true as const }])
    );

    const hero =
      placements
        .filter((p) => p.slot === "HERO")
        .map((p) => byId.get(p.listingId))
        .find((x) => x !== undefined) ?? null;

    const shelf = placements
      .filter((p) => p.slot === "PICKED_SHELF")
      .sort((a, b) => a.position - b.position)
      .map((p) => byId.get(p.listingId))
      .filter((x): x is NonNullable<typeof x> => x !== undefined);

    res.json({ hero, shelf });
  } catch (err) {
    console.error("GET /catalog/promoted failed", err);
    /**
     * An empty answer rather than a 500. The homepage is the busiest page on
     * the site and it has four other shelves that work; a merchandising table
     * being unreachable must not take it down.
     */
    res.json({ hero: null, shelf: [] });
  }
});

catalogRouter.get("/categories", async (_req, res) => {
  try {
    // Cached whole rather than per-category: it is one query producing one
    // response, and the shelf is read on nearly every page.
    const categories = await cached(CATEGORIES_KEY, CATEGORY_TTL, async () => {
      const rows = await prisma.category.findMany({
        orderBy: { position: "asc" },
        include: { _count: { select: { listings: { where: VISIBLE } } } },
      });

      return rows.map((c) => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        description: c.description,
        coverImage: c.coverImage,
        listingCount: c._count.listings,
      }));
    });

    res.json({ categories });
  } catch (err) {
    console.error("GET /catalog/categories failed", err);
    res.status(500).json({ error: "Could not load categories." });
  }
});

const CONDITIONS = ["LIKE_NEW", "GOOD", "WELL_LOVED", "NEEDS_REPAIR"] as const;

const listQuery = z.object({
  category: z.string().trim().max(64).optional(),
  condition: z.enum(CONDITIONS).optional(),
  // Prices arrive in whole currency units because that is what the filter UI
  // collects. Converted to integer minor units before touching the database.
  minPrice: z.coerce.number().min(0).max(1_000_000).optional(),
  maxPrice: z.coerce.number().min(0).max(1_000_000).optional(),
  q: z.string().trim().max(120).optional(),
  featured: z.enum(["true", "false"]).optional(),
  sort: z.enum(["newest", "price_asc", "price_desc"]).default("newest"),
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});

const ORDER_BY = {
  newest: [{ createdAt: "desc" as const }, { id: "asc" as const }],
  price_asc: [{ priceCents: "asc" as const }, { id: "asc" as const }],
  price_desc: [{ priceCents: "desc" as const }, { id: "asc" as const }],
};

catalogRouter.get("/listings", async (req, res) => {
  try {
    // The filter form submits unset fields as empty strings; treat those as absent
    // rather than rejecting the whole request.
    const cleaned = Object.fromEntries(
      Object.entries(req.query).filter(([, v]) => v !== "" && v !== undefined)
    );

    const parsed = listQuery.safeParse(cleaned);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid search parameters.", code: "INVALID_QUERY" });
    }

    const { category, condition, minPrice, maxPrice, q, featured, sort, page, limit } =
      parsed.data;

    if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
      return res.status(400).json({
        error: "Minimum price can't be higher than maximum price.",
        code: "INVALID_PRICE_RANGE",
        field: "minPrice",
      });
    }

    const where = {
      ...VISIBLE,
      ...(category ? { category: { slug: category } } : {}),
      ...(condition ? { condition } : {}),
      ...(featured ? { featured: featured === "true" } : {}),
      ...(minPrice !== undefined || maxPrice !== undefined
        ? {
            priceCents: {
              ...(minPrice !== undefined ? { gte: Math.round(minPrice * 100) } : {}),
              ...(maxPrice !== undefined ? { lte: Math.round(maxPrice * 100) } : {}),
            },
          }
        : {}),
      // Substring matching. Adequate at this scale; a Postgres tsvector index is
      // the upgrade path once the catalog is large enough to need ranking.
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" as const } },
              { description: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.listing.count({ where }),
      prisma.listing.findMany({
        where,
        include: listingInclude,
        orderBy: ORDER_BY[sort],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const ratings = await ratingsFor(rows.map((r) => r.id));

    res.json({
      listings: rows.map((r) => serializeListing(r, ratings.get(r.id) ?? NO_RATING)),
      total,
      page,
      limit,
      pageCount: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error("GET /catalog/listings failed", err);
    res.status(500).json({ error: "Could not load listings." });
  }
});

/**
 * The whole detail payload for one listing, or null if there is nothing to show.
 *
 * Extracted so the route is a cache lookup and this is the loader. Returning
 * null rather than throwing for "not found" is what lets the miss be cached
 * too — a crawler walking unknown slugs would otherwise reach the database on
 * every single request while the cache reported a perfect hit rate.
 *
 * SIX QUERIES, which is why this is worth caching at all: the listing, its
 * rating, its star breakdown, which reviewers actually bought it, four related
 * listings, and their ratings.
 *
 * The payload is the same for every viewer — `authorId` is sent so the client
 * can mark the reader's own review, rather than the server deciding — so one
 * cached copy serves everyone. A payload that varied by viewer would need the
 * viewer in the key, and at that point it is not worth caching.
 */
async function buildListingDetail(slug: string) {
    // Detail pages stay reachable once an item is held or sold — a buyer who
    // holds the last one must still be able to open its page, and a public URL
    // that 404s the moment stock runs out is a broken link. Lists and search
    // continue to show only ACTIVE.
    const row = await prisma.listing.findFirst({
      where: {
        slug,
        deletedAt: null,
        status: {
          in: [ListingStatus.ACTIVE, ListingStatus.RESERVED, ListingStatus.SOLD],
        },
      },
      include: {
        ...listingInclude,
        reviews: {
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            id: true,
            rating: true,
            body: true,
            createdAt: true,
            updatedAt: true,
            // Sent so the viewer's own review can be marked and made editable
            // in place, rather than making them hunt for it in the account area.
            authorId: true,
            author: { select: { name: true } },
          },
        },
      },
    });

    if (!row) return null;

    const ratings = await ratingsFor([row.id]);
    const breakdown = await ratingBreakdown(row.id);
    const verifiedAuthors = await verifiedBuyers(
      row.id,
      row.reviews.map((r) => r.authorId)
    );

    const related = await prisma.listing.findMany({
      where: { ...VISIBLE, categoryId: row.categoryId, id: { not: row.id } },
      include: listingInclude,
      orderBy: { createdAt: "desc" },
      take: 4,
    });
    const relatedRatings = await ratingsFor(related.map((r) => r.id));

    return {
      listing: {
        ...serializeListing(row, ratings.get(row.id) ?? NO_RATING),
        /**
         * How the stars are distributed. An average hides the shape: 3.0 from
         * twenty 3s and 3.0 from ten 5s and ten 1s are very different things
         * to buy from, and on a secondhand marketplace that gap is most of the
         * signal.
         */
        ratingBreakdown: breakdown,
        reviews: row.reviews.map((r) => ({
          id: r.id,
          rating: r.rating,
          body: r.body,
          createdAt: r.createdAt.toISOString(),
          edited: r.updatedAt.getTime() - r.createdAt.getTime() > 1000,
          authorId: r.authorId,
          authorName: r.author.name,
          /**
           * Computed against real paid orders rather than assumed. Reviews
           * written through this API always qualify — it refuses otherwise —
           * but seeded and imported rows do not, and a badge that isn't earned
           * devalues every badge on the site.
           */
          verified: verifiedAuthors.has(r.authorId),
        })),
      },
      related: related.map((r) =>
        serializeListing(r, relatedRatings.get(r.id) ?? NO_RATING)
      ),
    };
}

catalogRouter.get("/listings/:slug", async (req, res) => {
  try {
    const body = await cached(listingKey(req.params.slug), LISTING_TTL, () =>
      buildListingDetail(req.params.slug)
    );

    if (!body) {
      return res.status(404).json({ error: "Listing not found.", code: "NOT_FOUND" });
    }

    res.json(body);
  } catch (err) {
    console.error("GET /catalog/listings/:slug failed", err);
    res.status(500).json({ error: "Could not load listing." });
  }
});
