import { ApiError } from "@/lib/api";

export type NotificationType =
  | "SALE_MADE"
  | "ORDER_SHIPPED"
  | "ORDER_DELIVERED"
  | "ORDER_UNFULFILLABLE"
  | "REFUND_ISSUED"
  | "REVIEW_RECEIVED"
  | "IDENTITY_VERIFIED"
  | "IDENTITY_REJECTED"
  | "LISTING_REMOVED"
  | "ACCOUNT_SUSPENDED"
  | "REPORT_RESOLVED";

export type Notification = {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/notifications${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(body.error ?? "Something went wrong.", body.code, body.field);
  }
  return body as T;
}

export function getNotifications(opts: { unreadOnly?: boolean; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.unreadOnly) params.set("unread", "true");
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return request<{ notifications: Notification[]; unread: number }>(qs ? `?${qs}` : "");
}

/** Just the count, for the nav bell. */
export function getUnreadCount() {
  return request<{ unread: number }>("/count");
}

export function markNotificationRead(id: string) {
  return request<{ unread: number }>(`/${id}/read`, { method: "POST" });
}

export function markAllNotificationsRead() {
  return request<{ marked: number; unread: number }>("/read-all", { method: "POST" });
}

export function deleteNotification(id: string) {
  return request<void>(`/${id}`, { method: "DELETE" });
}

/**
 * A small glyph per type, so a list of ten is scannable.
 *
 * Paired with the title text, never standing alone — an icon by itself is not
 * something a screen reader can convey.
 */
export const NOTIFICATION_ICON: Record<NotificationType, string> = {
  SALE_MADE: "£",
  ORDER_SHIPPED: "→",
  ORDER_DELIVERED: "✓",
  ORDER_UNFULFILLABLE: "!",
  REFUND_ISSUED: "↩",
  REVIEW_RECEIVED: "★",
  IDENTITY_VERIFIED: "✓",
  IDENTITY_REJECTED: "!",
  LISTING_REMOVED: "!",
  ACCOUNT_SUSPENDED: "!",
  REPORT_RESOLVED: "·",
};

/** Types that carry bad news, so they can be toned differently. */
export const IS_BAD_NEWS: Record<NotificationType, boolean> = {
  SALE_MADE: false,
  ORDER_SHIPPED: false,
  ORDER_DELIVERED: false,
  ORDER_UNFULFILLABLE: true,
  // Money coming back is not bad news in itself — it is the resolution of
  // something that was. Toned neutrally.
  REFUND_ISSUED: false,
  REVIEW_RECEIVED: false,
  IDENTITY_VERIFIED: false,
  IDENTITY_REJECTED: true,
  LISTING_REMOVED: true,
  ACCOUNT_SUSPENDED: true,
  REPORT_RESOLVED: false,
};

/** "3 minutes ago" — short, because these sit in a narrow dropdown. */
export function timeAgo(iso: string) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/* ------------------------------------------------------------------ *
 * Delivery preferences
 *
 * Per type AND per channel, deliberately. A single "email me" switch is too
 * coarse in a way that matters: somebody who finds review notifications noisy
 * would turn email off, and that same switch carries REFUND_ISSUED.
 *
 * See docs/adr/0027-notification-consent-and-preferences.md
 * ------------------------------------------------------------------ */

export type DeliveryChannel = "EMAIL" | "PUSH" | "SMS";

export type ChannelPreference = {
  channel: DeliveryChannel;
  enabled: boolean;
  /** True when this is the product's default rather than the user's choice. */
  isDefault: boolean;
};

export type TypePreference = {
  type: NotificationType;
  /** Only channels this type is ever sent on. A switch that does nothing is
   *  worse than no switch — it makes people think they turned something on. */
  channels: ChannelPreference[];
};

export function getPreferences() {
  return request<{ preferences: TypePreference[] }>("/preferences");
}

export function setPreference(input: {
  type: NotificationType;
  channel: DeliveryChannel;
  enabled: boolean;
}) {
  return request<{ preferences: TypePreference[] }>("/preferences", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

/** What an unsubscribe link would do. Does NOT do it — see the route. */
export function inspectUnsubscribe(token: string) {
  return request<{
    channel: DeliveryChannel;
    scope: NotificationType | "all";
    email: string;
    alwaysSent: NotificationType[];
  }>(`/unsubscribe?token=${encodeURIComponent(token)}`);
}

export function confirmUnsubscribe(token: string) {
  return request<{ ok: true; turnedOff: number; scope: string; refused?: boolean }>(
    "/unsubscribe",
    { method: "POST", body: JSON.stringify({ token }) }
  );
}

/** Plain-language labels. The enum name is not a thing to show anybody. */
export const NOTIFICATION_LABEL: Record<NotificationType, string> = {
  SALE_MADE: "Something you listed sold",
  ORDER_SHIPPED: "An order you placed was sent",
  ORDER_DELIVERED: "An order you sold arrived",
  ORDER_UNFULFILLABLE: "An order can't be sent",
  REFUND_ISSUED: "You were refunded",
  REVIEW_RECEIVED: "Someone reviewed what you sold",
  IDENTITY_VERIFIED: "Your identity check passed",
  IDENTITY_REJECTED: "Your identity check didn't pass",
  LISTING_REMOVED: "One of your listings was removed",
  ACCOUNT_SUSPENDED: "Your account was suspended",
  REPORT_RESOLVED: "Something you reported was reviewed",
};

export const CHANNEL_LABEL: Record<DeliveryChannel, string> = {
  EMAIL: "Email",
  PUSH: "Push",
  SMS: "Text",
};

/* ------------------------------------------------------------------ *
 * Push devices
 * ------------------------------------------------------------------ */

export type PushDevice = {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
};

export function getPushKey() {
  return request<{ enabled: boolean; publicKey: string | null }>("/push/key");
}

export function getPushDevices() {
  return request<{ devices: PushDevice[] }>("/push/devices");
}

export function subscribePush(sub: PushSubscriptionJSON) {
  return request<{ ok: true }>("/push/subscribe", {
    method: "POST",
    body: JSON.stringify(sub),
  });
}

export function unsubscribePush(endpoint: string) {
  return request<{ removed: number }>("/push/unsubscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint }),
  });
}

/**
 * The VAPID public key arrives base64url and the Push API wants a Uint8Array.
 * There is no browser built-in for this conversion, which is why every Web Push
 * guide carries a copy of it.
 */
export function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalised);
  // Backed by an explicit ArrayBuffer, not the default ArrayBufferLike. The
  // Push API wants a BufferSource, and a Uint8Array that might sit on a
  // SharedArrayBuffer does not satisfy it.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Whether this browser can do Web Push at all. iOS only inside a home-screen app. */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}
