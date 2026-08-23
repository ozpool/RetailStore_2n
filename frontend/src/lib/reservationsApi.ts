import { ApiError } from "@/lib/api";

export type HeldReservation = {
  id: string;
  listingId: string;
  quantity: number;
  expiresAt: string;
  createdAt: string;
  listing: {
    slug: string;
    title: string;
    priceCents: number;
    currency: string;
    image: string | null;
  };
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/reservations${path}`, {
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

export type CartSummary = {
  /** Held lines plus the lines of an unpaid order. What the nav badge shows. */
  count: number;
  heldCount: number;
  openOrderItems: number;
  /** When the soonest hold lapses, so the client can refresh exactly then. */
  nextExpiresAt: string | null;
  openOrder: { id: string; reference: string; status: string } | null;
};

export function getMyHolds() {
  return request<{ reservations: HeldReservation[]; holdMinutes: number }>("");
}

export function getCartSummary() {
  return request<CartSummary>("/summary");
}

export function holdListing(listingId: string, quantity = 1) {
  return request<{
    reservation: {
      id: string;
      listingId: string;
      quantity: number;
      expiresAt: string;
      remainingQuantity: number;
    };
  }>("", { method: "POST", body: JSON.stringify({ listingId, quantity }) });
}

export function releaseHold(reservationId: string) {
  return request<void>(`/${reservationId}`, { method: "DELETE" });
}
