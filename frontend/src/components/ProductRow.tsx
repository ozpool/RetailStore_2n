import Link from "next/link";
import ListingCard from "@/components/ListingCard";
import SectionHeading from "@/components/SectionHeading";
import type { CatalogListing } from "@/lib/catalog";

/**
 * Reference product section: eyebrow + heading, an optional "View All" button,
 * a four-up grid, and a centred red CTA underneath.
 */
export default function ProductRow({
  eyebrow,
  title,
  listings,
  viewAllHref,
  viewAllInHeader = false,
  ctaLabel,
  bordered = true,
}: {
  eyebrow: string;
  title: string;
  listings: CatalogListing[];
  viewAllHref: string;
  viewAllInHeader?: boolean;
  ctaLabel?: string;
  bordered?: boolean;
}) {
  if (listings.length === 0) return null;

  return (
    <section className={`px-6 py-16 ${bordered ? "border-b border-line" : ""}`}>
      <div className="mx-auto max-w-[1400px]">
        <SectionHeading
          eyebrow={eyebrow}
          title={title}
          right={
            viewAllInHeader ? (
              <Link
                href={viewAllHref}
                className="rounded bg-gold-dim px-8 py-3 text-sm font-medium text-paper transition hover:brightness-95"
              >
                View All
              </Link>
            ) : undefined
          }
        />

        <div className="mt-10 grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-4">
          {listings.map((item) => (
            <ListingCard key={item.id} item={item} />
          ))}
        </div>

        {ctaLabel && (
          <div className="mt-12 text-center">
            <Link
              href={viewAllHref}
              className="inline-block rounded bg-gold-dim px-10 py-3 text-sm font-medium text-paper transition hover:brightness-95"
            >
              {ctaLabel}
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
