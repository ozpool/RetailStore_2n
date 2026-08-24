import { ApiError } from "@/lib/api";

/**
 * Orders and payment.
 *
 * The card number is passed to payOrder() and never stored, never put in
 * component state that outlives the request, and never sent anywhere except
 * this one call. See docs/adr/0013-payment-provider-seam.md.
 */

export type OrderStatus =
  | "PENDING_PAYMENT"
  | "PROCESSING"
  | "PAID"
  | "FAILED"
  | "CANCELLED"
  | "REFUNDED";

export type OrderItem = {
  id: string;
  /** Snapshotted at purchase, so it says what was bought even if the seller renames it. */
  title: string;
  unitPriceCents: number;
  quantity: number;
  sellerName: string;
  slug: string | null;
  image: string | null;
  /** Per line, because a basket can span sellers and they ship separately. */
  fulfilment: "UNFULFILLED" | "SHIPPED" | "DELIVERED" | "UNFULFILLABLE";
  shippedAt: string | null;
  deliveredAt: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  fulfilmentNote: string | null;
};

/** The address as it was at checkout — a copy, not a link to the address book. */
export type ShipTo = {
  fullName: string | null;
  line1: string;
  line2: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  country: string | null;
  phone: string | null;
};

export type RefundStatus = "PENDING" | "SUCCEEDED" | "FAILED";
export type RefundTrigger = "SELLER_UNFULFILLABLE" | "ADMIN" | "BUYER_RETURN";

export type Refund = {
  id: string;
  /** Null when the whole order was refunded rather than one line. */
  orderItemId: string | null;
  amountCents: number;
  currency: string;
  status: RefundStatus;
  trigger: RefundTrigger;
  /** Shown to the buyer verbatim — the seller's or moderator's own words. */
  reason: string;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
};

/** A refund as it appears in the buyer's own list, across all their orders. */
export type MyRefund = {
  id: string;
  amountCents: number;
  currency: string;
  status: RefundStatus;
  trigger: RefundTrigger;
  reason: string;
  createdAt: string;
  completedAt: string | null;
  orderId: string;
  orderReference: string;
  /** The line's snapshotted title, so it survives the listing being deleted. */
  itemTitle: string | null;
};

export type Order = {
  id: string;
  /** Short, speakable reference for support conversations. */
  reference: string;
  status: OrderStatus;
  subtotalCents: number;
  currency: string;
  paymentProvider: string | null;
  /** True when no real money can move. Decided by the API, not guessed here. */
  testMode: boolean;
  paidAt: string | null;
  failureReason: string | null;
  createdAt: string;
  shipTo: ShipTo | null;
  items: OrderItem[];
  /** Present on the detail endpoint only; the list has no use for them. */
  refunds?: Refund[];
};

export type PaymentOutcome = "succeeded" | "failed" | "pending";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/orders${path}`, {
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

export function getMyOrders() {
  return request<{ orders: Order[] }>("");
}

export function getOrder(orderId: string) {
  return request<{ order: Order }>(`/${orderId}`);
}

/** The buyer confirms an item arrived. Deliberately not the seller's call. */
/** Every refund this buyer has received, newest first. */
export function getMyRefunds() {
  return request<{ refunds: MyRefund[] }>("/refunds");
}

/* ------------------------------------------------------------------ *
 * Returns
 * ------------------------------------------------------------------ */

export type ReturnStatus =
  | "OPEN"
  | "APPROVED"
  | "REFUSED"
  | "ESCALATED"
  | "REJECTED"
  | "WITHDRAWN";

export type MyReturn = {
  id: string;
  orderItemId: string;
  orderId: string;
  status: ReturnStatus;
  /** The buyer's own words. */
  reason: string;
  notAsDescribed: boolean;
  /** The answer, in the answerer's words. Null while OPEN. */
  decisionNote: string | null;
  decidedAt: string | null;
  refundId: string | null;
  createdAt: string;
  title: string;
  amountCents: number;
  sellerName: string | null;
  deliveredAt: string | null;
  orderReference: string | null;
};

/**
 * Whether a line can be returned, asked before the control is offered.
 *
 * `eligible: false` is a 200, not an error: "the window closed on the 14th" is
 * an answer, and the page shows it instead of a button that would fail.
 */
export type ReturnEligibility =
  | { eligible: true; title: string; amountCents: number; deadline: string; windowDays: number }
  | {
      eligible: false;
      code: string;
      error: string;
      deadline: string | null;
      windowDays: number;
    };

export function checkReturnEligibility(orderItemId: string) {
  return request<ReturnEligibility>(`/items/${orderItemId}/return`);
}

export function getMyReturns() {
  return request<{ returns: MyReturn[]; windowDays: number }>("/returns");
}

export function startReturn(
  orderItemId: string,
  input: { reason: string; notAsDescribed: boolean }
) {
  return request<{ id: string; deadline: string }>(`/items/${orderItemId}/return`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function withdrawReturn(id: string) {
  return request<{ status: ReturnStatus }>(`/returns/${id}/withdraw`, { method: "POST" });
}

/** Asks a moderator to look at a refusal. Only valid on a REFUSED return. */
export function escalateReturn(id: string) {
  return request<{ status: ReturnStatus }>(`/returns/${id}/escalate`, { method: "POST" });
}

export function confirmDelivery(orderItemId: string) {
  return request<{ ok: true }>(`/items/${orderItemId}/delivered`, { method: "POST" });
}

/** Converts the buyer's live holds into an order and opens a payment for it. */
export function startCheckout() {
  return request<{
    order: Order;
    payment: {
      intentId: string;
      clientSecret: string | null;
      amountCents: number;
      currency: string;
      isStub: boolean;
    };
  }>("", { method: "POST" });
}

export function payOrder(orderId: string, cardNumber: string) {
  return request<{
    outcome: PaymentOutcome;
    reason: string | null;
    order: Order;
  }>(`/${orderId}/pay`, {
    method: "POST",
    body: JSON.stringify({ cardNumber }),
  });
}

export function cancelOrder(orderId: string) {
  return request<{ order: Order }>(`/${orderId}/cancel`, { method: "POST" });
}

/** An order still holding stock, so it can be resumed or cancelled. */
export function isOpen(order: Order) {
  return order.status === "PENDING_PAYMENT" || order.status === "PROCESSING";
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "Awaiting payment",
  PROCESSING: "Payment in progress",
  PAID: "Paid",
  FAILED: "Payment failed",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
};

/**
 * Test cards, offered as one-tap fills on the payment form.
 *
 * Same numbers work against the stub and against Stripe test mode — in Stripe
 * mode the API maps them to test payment-method tokens, so no card number ever
 * reaches Stripe.
 */
export const TEST_CARDS = [
  { number: "4242424242424242", label: "Succeeds" },
  { number: "4000000000000002", label: "Declined" },
  { number: "4000000000000069", label: "Expired card" },
  { number: "4000002500003155", label: "Needs authentication" },
] as const;
