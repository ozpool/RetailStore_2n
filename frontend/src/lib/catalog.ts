/**
 * Server-side catalog access. These run in Next.js server components, which
 * talk to the Express backend server-to-server — the Next server *is* the BFF,
 * so there's no reason to bounce a public catalog read through our own route
 * handler first. Browser-side reads (the filter panel) go via /api instead.
 */

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:4000";

export type CatalogCategory = {
  id: string;
  slug: string;
  title: string;
  description: string;
  coverImage: string;
  listingCount: number;
};

export type CatalogListing = {
  id: string;
  slug: string;
  title: string;
  description: string;
  condition: string;
  conditionNote: string | null;
  priceCents: number;
  originalPriceCents: number | null;
  currency: string;
  quantity: number;
  status: string;
  featured: boolean;
  createdAt: string;
  /**
   * Listed within the last week, decided by the API.
   *
   * Not derived here from createdAt: that needs the current time, and reading
   * the clock while rendering makes a component impure — the server and the
   * client see different instants, and a listing near the boundary produces a
   * hydration mismatch.
   */
  isNew: boolean;
  category: { slug: string; title: string };
  seller: { shopName: string; verified: boolean };
  images: { url: string; alt: string | null; position: number }[];
  rating: { average: number | null; count: number };
  /**
   * On the homepage because a seller agreed to pay for the slot.
   *
   * Set by the API, never by a page. Wherever it is true the card and the
   * banner render a "Promoted" label, which is not a styling choice: paid
   * placement presented as editorial selection is deceptive advertising.
   * See docs/adr/0034-paid-homepage-placement.md
   */
  promoted?: boolean;
};

export type CatalogReview = {
  id: string;
  rating: number;
  body: string | null;
  createdAt: string;
  edited: boolean;
  /** So the viewer's own review can be marked and edited where it sits. */
  authorId: string;
  authorName: string;
  /** Backed by a real paid order. Computed server-side, never assumed. */
  verified: boolean;
};

export type ListingPage = {
  listings: CatalogListing[];
  total: number;
  page: number;
  limit: number;
  pageCount: number;
};

export type ListingQuery = {
  category?: string;
  condition?: string;
  minPrice?: string | number;
  maxPrice?: string | number;
  q?: string;
  featured?: "true" | "false";
  sort?: "newest" | "price_asc" | "price_desc";
  page?: string | number;
  limit?: string | number;
};

/** Inventory changes whenever a seller lists something, so don't serve it stale. */
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, { cache: "no-store" });

  if (!res.ok) {
    throw new Error(`Backend ${res.status} for ${path}`);
  }

  return (await res.json()) as T;
}

function toQueryString(query: ListingQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export async function getCategories(): Promise<CatalogCategory[]> {
  const data = await get<{ categories: CatalogCategory[] }>("/catalog/categories");
  return data.categories;
}

export async function getListings(query: ListingQuery = {}): Promise<ListingPage> {
  return get<ListingPage>(`/catalog/listings${toQueryString(query)}`);
}

/** Returns null for 404 so callers can render notFound() rather than crash. */
export async function getListing(
  slug: string
): Promise<{
  listing: CatalogListing & {
    reviews: CatalogReview[];
    /** Star counts keyed "1".."5". An average alone hides the shape. */
    ratingBreakdown: Record<string, number>;
  };
  related: CatalogListing[];
} | null> {
  const res = await fetch(`${BACKEND_URL}/catalog/listings/${encodeURIComponent(slug)}`, {
    cache: "no-store",
  });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Backend ${res.status} for listing ${slug}`);

  return res.json();
}

/**
 * Money arrives as integer minor units. Whole amounts render without decimals
 * ($310) to match the rest of the design; fractional ones keep both ($44.50).
 */
export function formatPrice(cents: number, currency = "USD"): string {
  const fractional = cents % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: fractional ? 2 : 0,
    maximumFractionDigits: fractional ? 2 : 0,
  }).format(cents / 100);
}

export function discountPercent(listing: CatalogListing): number | null {
  if (!listing.originalPriceCents || listing.originalPriceCents <= listing.priceCents) {
    return null;
  }
  return Math.round((1 - listing.priceCents / listing.originalPriceCents) * 100);
}

/** The enum values the API accepts, with labels for the filter UI. */
export const CONDITION_OPTIONS = [
  { value: "LIKE_NEW", label: "Like new" },
  { value: "GOOD", label: "Good" },
  { value: "WELL_LOVED", label: "Well-loved" },
  { value: "NEEDS_REPAIR", label: "Needs repair" },
] as const;

export const SORT_OPTIONS = [
  { value: "newest", label: "Newest first" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
] as const;

export type PromotedShelves = {
  hero: CatalogListing | null;
  shelf: CatalogListing[];
};

/**
 * The paid placements currently live.
 *
 * Never cached, matching the endpoint: somebody bought a window and the first
 * minute of it is theirs. An empty result is the normal case — most of the time
 * nothing is promoted at all, and the page falls back to its derived shelves.
 */
export async function getPromoted(): Promise<PromotedShelves> {
  try {
    const res = await fetch(`${BACKEND_URL}/catalog/promoted`, { cache: "no-store" });
    if (!res.ok) return { hero: null, shelf: [] };
    return (await res.json()) as PromotedShelves;
  } catch {
    // The homepage has four other shelves. Merchandising being unreachable is
    // not a reason for none of them to render.
    return { hero: null, shelf: [] };
  }
}
