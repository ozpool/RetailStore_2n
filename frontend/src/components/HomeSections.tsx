"use client";

import CategoryTiles from "@/components/CategoryTiles";
import Footer from "@/components/Footer";
import HeroBanner from "@/components/HeroBanner";
import Nav from "@/components/Nav";
import NewArrivalGrid from "@/components/NewArrivalGrid";
import ProductRow from "@/components/ProductRow";
import PromoBanner from "@/components/PromoBanner";
import ServiceStrip from "@/components/ServiceStrip";
import type { CatalogCategory, CatalogListing } from "@/lib/catalog";
import { useAuth } from "@/lib/AuthContext";

/**
 * Homepage in the reference design's order. The catalog is fetched on the
 * server; this component only chooses the greeting, which is the one thing that
 * depends on client auth state.
 */
export default function HomeSections({
  categories,
  promotedHero,
  promotedShelf,
  discounted,
  topRated,
  newArrivals,
  everything,
}: {
  categories: CatalogCategory[];
  promotedHero: CatalogListing | null;
  promotedShelf: CatalogListing[];
  discounted: CatalogListing[];
  topRated: CatalogListing[];
  newArrivals: CatalogListing[];
  everything: CatalogListing[];
}) {
  const { user } = useAuth();
  const firstName = user?.name.split(" ")[0];

  return (
    <>
      <Nav />
      <main className="flex-1">
        {/*
          A live hero placement wins the banner. Falling back to a discounted
          listing keeps the page identical to before whenever nothing is
          promoted, which is most of the time.
        */}
        <HeroBanner
          categories={categories}
          feature={promotedHero ?? discounted[0] ?? everything[0] ?? null}
        />

        {/*
          Its own row, disclosed twice: the eyebrow says Promoted and every
          card carries the label. ProductRow renders nothing when the list is
          empty, so this disappears entirely when nothing is booked.
        */}
        <ProductRow
          eyebrow="Promoted"
          title="Featured this week"
          listings={promotedShelf}
          viewAllHref="/search"
          viewAllInHeader
        />

        <ProductRow
          eyebrow="Reduced"
          title="Price Drops"
          listings={discounted}
          viewAllHref="/search?sort=price_asc"
          ctaLabel="View All Products"
        />

        <CategoryTiles categories={categories} />

        <ProductRow
          eyebrow={firstName ? `Picked for ${firstName}` : "This Month"}
          title="Best Rated"
          listings={topRated}
          viewAllHref="/search"
          viewAllInHeader
        />

        <PromoBanner feature={topRated[0] ?? everything[0] ?? null} />

        <NewArrivalGrid listings={newArrivals} />

        <ProductRow
          eyebrow="Our Products"
          title="Explore Our Products"
          listings={everything}
          viewAllHref="/search"
          ctaLabel="View All Products"
          bordered={false}
        />

        <ServiceStrip />
      </main>
      <Footer />
    </>
  );
}
