"use client";

import { formatPrice } from "@/lib/catalog";

/**
 * Live preview of the card a buyer will see.
 *
 * Worth the duplication of ListingCard's markup: a seller writing a listing is
 * guessing at how it lands, and a preview turns "Was ($)" from an abstract field
 * into a visible discount badge. Kept deliberately close to ListingCard so the
 * preview doesn't lie.
 */
export default function ListingPreview({
  title,
  priceCents,
  originalPriceCents,
  conditionNote,
  conditionLabel,
  quantity,
  imageUrl,
  categoryTitle,
}: {
  title: string;
  priceCents: number | null;
  originalPriceCents: number | null;
  conditionNote: string;
  conditionLabel: string;
  quantity: number;
  imageUrl: string | null;
  categoryTitle: string | null;
}) {
  const discount =
    priceCents && originalPriceCents && originalPriceCents > priceCents
      ? Math.round((1 - priceCents / originalPriceCents) * 100)
      : null;

  const badge = conditionNote.trim() || conditionLabel;

  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-paper-card shadow-sm">
      <div className="relative aspect-square overflow-hidden bg-blush">
        {imageUrl ? (
          /* Photos are still local blob: URLs at this point, which next/image
             can't optimise. */
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-dim">
            <svg
              viewBox="0 0 24 24"
              className="h-8 w-8 opacity-50"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <circle cx="8.5" cy="10.5" r="1.5" />
              <path d="M21 15l-5-5-6 6" />
            </svg>
            <span className="text-xs">Your first photo appears here</span>
          </div>
        )}

        {badge && (
          <span className="absolute top-2 left-2 rounded-full bg-paper/95 px-2 py-1 text-[11px] font-medium text-ink shadow-sm">
            {badge}
          </span>
        )}
        {discount && (
          <span className="absolute top-2 right-2 rounded-full bg-gold-dim px-2 py-1 text-[11px] font-semibold text-paper shadow-sm">
            -{discount}%
          </span>
        )}
        <span className="absolute bottom-2 left-2 rounded-full bg-gold-dim/90 px-2 py-1 text-[10px] font-medium text-paper">
          {quantity === 1 ? "Only 1 available" : `${quantity} available`}
        </span>
      </div>

      <div className="p-4">
        <h3 className="text-sm font-medium text-ink">
          {title.trim() || <span className="text-ink-dim">Your title</span>}
        </h3>
        <div className="mt-1.5">
          <span className="text-xs text-ink-dim/80">No reviews yet</span>
        </div>
        <p className="mt-2 flex items-baseline gap-2">
          <span className="text-sm font-semibold text-gold-dim">
            {priceCents ? formatPrice(priceCents) : "—"}
          </span>
          {originalPriceCents && (
            <span className="text-xs text-ink-dim/70 line-through">
              {formatPrice(originalPriceCents)}
            </span>
          )}
        </p>
        {categoryTitle && (
          <p className="mt-2 text-xs text-ink-dim">in {categoryTitle}</p>
        )}
      </div>
    </div>
  );
}
