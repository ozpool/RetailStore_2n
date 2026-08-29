"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import StarRating from "@/components/StarRating";
import { ApiError, getMyReviews, type MyReview } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import { formatPrice } from "@/lib/catalog";
import { removeReview } from "@/lib/reviewsApi";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function MyReviewsPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [reviews, setReviews] = useState<MyReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function destroy(reviewId: string) {
    setError(null);
    setBusyId(reviewId);
    try {
      await removeReview(reviewId);
      setReviews((current) => current?.filter((r) => r.id !== reviewId) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete that review.");
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    getMyReviews()
      .then(({ reviews }) => setReviews(reviews))
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Couldn't load your reviews.");
        setReviews([]);
      });
  }, [user]);

  if (loading || !user) {
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-16">
          <div className="mx-auto max-w-4xl text-sm text-ink-dim">Loading…</div>
        </main>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-4xl">
          <Link href="/account" className="text-sm text-ink-dim transition hover:text-gold-dim">
            ← Your account
          </Link>

          <div className="mt-4 flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
              My reviews
            </h1>
            {reviews && reviews.length > 0 && (
              <p className="text-sm text-ink-dim">
                {reviews.length} review{reviews.length === 1 ? "" : "s"}
              </p>
            )}
          </div>

          <p className="mt-3 max-w-2xl text-sm text-ink-dim">
            Reviews you&apos;ve written. Ratings on RetailStore_2n are averaged from real
            reviews, so what you write here is what other buyers see.
          </p>

          {error && (
            <p className="mt-6 rounded border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
              {error}
            </p>
          )}

          {reviews === null ? (
            <p className="mt-10 text-sm text-ink-dim">Loading…</p>
          ) : reviews.length === 0 ? (
            <div className="mt-10 border border-line bg-blush p-10 text-center">
              <p className="text-ink">You haven&apos;t reviewed anything yet.</p>
              <p className="mx-auto mt-2 max-w-md text-sm text-ink-dim">
                Reviews can only be written for something you&apos;ve bought, so
                this fills up after your first order.
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
              {reviews.map((review) => (
                <li
                  key={review.id}
                  className="flex flex-wrap items-start gap-5 border border-line p-4"
                >
                  <Link
                    href={`/listing/${review.listing.slug}`}
                    className="relative h-20 w-20 shrink-0 overflow-hidden border border-line bg-blush"
                  >
                    {review.listing.image ? (
                      <Image
                        src={review.listing.image}
                        alt={review.listing.title}
                        fill
                        sizes="80px"
                        className="object-cover"
                      />
                    ) : (
                      <span className="flex h-full items-center justify-center text-center text-[10px] text-ink-dim">
                        No photo
                      </span>
                    )}
                  </Link>

                  <div className="min-w-48 flex-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <Link
                        href={`/listing/${review.listing.slug}`}
                        className="text-sm font-medium text-ink transition hover:text-gold-dim"
                      >
                        {review.listing.title}
                      </Link>
                      {!review.listing.available && (
                        <span className="border border-line px-2 py-0.5 text-xs text-ink-dim">
                          No longer listed
                        </span>
                      )}
                    </div>

                    <p className="mt-1 text-sm text-gold-dim">
                      {formatPrice(review.listing.priceCents, review.listing.currency)}
                    </p>

                    <div className="mt-2">
                      <StarRating rating={review.rating} />
                    </div>

                    {review.body && (
                      <p className="mt-2 text-sm text-ink-dim">{review.body}</p>
                    )}

                    <p className="mt-2 text-xs text-ink-dim">
                      {formatDate(review.createdAt)}
                      {review.edited && " · edited"}
                    </p>

                    <div className="mt-3 flex flex-wrap gap-3">
                      {/* Editing happens on the listing, next to the thing
                          being reviewed — a rating written away from the item
                          is a rating written from memory. */}
                      <Link
                        href={`/listing/${review.listing.slug}#reviews`}
                        className="text-xs text-gold-dim underline"
                      >
                        Edit on the listing
                      </Link>
                      <button
                        type="button"
                        onClick={() => destroy(review.id)}
                        disabled={busyId === review.id}
                        className="text-xs text-ink-dim underline transition hover:text-clay disabled:opacity-60"
                      >
                        {busyId === review.id ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
