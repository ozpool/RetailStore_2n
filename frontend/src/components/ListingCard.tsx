import Image from "next/image";
import Link from "next/link";
import StarRating from "@/components/StarRating";
import WishlistButton from "@/components/WishlistButton";
import { type CatalogListing, discountPercent, formatPrice } from "@/lib/catalog";

/**
 * Product tile in the reference's style: a flat grey square for the photo with
 * a discount badge and hover actions, then black title, red price, and rating
 * on plain white beneath. No card border or shadow.
 */
export default function ListingCard({ item }: { item: CatalogListing }) {
  const discount = discountPercent(item);
  const cover = item.images[0];
  const href = `/listing/${item.slug}`;
  // Comes from the API. Working it out here needed Date.now() during render,
  // which is impure and risks a hydration mismatch on a listing sitting near
  // the seven-day boundary.
  const isNew = item.isNew;

  return (
    <div className="group">
      <div className="relative aspect-square overflow-hidden bg-blush">
        <Link href={href} className="block h-full w-full">
          {cover ? (
            <Image
              src={cover.url}
              alt={cover.alt ?? item.title}
              fill
              sizes="(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw"
              /* The reference fills its tiles with cut-out product renders on
                 grey. Ours are real photographs with their own backgrounds, so
                 `cover` fills the tile the same way — `contain` left them
                 floating in a grey box with the photo's own edges showing. */
              className="object-cover transition duration-500 group-hover:scale-105"
            />
          ) : (
            <span className="flex h-full items-center justify-center text-xs text-ink-dim">
              No photo yet
            </span>
          )}
        </Link>

        {/* Badges, top-left */}
        <div className="pointer-events-none absolute top-3 left-3 flex flex-col items-start gap-2">
          {/*
            FIRST, AND NOT OPTIONAL. A paid placement says so before it says
            anything else — above the discount, above NEW — because the one
            thing a viewer needs in order to read the rest honestly is that
            somebody paid to put this here. ADR 0034.
          */}
          {item.promoted && (
            <span className="rounded bg-ink px-3 py-1 text-xs font-medium tracking-wide text-paper uppercase">
              Promoted
            </span>
          )}
          {discount && (
            <span className="rounded bg-gold px-3 py-1 text-xs font-medium text-paper">
              -{discount}%
            </span>
          )}
          {!discount && isNew && (
            <span className="rounded bg-sage px-3 py-1 text-xs font-medium text-ink">
              NEW
            </span>
          )}
        </div>

        {/* Quick actions, top-right */}
        <div className="absolute top-3 right-3 flex flex-col gap-2">
          {/* Was a plain link to /wishlist, which looked like a save button and
              saved nothing. Now it actually saves. */}
          <WishlistButton listingId={item.id} title={item.title} />
          <Link
            href={href}
            aria-label={`View ${item.title}`}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-paper text-ink transition hover:bg-gold hover:text-paper"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </Link>
        </div>

        {/* Slide-up action bar, as in the reference's hovered card */}
        <Link
          href={href}
          className="absolute inset-x-0 bottom-0 translate-y-full bg-ink py-2.5 text-center text-sm font-medium text-paper transition group-hover:translate-y-0"
        >
          View item
        </Link>
      </div>

      <div className="pt-4">
        <h3 className="text-base font-medium text-ink">
          <Link href={href} className="hover:text-gold-dim">
            {item.title}
          </Link>
        </h3>

        <p className="mt-2 flex items-baseline gap-3">
          <span className="font-medium text-gold-dim">
            {formatPrice(item.priceCents, item.currency)}
          </span>
          {item.originalPriceCents && (
            <span className="text-ink-dim line-through">
              {formatPrice(item.originalPriceCents, item.currency)}
            </span>
          )}
        </p>

        <div className="mt-2 flex items-center gap-2">
          {item.rating.average === null ? (
            <span className="text-sm text-ink-dim">No reviews yet</span>
          ) : (
            <StarRating rating={item.rating.average} count={item.rating.count} />
          )}
        </div>

        <p className="mt-1 text-xs text-ink-dim">
          {item.conditionNote ?? item.condition.replace(/_/g, " ").toLowerCase()}
          {item.quantity > 1 && ` · ${item.quantity} available`}
        </p>
      </div>
    </div>
  );
}
