import { ApiError } from "@/lib/api";

export type SellerListingImage = {
  id: string;
  url: string;
  alt: string | null;
  position: number;
};

export type SellerListing = {
  id: string;
  slug: string;
  title: string;
  description: string;
  condition: string;
  conditionNote: string | null;
  priceCents: number;
  originalPriceCents: number | null;
  currency: string;
  quantity: number;
  status: "DRAFT" | "ACTIVE" | "RESERVED" | "SOLD" | "REMOVED";
  featured: boolean;
  createdAt: string;
  updatedAt: string;
  category: { id: string; slug: string; title: string };
  images: SellerListingImage[];
};

export type SellerProfile = {
  id: string;
  shopName: string;
  bio: string | null;
  kycStatus: "UNSTARTED" | "PENDING" | "VERIFIED" | "REJECTED";
  payoutsEnabled: boolean;
  createdAt: string;
};

export type ListingInput = {
  title: string;
  description: string;
  categoryId: string;
  condition: string;
  conditionNote?: string | null;
  priceCents: number;
  originalPriceCents?: number | null;
  quantity: number;
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/seller${path}`, {
    ...options,
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
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

export function getSellerProfile() {
  return request<{ seller: SellerProfile; counts: Record<string, number> }>("/me");
}

export function getSellerListings() {
  return request<{ listings: SellerListing[] }>("/listings");
}

export function getSellerListing(id: string) {
  return request<{ listing: SellerListing }>(`/listings/${id}`);
}

export function createListing(input: ListingInput) {
  return request<{ listing: SellerListing }>("/listings", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateListing(id: string, input: Partial<ListingInput>) {
  return request<{ listing: SellerListing }>(`/listings/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function publishListing(id: string) {
  return request<{ listing: SellerListing }>(`/listings/${id}/publish`, { method: "POST" });
}

export function unpublishListing(id: string) {
  return request<{ listing: SellerListing }>(`/listings/${id}/unpublish`, { method: "POST" });
}

export function deleteListing(id: string) {
  return request<void>(`/listings/${id}`, { method: "DELETE" });
}

export function uploadListingImage(id: string, file: File) {
  const form = new FormData();
  form.append("image", file);
  return request<{ image: SellerListingImage }>(`/listings/${id}/images`, {
    method: "POST",
    body: form,
  });
}

export function deleteListingImage(id: string, imageId: string) {
  return request<void>(`/listings/${id}/images/${imageId}`, { method: "DELETE" });
}

export type VerificationStatus = "UNSTARTED" | "PENDING" | "VERIFIED" | "REJECTED";

export type Verification = {
  status: VerificationStatus;
  provider: string | null;
  documentType: string | null;
  country: string | null;
  verifiedAt: string | null;
  rejectionReason: string | null;
  payoutsEnabled: boolean;
  /** True when no real identity provider is wired up. Shown to the user. */
  isStub: boolean;
};

export type KycAttempt = {
  id: string;
  provider: string;
  providerSessionId: string;
  status: VerificationStatus;
  documentType: string | null;
  country: string | null;
  rejectionReason: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type DocumentSubmission = {
  documentType: string;
  country: string;
  documentNumber: string;
};

/* ------------------------------------------------------------------ *
 * Payouts
 * ------------------------------------------------------------------ */

export type PayoutSummary = {
  currency: string;
  paidCents: number;
  payableCents: number;
  heldCents: number;
  heldUntil: string | null;
  /** Owed, but the account cannot receive it. Actionable, unlike `held`. */
  withheldCents: number;
  /** Sold and paid for, but not delivered to the buyer yet. */
  inFlightCents: number;
  /** Refunded, or a line the seller couldn't send. Shown so the figures add up. */
  notEarnedCents: number;
  debtCents: number;
  gates: { payoutsEnabled: boolean; payoutsReady: boolean; onboarded: boolean };
};

export type PayableLine = {
  orderItemId: string;
  orderId: string;
  title: string;
  amountCents: number;
  deliveredAt: string;
};

export type PayoutRow = {
  id: string;
  amountCents: number;
  nettedCents: number;
  currency: string;
  status: "PENDING" | "PAID" | "FAILED";
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
  items: { orderItemId: string; amountCents: number; reversedAt: string | null }[];
};

export function getPayouts() {
  return request<{
    summary: PayoutSummary;
    holdDays: number;
    payable: PayableLine[];
    history: PayoutRow[];
    isStub: boolean;
  }>("/payouts");
}

export function startPayoutOnboarding() {
  return request<{ url: string; external: boolean; expiresAt: string }>("/payouts/account", {
    method: "POST",
  });
}

export function refreshPayoutAccount() {
  return request<{ payoutsReady: boolean; detailsSubmitted: boolean; pending: string[] }>(
    "/payouts/account/refresh",
    { method: "POST" }
  );
}

/** Stub provider only. Stands in for Stripe's hosted onboarding. */
export function completeStubOnboarding() {
  return request<{ payoutsReady: boolean }>("/payouts/account/stub-complete", {
    method: "POST",
  });
}

export function runPayout() {
  return request<{ paid: boolean; payoutId?: string; amountCents?: number }>("/payouts/run", {
    method: "POST",
  });
}

export function getVerification() {
  return request<{ verification: Verification; attempts: KycAttempt[] }>("/verification");
}

export function startVerification() {
  return request<{
    session: {
      providerSessionId: string;
      redirectUrl: string;
      /**
       * True when redirectUrl points at the provider's own site rather than
       * ours, so the caller navigates away instead of routing internally. With
       * a real provider the document never touches this application.
       */
      external: boolean;
    };
    resumed: boolean;
  }>("/verification", { method: "POST" });
}

/**
 * Asks the provider where a session stands.
 *
 * The webhook is the primary path; this is the fallback for when one is missed,
 * so a seller isn't left on "pending" forever because of a lost HTTP request.
 */
export function getVerificationSessionStatus(sessionId: string) {
  return request<{
    status: VerificationStatus;
    rejectionReason: string | null;
    payoutsEnabled: boolean;
    settledBy: "poll" | "already" | null;
  }>(`/verification/${sessionId}/status`);
}

export function submitVerification(sessionId: string, input: DocumentSubmission) {
  return request<{
    outcome: "VERIFIED" | "REJECTED";
    rejectionReason: string | null;
    payoutsEnabled: boolean;
  }>(`/verification/${sessionId}/submit`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export const DOCUMENT_TYPE_OPTIONS = [
  { value: "passport", label: "Passport" },
  { value: "drivers_license", label: "Driver's licence" },
  { value: "national_id", label: "National ID card" },
] as const;

/** Forms collect dollars; the API takes integer minor units. */
export function dollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

export function centsToDollars(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(2).replace(/\.00$/, "");
}
