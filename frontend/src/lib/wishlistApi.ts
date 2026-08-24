import { ApiError } from "@/lib/api";

export type WishlistEntry = {
  id: string;
  savedAt: string;
  listing: {
    id: string;
    slug: string;
    title: string;
    priceCents: number;
    originalPriceCents: number | null;
    currency: string;
    condition: string;
    conditionNote: string | null;
    image: string | null;
    imageAlt: string | null;
    sellerName: string;
    /** It sold while it was on the list. Said plainly rather than hidden. */
    sold: boolean;
    available: boolean;
  };
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/wishlist${path}`, {
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

export function getWishlist() {
  return request<{ items: WishlistEntry[]; count: number }>("");
}

/** Ids only — what a grid of hearts and the nav badge need. */
export function getWishlistIds() {
  return request<{ listingIds: string[]; count: number }>("/ids");
}

/** Idempotent: saving something already saved is a success. */
export function saveToWishlist(listingId: string) {
  return request<{ saved: boolean; count: number }>(`/${listingId}`, { method: "PUT" });
}

export function removeFromWishlist(listingId: string) {
  return request<{ saved: boolean; count: number }>(`/${listingId}`, { method: "DELETE" });
}
