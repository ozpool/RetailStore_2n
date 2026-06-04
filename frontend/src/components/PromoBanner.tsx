import Image from "next/image";
import Link from "next/link";
import type { CatalogListing } from "@/lib/catalog";

/**
 * The reference's full-width black promo block: green eyebrow, large white
 * heading, green CTA, product image to the right.
 *
 * The reference puts a countdown here. Ours doesn't, because nothing about this
 * listing actually expires — a ticking clock implying a deadline that doesn't
 * exist is the kind of pressure this shop shouldn't apply.
 */
export default function PromoBanner({ feature }: { feature: CatalogListing | null }) {
  if (!feature) return null;
  const cover = feature.images[0];

  return (
    <section className="px-6 py-16">
      <div className="mx-auto max-w-[1400px]">
        <div className="grid items-center gap-8 bg-ink px-8 py-12 sm:px-14 lg:grid-cols-2">
          <div>
            <p className="text-sm font-semibold text-sage">
              {feature.category.title}
            </p>
            <h2 className="mt-6 max-w-md font-serif text-3xl leading-tight font-semibold text-paper sm:text-4xl">
              One of these exists. Then it&apos;s gone.
            </h2>
            <p className="mt-5 max-w-md text-paper/70">
              {feature.description}
            </p>
            <Link
              href={`/listing/${feature.slug}`}
              className="mt-8 inline-block rounded bg-sage px-8 py-3 text-sm font-medium text-ink transition hover:brightness-95"
            >
              See it
            </Link>
          </div>

          <div className="relative aspect-4/3 w-full">
            {cover && (
              <Image
                src={cover.url}
                alt={feature.title}
                fill
                sizes="(min-width: 1024px) 45vw, 100vw"
                className="object-contain"
              />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
