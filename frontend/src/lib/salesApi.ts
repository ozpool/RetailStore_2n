import { ApiError } from "@/lib/api";

export type FulfilmentStatus = "UNFULFILLED" | "SHIPPED" | "DELIVERED" | "UNFULFILLABLE";

export type Sale = {
  id: string;
  title: string;
  unitPriceCents: number;
  quantity: number;
  currency: string;
  slug: string | null;
  image: string | null;
  order: {
    id: string;
    reference: string;
    buyerName: string;
    paidAt: string | null;
    placedAt: string;
  };
  fulfilment: FulfilmentStatus;
  /**
   * Whether the money for this line has gone back.
   *
   * Not derivable from `fulfilment`: a moderator can refund a line that shipped
   * and arrived after a dispute, so DELIVERED and refunded is a real state.
   */
  refunded: boolean;
  shippedAt: string | null;
  deliveredAt: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  fulfilmentNote: string | null;
  /** Released only once the order is paid. */
  shipTo: {
    fullName: string | null;
    line1: string;
    line2: string | null;
    city: string | null;
    region: string | null;
    postcode: string | null;
    country: string | null;
    phone: string | null;
  } | null;
};

export type SalesSummary = {
  toSend: number;
  shipped: number;
  delivered: number;
  /**
   * Lines whose money went back, counted separately and EXCLUDED from
   * `soldCount` and `grossCents` — a sale that was refunded is not something
   * the seller sold, and certainly not something they earned.
   *
   * This field was returned by the API and missing from this type, so nothing
   * warned that the page was dropping it. The totals were right and the reason
   * they were lower than the rows beneath them was invisible.
   */
  refunded: number;
  soldCount: number;
  /** Gross, before any fee. Not a payout balance — there is no payout pipeline. */
  grossCents: number;
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/seller${path}`, {
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

export function getSales(filter: "all" | "to_send" | "sent" = "all") {
  return request<{ sales: Sale[]; summary: SalesSummary }>(`/sales?filter=${filter}`);
}

export function markShipped(
  saleId: string,
  input: { carrier?: string | null; trackingNumber?: string | null }
) {
  return request<{ sale: Sale }>(`/sales/${saleId}/ship`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function markCannotSend(saleId: string, reason: string) {
  /**
   * The shape here drifted from the API and nothing caught it: this declared
   * `refundOwed: boolean` long after the route stopped returning it. Only
   * `note` was ever read, so it typechecked and rendered correctly while
   * describing a response that no longer existed — and anybody reaching for
   * the refund outcome would have found it missing from the type rather than
   * from the wire.
   */
  return request<{
    ok: true;
    /** Whether the refund actually went through, reported rather than assumed. */
    refunded: boolean;
    refundCents: number;
    refundStatus: string | null;
    /** The provider's own words when it refused. */
    refundError: string | null;
    note: string;
  }>(
    `/sales/${saleId}/cannot-send`,
    { method: "POST", body: JSON.stringify({ reason }) }
  );
}

export const FULFILMENT_LABEL: Record<FulfilmentStatus, string> = {
  UNFULFILLED: "Needs sending",
  SHIPPED: "Sent",
  DELIVERED: "Delivered",
  UNFULFILLABLE: "Couldn't be sent",
};

/** The buyer's side of the same field, phrased from their point of view. */
export const BUYER_FULFILMENT_LABEL: Record<FulfilmentStatus, string> = {
  UNFULFILLED: "Awaiting dispatch",
  SHIPPED: "On its way",
  DELIVERED: "Delivered",
  UNFULFILLABLE: "Seller couldn't send it",
};

/* ------------------------------------------------------------------ *
 * Returns the seller has to answer
 * ------------------------------------------------------------------ */

export type SellerReturn = {
  id: string;
  orderItemId: string;
  orderId: string;
  status: "OPEN" | "APPROVED" | "REFUSED" | "ESCALATED" | "REJECTED" | "WITHDRAWN";
  /** The buyer's own words. Shown verbatim — they wrote it for the seller. */
  reason: string;
  notAsDescribed: boolean;
  decisionNote: string | null;
  decidedAt: string | null;
  refundId: string | null;
  createdAt: string;
  title: string;
  amountCents: number;
  orderReference: string | null;
  deliveredAt: string | null;
};

export function getSellerReturns(filter: "all" | "open" = "all") {
  return request<{ returns: SellerReturn[] }>(
    `/returns${filter === "open" ? "?filter=open" : ""}`
  );
}

/**
 * Approving issues the refund. A `502 REFUND_FAILED` means nothing moved and
 * the request is back to OPEN — worth retrying rather than a decision that
 * stuck.
 */
export function respondToReturn(
  id: string,
  input: { approve: boolean; note?: string }
) {
  return request<{ status: SellerReturn["status"]; refundId?: string }>(
    `/returns/${id}/respond`,
    { method: "POST", body: JSON.stringify(input) }
  );
}
