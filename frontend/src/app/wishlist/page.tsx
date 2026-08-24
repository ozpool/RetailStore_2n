"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import { formatPrice } from "@/lib/catalog";
import { useWishlist } from "@/lib/WishlistContext";
import { getWishlist, type WishlistEntry } from "@/lib/wishlistApi";

export default function WishlistPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { toggle } = useWishlist();

  const [items, setItems] = useState<WishlistEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const { items } = await getWishlist();
      setItems(items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your wishlist.");
      setItems([]);
    }
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  async function unsave(listingId: string) {
    setError(null);
    setBusyId(listingId);
    try {
      // Goes through the context so the nav badge and any hearts elsewhere
      // update with it, rather than this page drifting out of step.
      await toggle(listingId);
      setItems((current) => current?.filter((i) => i.listing.id !== listingId) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove that item.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading || !user) {
    return <Shell><p className="text-sm text-ink-dim">Loading…</p></Shell>;
  }

  const list = items ?? [];
  const gone = list.filter((i) => !i.listing.available).length;

  return (
    <Shell>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Wishlist
        </h1>
        {list.length > 0 && (
          <p className="text-sm text-ink-dim">
            {list.length} saved
            {gone > 0 && ` · ${gone} no longer available`}
          </p>
        )}
      </div>

      <p className="mt-3 max-w-2xl text-sm text-ink-dim">
        Things you&apos;re keeping an eye on. Saving doesn&apos;t hold an item —
        anyone can still buy it, so use{" "}
        <span className="font-medium text-ink">Hold</span> on the listing if you
        want it kept for you.
      </p>

      {error && (
        <p className="mt-6 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      )}

      {items === null ? (
        <p className="mt-10 text-sm text-ink-dim">Loading…</p>
      ) : list.length === 0 ? (
        <div className="mt-10 border border-line bg-blush p-10 text-center">
          <span
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-paper text-ink-dim"
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.8 5.6a5 5 0 00-7.1 0L12 7.3l-1.7-1.7a5 5 0 10-7.1 7.1L12 21.5l8.8-8.8a5 5 0 000-7.1z" />
            </svg>
          </span>
          <p className="mt-5 text-ink">Nothing saved yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-dim">
            Tap the heart on anything in the shop and it&apos;ll show up here.
          </p>
          <Link
            href="/search"
            className="mt-6 inline-block rounded bg-gold-dim px-6 py-3 text-sm font-medium text-paper transition hover:brightness-95"
          >
            Browse the shop
          </Link>
        </div>
      ) : (
        <ul className="mt-8 grid gap-4">
          {list.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-5 rounded-2xl border border-line bg-paper-card p-4"
            >
              <Link
                href={`/listing/${item.listing.slug}`}
                className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-line"
              >
                {item.listing.image ? (
                  <Image
                    src={item.listing.image}
                    alt={item.listing.imageAlt ?? item.listing.title}
                    fill
                    sizes="80px"
                    /* Dimmed rather than hidden: an unavailable item is still
                       worth recognising at a glance. */
                    className={`object-cover ${item.listing.available ? "" : "opacity-50"}`}
                  />
                ) : (
                  <span className="flex h-full items-center justify-center bg-blush text-center text-[10px] text-ink-dim">
                    No photo
                  </span>
                )}
              </Link>

              <div className="min-w-48 flex-1">
                <Link
                  href={`/listing/${item.listing.slug}`}
                  className="text-sm font-medium text-ink transition hover:text-gold-dim"
                >
                  {item.listing.title}
                </Link>
                <p className="mt-1 text-sm text-ink-dim">
                  {formatPrice(item.listing.priceCents, item.listing.currency)}
                  {item.listing.originalPriceCents && (
                    <span className="ml-2 line-through">
                      {formatPrice(item.listing.originalPriceCents, item.listing.currency)}
                    </span>
                  )}
                </p>
                <p className="mt-1 text-xs text-ink-dim">
                  from {item.listing.sellerName}
                  {item.listing.conditionNote && ` · ${item.listing.conditionNote}`}
                </p>

                {item.listing.sold ? (
                  <p className="mt-1.5 text-xs font-medium text-clay">
                    Sold — someone got there first.
                  </p>
                ) : !item.listing.available ? (
                  <p className="mt-1.5 text-xs font-medium text-ink-dim">
                    Not available right now. It may come back.
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {item.listing.available && (
                  <Link
                    href={`/listing/${item.listing.slug}`}
                    className="rounded-full bg-gold-dim px-4 py-1.5 text-sm font-semibold text-paper transition hover:brightness-90"
                  >
                    View item
                  </Link>
                )}
                <button
                  type="button"
                  onClick={() => unsave(item.listing.id)}
                  disabled={busyId === item.listing.id}
                  className="rounded-full border border-line px-4 py-1.5 text-sm text-ink-dim transition hover:border-clay/40 hover:text-clay disabled:opacity-60"
                >
                  {busyId === item.listing.id ? "Removing…" : "Remove"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-4xl">{children}</div>
      </main>
      <Footer />
    </>
  );
}
