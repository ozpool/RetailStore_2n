import HomeSections from "@/components/HomeSections";
import {
  getCategories,
  getListings,
  getPromoted,
  type CatalogListing,
} from "@/lib/catalog";

/** Keeps a listing from appearing in two shelves in a row. */
function take(pool: CatalogListing[], used: Set<string>, count: number) {
  const picked: CatalogListing[] = [];
  for (const item of pool) {
    if (picked.length === count) break;
    if (used.has(item.id)) continue;
    picked.push(item);
    used.add(item.id);
  }
  return picked;
}

export default async function Home() {
  const [categories, all, promoted] = await Promise.all([
    getCategories(),
    getListings({ limit: 48, sort: "newest" }),
    getPromoted(),
  ]);

  const listings = all.listings;
  const used = new Set<string>();

  /**
   * A promoted listing must not ALSO be picked by a derived shelf.
   *
   * Otherwise the same item appears twice: once labelled Promoted and once
   * unlabelled a shelf below, which is worse than not labelling it at all —
   * the unlabelled copy reads as independent corroboration of the paid one.
   */
  for (const p of [promoted.hero, ...promoted.shelf]) {
    if (p) used.add(p.id);
  }

  // Derived rather than flagged: a higher original price means it genuinely is
  // reduced, so nothing here claims a discount that doesn't exist.
  const discounted = take(
    listings.filter((l) => l.originalPriceCents && l.originalPriceCents > l.priceCents),
    used,
    4
  );

  // Actually sorted by rating — and only listings that have reviews, so an
  // unreviewed item never appears under "Best Rated".
  const topRated = take(
    [...listings]
      .filter((l) => l.rating.average !== null)
      .sort((a, b) => (b.rating.average ?? 0) - (a.rating.average ?? 0)),
    used,
    4
  );

  const newArrivals = take(listings, used, 4);

  /**
   * PAID PLACEMENTS GET THEIR OWN ROW, and it is padded with nothing.
   *
   * ADR 0034 named this slot "the Picked for you shelf", which turned out not
   * to exist: that eyebrow sits on Best Rated, a DERIVED shelf, and the ADR's
   * own rule forbids putting paid placement into one of those. So the slot
   * renders as its own row instead.
   *
   * Filling the spare positions with ordinary listings was the obvious next
   * thought and is worse than leaving them empty: unlabelled cards in a row
   * titled "Promoted" are mislabelled in the other direction, and a short row
   * is only untidy.
   */
  const promotedShelf = promoted.shelf;

  return (
    <HomeSections
      categories={categories}
      promotedHero={promoted.hero}
      promotedShelf={promotedShelf}
      discounted={discounted}
      topRated={topRated}
      newArrivals={newArrivals}
      // The closing shelf is the whole catalog, so overlap here is the point.
      everything={listings.slice(0, 8)}
    />
  );
}
