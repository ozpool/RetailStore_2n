"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import { useWishlist } from "@/lib/WishlistContext";

/**
 * The save-for-later heart.
 *
 * One component for both places it appears, so a tile and a product page can
 * never disagree about whether something is saved:
 *   variant="icon" — the round button floating on a catalog tile
 *   variant="full" — the labelled button beside Hold on a listing page
 *
 * Signed out, this doesn't pretend. Clicking sends you to log in rather than
 * filling the heart locally and losing it on refresh.
 */
export default function WishlistButton({
  listingId,
  title,
  variant = "icon",
  className = "",
}: {
  listingId: string;
  /** Used in the accessible label, so screen readers hear which item. */
  title: string;
  variant?: "icon" | "full";
  className?: string;
}) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { has, toggle } = useWishlist();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saved = has(listingId);

  async function onClick() {
    setError(null);

    if (!user) {
      router.push("/login");
      return;
    }

    setBusy(true);
    try {
      await toggle(listingId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update your wishlist.");
    } finally {
      setBusy(false);
    }
  }

  const label = saved ? `Remove ${title} from your wishlist` : `Save ${title} for later`;

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={busy || authLoading}
        aria-label={label}
        aria-pressed={saved}
        title={error ?? label}
        className={`flex h-8 w-8 items-center justify-center rounded-full bg-paper transition disabled:opacity-70 ${
          saved ? "text-gold-dim" : "text-ink hover:bg-gold hover:text-paper"
        } ${className}`}
      >
        <Heart filled={saved} />
      </button>
    );
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={onClick}
        disabled={busy || authLoading}
        aria-pressed={saved}
        className={`flex w-full items-center justify-center gap-2 rounded border px-5 py-3 text-sm font-medium transition disabled:opacity-60 ${
          saved
            ? "border-gold/40 bg-gold/5 text-gold-dim"
            : "border-line text-ink hover:border-gold/40"
        }`}
      >
        <Heart filled={saved} />
        {busy ? "Saving…" : saved ? "Saved for later" : "Save for later"}
      </button>

      {error && <p className="mt-2 text-sm text-clay">{error}</p>}

      {saved && !error && (
        <p className="mt-2 text-xs text-ink-dim">
          Saving doesn&apos;t hold it — someone else can still buy this. Use Hold
          for that.
        </p>
      )}
    </div>
  );
}

/**
 * Fill is the state signal, so it is paired with aria-pressed and a label that
 * spells the state out — a filled-vs-outline heart alone is not something a
 * screen reader can convey.
 */
function Heart({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.8 5.6a5 5 0 00-7.1 0L12 7.3l-1.7-1.7a5 5 0 10-7.1 7.1L12 21.5l8.8-8.8a5 5 0 000-7.1z" />
    </svg>
  );
}
