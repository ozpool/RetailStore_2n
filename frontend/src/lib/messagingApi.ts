import { ApiError } from "@/lib/api";

/**
 * The seller's side of talking to the platform, and of asking for a slot.
 *
 * See docs/adr/0033-seller-admin-messaging.md
 *     docs/adr/0034-paid-homepage-placement.md
 */

export type MessageAuthor = "SELLER" | "ADMIN";

export type PlacementSlot = "HERO" | "PICKED_SHELF";

export type PlacementStatus =
  | "REQUESTED"
  | "COUNTERED"
  | "AGREED"
  | "LIVE"
  | "ENDED"
  | "DECLINED"
  | "WITHDRAWN";

export type ThreadSummary = {
  id: string;
  kind: "PLACEMENT" | "SUPPORT";
  subject: string;
  lastMessageAt: string;
  closedAt: string | null;
  unread: number;
  placement: { id: string; status: PlacementStatus; slot: PlacementSlot } | null;
};

export type ThreadMessage = {
  id: string;
  author: MessageAuthor;
  body: string;
  createdAt: string;
};

export type ThreadDetail = ThreadSummary & {
  seller: { id: string; shopName: string | null };
  messages: ThreadMessage[];
  placement:
    | (ThreadSummary["placement"] & {
        position: number;
        offeredCents: number;
        agreedCents: number | null;
        startsAt: string | null;
        endsAt: string | null;
        listing: { id: string; title: string; slug: string };
      })
    | null;
};

export type Placement = {
  id: string;
  slot: PlacementSlot;
  position: number;
  offeredCents: number;
  agreedCents: number | null;
  startsAt: string | null;
  endsAt: string | null;
  status: PlacementStatus;
  threadId: string;
  createdAt: string;
  decidedAt: string | null;
  listing: { id: string; title: string; slug: string; status: string };
};

export type SlotInfo = { slot: PlacementSlot; positions: number; label: string };

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

/* ---- threads ---- */

export function getThreads() {
  return request<{ threads: ThreadSummary[]; unreadThreads: number }>("/messages");
}

export function getThread(id: string) {
  return request<{ thread: ThreadDetail }>(`/messages/${id}`);
}

export function replyToThread(id: string, body: string) {
  return request<{ id: string }>(`/messages/${id}/reply`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export function openThread(input: { subject: string; body: string }) {
  return request<{ threadId: string }>("/messages", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/* ---- placement ---- */

export function getSlots() {
  return request<{ slots: SlotInfo[]; disclosure: string }>("/placements/slots");
}

export function getPlacements() {
  return request<{ placements: Placement[] }>("/placements");
}

export function requestPlacement(input: {
  listingId: string;
  slot: PlacementSlot;
  position?: number;
  offeredCents: number;
  startsAt?: string;
  endsAt?: string;
  note: string;
}) {
  return request<{ id: string; threadId: string }>("/placements", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function acceptCounter(id: string, note?: string) {
  return request<{ status: PlacementStatus }>(`/placements/${id}/accept`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

export function withdrawPlacement(id: string, note?: string) {
  return request<{ status: PlacementStatus }>(`/placements/${id}/withdraw`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

/* ---- shared presentation ---- */

export const SLOT_LABEL: Record<PlacementSlot, string> = {
  HERO: "Homepage hero banner",
  PICKED_SHELF: "Featured shelf",
};

/** Whose move it is, said in words rather than left as an enum. */
export const STATUS_LABEL: Record<PlacementStatus, string> = {
  REQUESTED: "Waiting for RetailStore_2n",
  COUNTERED: "Your turn — they proposed different terms",
  AGREED: "Agreed, not live yet",
  LIVE: "Live on the homepage",
  ENDED: "Finished",
  DECLINED: "Declined",
  WITHDRAWN: "Withdrawn",
};
