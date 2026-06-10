import Image from "next/image";
import Link from "next/link";
import SectionHeading from "@/components/SectionHeading";
import type { CatalogListing } from "@/lib/catalog";

function Tile({
  listing,
  className,
  sizes,
}: {
  listing: CatalogListing;
  className: string;
  sizes: string;
}) {
  const cover = listing.images[0];

  return (
    <Link
      href={`/listing/${listing.slug}`}
      className={`group relative overflow-hidden bg-ink ${className}`}
    >
      {cover && (
        <Image
          src={cover.url}
          alt={listing.title}
          fill
          sizes={sizes}
          className="object-cover opacity-70 transition duration-500 group-hover:scale-105 group-hover:opacity-80"
        />
      )}
      <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-ink to-transparent p-6">
        <h3 className="font-serif text-xl font-semibold text-paper">{listing.title}</h3>
        <p className="mt-1 line-clamp-2 max-w-xs text-sm text-paper/70">
          {listing.description}
        </p>
        <span className="mt-3 inline-block border-b border-paper pb-0.5 text-sm font-medium text-paper">
          Shop Now
        </span>
      </div>
    </Link>
  );
}

/**
 * The reference's asymmetric "New Arrival" block: one tall tile beside a wide
 * one and two narrow ones. Needs four listings; renders nothing below that
 * rather than leaving holes in the grid.
 */
export default function NewArrivalGrid({ listings }: { listings: CatalogListing[] }) {
  if (listings.length < 4) return null;
  const [a, b, c, d] = listings;

  return (
    <section className="border-b border-line px-6 py-16">
      <div className="mx-auto max-w-[1400px]">
        <SectionHeading eyebrow="Featured" title="New Arrivals" />

        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <Tile
            listing={a}
            className="min-h-96 lg:min-h-[38rem]"
            sizes="(min-width: 1024px) 50vw, 100vw"
          />

          <div className="grid gap-6">
            <Tile
              listing={b}
              className="min-h-64"
              sizes="(min-width: 1024px) 50vw, 100vw"
            />
            <div className="grid gap-6 sm:grid-cols-2">
              <Tile
                listing={c}
                className="min-h-64"
                sizes="(min-width: 1024px) 25vw, 50vw"
              />
              <Tile
                listing={d}
                className="min-h-64"
                sizes="(min-width: 1024px) 25vw, 50vw"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
