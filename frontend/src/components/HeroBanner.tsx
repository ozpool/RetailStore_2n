import Image from "next/image";
import Link from "next/link";
import type { CatalogCategory, CatalogListing } from "@/lib/catalog";
import { formatPrice } from "@/lib/catalog";

/**
 * Reference layout: a category list down the left, divided from a large dark
 * promo banner on the right.
 */
export default function HeroBanner({
  categories,
  feature,
}: {
  categories: CatalogCategory[];
  feature: CatalogListing | null;
}) {
  const cover = feature?.images[0];

  return (
    <section className="px-6">
      <div className="mx-auto flex max-w-[1400px] gap-10 py-10">
        <aside className="hidden w-56 shrink-0 border-r border-line pr-6 lg:block">
          <ul className="space-y-4">
            {categories.map((category) => (
              <li key={category.slug}>
                <Link
                  href={`/shop/${category.slug}`}
                  className="flex items-center justify-between text-base text-ink transition hover:text-gold-dim"
                >
                  {category.title}
                  <span aria-hidden="true" className="text-ink-dim">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </aside>

        <div className="relative min-h-80 flex-1 overflow-hidden bg-ink">
          {cover && (
            <Image
              src={cover.url}
              alt=""
              fill
              sizes="(min-width: 1024px) 70vw, 100vw"
              className="object-cover opacity-45"
              priority
            />
          )}

          <div className="relative flex h-full flex-col justify-center gap-5 p-10 sm:p-14">
            {/*
              Disclosed at the top of the banner, not tucked under the button.
              A hero somebody paid for has to say so where it is read first.
              ADR 0034.
            */}
            {feature?.promoted && (
              <span className="w-fit rounded border border-paper/40 px-3 py-1 text-xs font-medium tracking-widest text-paper uppercase">
                Promoted
              </span>
            )}
            <p className="text-sm text-paper/80">
              {feature ? feature.category.title : "Secondhand, chosen with care"}
            </p>
            <h1 className="max-w-md font-serif text-3xl leading-tight font-semibold text-paper sm:text-5xl">
              {feature ? feature.title : "Every piece here has a past."}
            </h1>

            {feature && (
              <p className="text-lg text-paper">
                {formatPrice(feature.priceCents, feature.currency)}
                {feature.originalPriceCents && (
                  <span className="ml-3 text-paper/60 line-through">
                    {formatPrice(feature.originalPriceCents, feature.currency)}
                  </span>
                )}
              </p>
            )}

            <div>
              <Link
                href={feature ? `/listing/${feature.slug}` : "/search"}
                className="inline-flex items-center gap-2 border-b border-paper pb-1 text-base font-medium text-paper transition hover:gap-3"
              >
                Shop Now
                <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
