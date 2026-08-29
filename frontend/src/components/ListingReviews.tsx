"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import RatingBreakdown from "@/components/RatingBreakdown";
import ReportButton from "@/components/ReportButton";
import StarPicker from "@/components/StarPicker";
import StarRating from "@/components/StarRating";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import {
  MAX_REVIEW_BODY,
  getReviewEligibility,
  postReview,
  removeReview,
  type Eligibility,
  type ListingReview,
} from "@/lib/reviewsApi";

/**
 * The review section of a listing page.
 *
 * A client island inside a server-rendered page: the reviews themselves are
 * public and arrive with the HTML, but whether *you* may write one depends on
 * whether you bought it, and that answer can't be baked into a page cached for
 * everybody.
 */
export default function ListingReviews({
  listingId,
  initialReviews,
  average,
  count,
  breakdown,
}: {
  listingId: string;
  initialReviews: ListingReview[];
  average: number | null;
  count: number;
  breakdown: Record<string, number>;
}) {
  const { user, loading } = useAuth();

  const [reviews, setReviews] = useState(initialReviews);
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const result = await getReviewEligibility(listingId);
      setEligibility(result);
      if (result.mine) {
        setRating(result.mine.rating);
        setBody(result.mine.body ?? "");
      }
    } catch {
      // Not being able to tell whether you may review is not a reason to hide
      // the reviews that are already here.
      setEligibility(null);
    }
  }, [user, listingId]);

  useEffect(() => {
    if (!loading) void load();
  }, [loading, load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (rating < 1) {
      setError("Choose a rating first.");
      return;
    }

    setBusy(true);
    try {
      const { review } = await postReview({
        listingId,
        rating,
        body: body.trim() || null,
      });

      // Replace in place if this was an edit, otherwise put it at the top.
      setReviews((current) => {
        const without = current.filter((r) => r.id !== review.id);
        return [{ ...review, authorId: user!.id }, ...without];
      });
      setOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't post that review.");
    } finally {
      setBusy(false);
    }
  }

  async function destroy(reviewId: string) {
    setError(null);
    setBusy(true);
    try {
      await removeReview(reviewId);
      setReviews((current) => current.filter((r) => r.id !== reviewId));
      setRating(0);
      setBody("");
      setOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete that review.");
    } finally {
      setBusy(false);
    }
  }

  const mine = eligibility?.mine ?? null;
  const canWrite = eligibility?.canReview ?? false;

  return (
    /* id so "Edit on the listing" and order receipts can link straight here. */
    <section id="reviews" className="mt-16 scroll-mt-24">
      <h2 className="font-serif text-2xl font-medium tracking-tight text-ink">
        Reviews{" "}
        <span className="text-base font-normal text-ink-dim">({count})</span>
      </h2>

      {count > 0 && (
        <div className="mt-6">
          <RatingBreakdown average={average} count={count} breakdown={breakdown} />
        </div>
      )}

      {error && (
        <p className="mt-4 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      )}

      {/* ---- write / edit ---- */}
      <div className="mt-6">
        {!loading && !user ? (
          <p className="text-sm text-ink-dim">
            <Link href="/login" className="text-gold-dim underline">
              Log in
            </Link>{" "}
            to review something you&apos;ve bought.
          </p>
        ) : canWrite && !open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-95"
          >
            {mine ? "Edit your review" : "Write a review"}
          </button>
        ) : !canWrite && eligibility ? (
          /* Says why, rather than showing a button that fails. The reason is
             the product working as intended — reviews come from buyers. */
          <p className="text-sm text-ink-dim">{eligibility.reason}</p>
        ) : null}

        {open && (
          <form onSubmit={submit} className="mt-4 rounded-2xl border border-line bg-paper-card p-5">
            <StarPicker value={rating} onChange={setRating} disabled={busy} />

            <label htmlFor="review-body" className="mt-5 block text-sm font-medium text-ink">
              Anything worth saying?{" "}
              <span className="font-normal text-ink-dim">Optional</span>
            </label>
            <textarea
              id="review-body"
              value={body}
              onChange={(e) => setBody(e.target.value.slice(0, MAX_REVIEW_BODY))}
              rows={4}
              disabled={busy}
              placeholder="How was the condition compared to the description? Would you buy from this seller again?"
              className="mt-1.5 w-full rounded border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-dim/60 focus:border-gold/50 disabled:opacity-60"
            />
            <p className="mt-1 text-xs text-ink-dim">
              {body.length}/{MAX_REVIEW_BODY}
            </p>

            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={busy || rating < 1}
                className="rounded bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Posting…" : mine ? "Save changes" : "Post review"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded border border-line px-5 py-2.5 text-sm text-ink transition hover:border-gold/40 disabled:opacity-60"
              >
                Cancel
              </button>
              {mine && (
                <button
                  type="button"
                  onClick={() => destroy(mine.id)}
                  disabled={busy}
                  className="ml-auto rounded border border-line px-5 py-2.5 text-sm text-ink-dim transition hover:border-clay/40 hover:text-clay disabled:opacity-60"
                >
                  Delete
                </button>
              )}
            </div>
          </form>
        )}
      </div>

      {/* ---- the reviews ---- */}
      {reviews.length === 0 ? (
        <p className="mt-6 text-sm text-ink-dim">Nobody has reviewed this one yet.</p>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {reviews.map((review) => {
            const isMine = user?.id === review.authorId;
            return (
              <li
                key={review.id}
                className={`rounded-2xl border p-5 ${
                  isMine ? "border-gold/40 bg-gold/5" : "border-line bg-paper-card"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">
                    {isMine ? "You" : review.authorName}
                  </span>
                  <span className="text-xs text-ink-dim">
                    {new Date(review.createdAt).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                    {review.edited && " · edited"}
                  </span>
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <StarRating rating={review.rating} />
                  {/* Shown only when a paid order actually backs it. Printing
                      this on a review nobody paid for would make the badge
                      worthless everywhere it appears. */}
                  {review.verified && (
                    <span className="text-xs text-ink-dim">Verified purchase</span>
                  )}
                </div>

                {review.body && <p className="mt-3 text-sm text-ink-dim">{review.body}</p>}

                <div className="mt-3">
                  {isMine && !open ? (
                    <button
                      type="button"
                      onClick={() => setOpen(true)}
                      className="text-xs text-gold-dim underline"
                    >
                      Edit
                    </button>
                  ) : !isMine ? (
                    // Only on other people's. Reporting your own review is not
                    // a thing anyone needs to do.
                    <ReportButton
                      targetType="REVIEW"
                      targetId={review.id}
                      label="Report this review"
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
