import { ApiError } from "@/lib/api";

export const MAX_REVIEW_BODY = 2000;

export type ListingReview = {
  id: string;
  rating: number;
  body: string | null;
  createdAt: string;
  edited: boolean;
  authorId: string;
  authorName: string;
  /** Backed by a real paid order. Computed server-side, never assumed. */
  verified: boolean;
};

export type MyReviewSummary = {
  id: string;
  rating: number;
  body: string | null;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
};

export type Eligibility = {
  canReview: boolean;
  reason: string | null;
  code: "OK" | "NOT_PURCHASED" | "OWN_LISTING" | "GONE";
  mine: MyReviewSummary | null;
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/reviews${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(
      body.error ?? "Something went wrong. Please try again.",
      body.code,
      body.field
    );
  }

  return body as T;
}

/** Whether the viewer may review this listing, and what they already wrote. */
export function getReviewEligibility(listingId: string) {
  return request<Eligibility>(`/for/${listingId}`);
}

/** Posts a review, or replaces the one already left for this listing. */
export function postReview(input: {
  listingId: string;
  rating: number;
  body: string | null;
}) {
  return request<{ review: ListingReview }>("", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateReview(reviewId: string, input: { rating: number; body: string | null }) {
  return request<{ review: Omit<ListingReview, "authorId" | "authorName"> }>(`/${reviewId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function removeReview(reviewId: string) {
  return request<void>(`/${reviewId}`, { method: "DELETE" });
}
