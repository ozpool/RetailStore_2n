"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import StatusBadge from "@/components/StatusBadge";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import { formatPrice } from "@/lib/catalog";
import {
  deleteListing,
  getSellerListings,
  getSellerProfile,
  publishListing,
  unpublishListing,
  type SellerListing,
  type SellerProfile,
} from "@/lib/sellerApi";

export default function SellerDashboard() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [profile, setProfile] = useState<SellerProfile | null>(null);
  const [listings, setListings] = useState<SellerListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const [profileRes, listingsRes] = await Promise.all([
        getSellerProfile(),
        getSellerListings(),
      ]);
      setProfile(profileRes.seller);
      setListings(listingsRes.listings);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't load your listings."
      );
    }
  }, []);

  useEffect(() => {
    if (user?.isSeller) load();
  }, [user?.isSeller, load]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setError(null);
    setBusyId(id);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading || !user) {
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-16">
          <div className="mx-auto max-w-[1400px] text-sm text-ink-dim">Loading…</div>
        </main>
        <Footer />
      </>
    );
  }

  if (!user.isSeller) {
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-16">
          <div className="mx-auto max-w-2xl">
            <h1 className="font-serif text-3xl font-medium tracking-tight text-ink">
              You don&apos;t have a seller account yet
            </h1>
            <p className="mt-4 text-sm text-ink-dim">
              Turn on selling from your account page and you can list your first item
              straight after.
            </p>
            <Link
              href="/account"
              className="mt-6 inline-block rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90"
            >
              Go to your account
            </Link>
          </div>
        </main>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-[1400px]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="font-serif text-3xl font-medium tracking-tight text-ink sm:text-4xl">
                Your listings
              </h1>
              {profile && (
                <p className="mt-2 text-sm text-ink-dim">
                  {profile.shopName}
                  {" · "}
                  {profile.payoutsEnabled ? (
                    <span className="text-gold-dim">Payouts enabled</span>
                  ) : (
                    <>
                      <span>Payouts locked until your identity is verified</span>
                      {" · "}
                      <Link href="/seller/verify" className="text-gold-dim underline">
                        Verify now
                      </Link>
                    </>
                  )}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-3">
              {/* A seller with an unsent parcel needs to find this from the
                  page they already live on, not from the account menu. */}
              <Link
                href="/seller/sales"
                className="rounded-full border border-line px-5 py-2.5 text-sm font-medium text-ink transition hover:border-gold/40"
              >
                Sales
              </Link>
              {/* "Where's my money" is the other question a seller opens this
                  page to ask, so it gets a button rather than a menu entry. */}
              <Link
                href="/seller/payouts"
                className="rounded-full border border-line px-5 py-2.5 text-sm font-medium text-ink transition hover:border-gold/40"
              >
                Payouts
              </Link>
              {/* Talking to us, and asking for the homepage. Both are new and
                  neither is discoverable from anywhere else a seller looks. */}
              <Link
                href="/seller/messages"
                className="rounded-full border border-line px-5 py-2.5 text-sm font-medium text-ink transition hover:border-gold/40"
              >
                Messages
              </Link>
              <Link
                href="/seller/placements"
                className="rounded-full border border-line px-5 py-2.5 text-sm font-medium text-ink transition hover:border-gold/40"
              >
                Homepage
              </Link>
              <Link
                href="/seller/listings/new"
                className="rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90"
              >
                List an item
              </Link>
            </div>
          </div>

          {error && (
            <p className="mt-6 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
              {error}
            </p>
          )}

          {listings === null ? (
            <p className="mt-10 text-sm text-ink-dim">Loading…</p>
          ) : listings.length === 0 ? (
            <div className="mt-12 rounded-3xl border border-line bg-paper-card p-10 text-center">
              <p className="text-ink">Nothing listed yet.</p>
              <p className="mx-auto mt-2 max-w-md text-sm text-ink-dim">
                Photograph the thing taking up space, describe it honestly, and put it
                up. Drafts stay private until you publish.
              </p>
              <Link
                href="/seller/listings/new"
                className="mt-6 inline-block rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90"
              >
                List your first item
              </Link>
            </div>
          ) : (
            <ul className="mt-8 grid gap-4">
              {listings.map((listing) => {
                const cover = listing.images[0];
                const busy = busyId === listing.id;

                return (
                  <li
                    key={listing.id}
                    className="flex flex-wrap items-center gap-5 rounded-2xl border border-line bg-paper-card p-4"
                  >
                    <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-line">
                      {cover ? (
                        <Image
                          src={cover.url}
                          alt={cover.alt ?? listing.title}
                          fill
                          sizes="80px"
                          className="object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center bg-blush text-center text-[10px] text-ink-dim">
                          No photo
                        </div>
                      )}
                    </div>

                    <div className="min-w-48 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-sm font-medium text-ink">{listing.title}</h2>
                        <StatusBadge status={listing.status} />
                      </div>
                      <p className="mt-1 text-sm text-ink-dim">
                        {formatPrice(listing.priceCents, listing.currency)}
                        {" · "}
                        {listing.category.title}
                        {" · "}
                        {listing.quantity === 1 ? "1 available" : `${listing.quantity} available`}
                      </p>
                      {listing.images.length === 0 && (
                        <p className="mt-1 text-xs text-clay">
                          Needs a photo before it can go live.
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/seller/listings/${listing.id}`}
                        className="rounded-full border border-line px-3.5 py-1.5 text-sm text-ink-dim transition hover:border-gold/50 hover:text-gold-dim"
                      >
                        Edit
                      </Link>

                      {listing.status === "ACTIVE" && (
                        <Link
                          href={`/listing/${listing.slug}`}
                          className="rounded-full border border-line px-3.5 py-1.5 text-sm text-ink-dim transition hover:border-gold/50 hover:text-gold-dim"
                        >
                          View
                        </Link>
                      )}

                      {listing.status === "DRAFT" && (
                        <button
                          type="button"
                          disabled={busy || listing.images.length === 0}
                          onClick={() => act(listing.id, () => publishListing(listing.id))}
                          className="rounded-full bg-gold-dim px-3.5 py-1.5 text-sm font-semibold text-paper transition hover:brightness-90 disabled:opacity-50"
                        >
                          Publish
                        </button>
                      )}

                      {listing.status === "ACTIVE" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => act(listing.id, () => unpublishListing(listing.id))}
                          className="rounded-full border border-line px-3.5 py-1.5 text-sm text-ink-dim transition hover:border-gold/50 hover:text-gold-dim disabled:opacity-50"
                        >
                          Unpublish
                        </button>
                      )}

                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Remove “${listing.title}”? Buyers won't see it any more.`
                            )
                          ) {
                            act(listing.id, () => deleteListing(listing.id));
                          }
                        }}
                        className="rounded-full border border-clay/30 px-3.5 py-1.5 text-sm text-clay transition hover:bg-clay hover:text-paper disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
