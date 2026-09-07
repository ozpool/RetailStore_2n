import webpush from "web-push";
import { prisma } from "./prisma";

/**
 * Web Push.
 *
 * WHY WEB PUSH AND NOT FCM OR APNs
 * There is no mobile app. Web Push works in the browser that is already open,
 * needs no store listing, no native build and no signing certificates, and one
 * subscription covers desktop and Android. iOS supports it only for pages added
 * to the home screen — that is the honest limit, and it is stated in the UI
 * rather than discovered.
 *
 * WHAT VAPID IS FOR
 * The keypair identifies this server to the browser's push service. The private
 * half signs each request; the public half is handed to the browser at
 * subscribe time and is baked into the subscription, so ROTATING IT INVALIDATES
 * EVERY EXISTING SUBSCRIPTION. Not a secret rotation to do casually.
 *
 * See docs/plans/0001-multi-channel-notifications.md, phase 3.
 */

function env(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

export function isPushConfigured(): boolean {
  return Boolean(env("VAPID_PUBLIC_KEY") && env("VAPID_PRIVATE_KEY"));
}

/**
 * The public key the browser needs in order to subscribe.
 *
 * Safe to serve to anyone — it is public by design, and a subscription made
 * with it is still useless to anybody without the private half.
 */
export function vapidPublicKey(): string | null {
  return env("VAPID_PUBLIC_KEY") ?? null;
}

/**
 * The contact address in the VAPID claim. Push services use it to reach an
 * operator whose sender is misbehaving, before they start rejecting it.
 */
function subject(): string {
  return env("VAPID_SUBJECT") ?? "mailto:no-reply@retailstore-2n.local";
}

let configured = false;

function ensureConfigured() {
  if (configured) return;
  const publicKey = env("VAPID_PUBLIC_KEY");
  const privateKey = env("VAPID_PRIVATE_KEY");
  if (!publicKey || !privateKey) {
    throw new Error("VAPID keys are not configured");
  }
  webpush.setVapidDetails(subject(), publicKey, privateKey);
  configured = true;
}

/**
 * Reported at startup, not fatal.
 *
 * Same policy as Redis and object storage: an unconfigured push channel is a
 * missing feature, not a broken server, and refusing to boot over it would turn
 * "we have not set up push yet" into an outage. Printed loudly so nobody has to
 * guess why nothing is arriving.
 */
export function assertPushConfigured(): string {
  if (!isPushConfigured()) {
    return "not configured (no VAPID keys) — nobody can subscribe";
  }
  return `web push, as ${subject()}`;
}

export type PushPayload = {
  title: string;
  body: string | null;
  /** A path within the app. The service worker resolves it against its origin. */
  url: string | null;
  /**
   * Collapses notifications on the device: a second one with the same tag
   * replaces the first rather than stacking. Keyed by event, so a redelivery
   * that somehow got past the ledger still shows once.
   */
  tag: string;
};

export type PushResult = { sent: number; removed: number };

/**
 * Sends to every device this user has subscribed.
 *
 * DEAD SUBSCRIPTIONS ARE DELETED, NOT RETRIED. A 404 or 410 from a push service
 * is the protocol saying that browser is gone for good — the user cleared site
 * data, uninstalled, or revoked permission. Retrying it never succeeds, and
 * keeping it means every future send pays for a request that cannot work. Any
 * other status is left alone, because a 503 is a bad minute rather than a dead
 * device.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<PushResult> {
  ensureConfigured();

  const subs = await prisma.pushSubscription.findMany({
    where: { userId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });

  if (subs.length === 0) return { sent: 0, removed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  const dead: string[] = [];
  const alive: string[] = [];
  /**
   * COLLECTED IN AN ARRAY rather than a single mutable `let`, and not for
   * style. The failures happen inside the `Promise.all` callback below, and
   * TypeScript's flow analysis does not model a callback having run: a
   * `let lastError: Error | null` reads as `null` at the throw site no matter
   * what it is annotated as, which makes the rethrow a `throw null` as far as
   * the compiler and `only-throw-error` are concerned. Pushing to a const array
   * sidesteps flow narrowing entirely and is the more honest shape anyway —
   * three dead endpoints produce three errors, and only one of them was ever
   * being kept.
   */
  const failures: Error[] = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body,
          { TTL: 60 * 60 * 24 }
        );
        sent += 1;
        alive.push(sub.id);
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          dead.push(sub.id);
        } else {
          failures.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    })
  );

  if (dead.length > 0) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: dead } } });
  }
  if (alive.length > 0) {
    await prisma.pushSubscription.updateMany({
      where: { id: { in: alive } },
      data: { lastSeenAt: new Date() },
    });
  }

  /**
   * Only if NOTHING landed. One device out of three failing is not a failed
   * delivery — the person got the notification. Throwing there would record a
   * failure for a message they are currently reading.
   */
  if (sent === 0 && failures.length > 0) throw failures[failures.length - 1];

  return { sent, removed: dead.length };
}

/**
 * Registers a browser.
 *
 * UPSERT ON THE ENDPOINT, WHICH IS WHAT MOVES A DEVICE BETWEEN ACCOUNTS.
 * Somebody signs out and a colleague signs in on the same laptop: the second
 * subscribe rewrites the row's userId instead of adding a second one, so the
 * first account stops receiving notifications on a browser it no longer owns.
 * Scoping this per user would leave both — a privacy failure, not a duplicate.
 */
export async function saveSubscription(input: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}): Promise<void> {
  await prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: {
      userId: input.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
    },
    update: {
      userId: input.userId,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
      lastSeenAt: new Date(),
    },
  });
}

/** Scoped by user, so nobody can unsubscribe somebody else's device. */
export async function removeSubscription(
  userId: string,
  endpoint: string
): Promise<number> {
  const { count } = await prisma.pushSubscription.deleteMany({
    where: { userId, endpoint },
  });
  return count;
}

export function listSubscriptions(userId: string) {
  return prisma.pushSubscription.findMany({
    where: { userId },
    select: { id: true, userAgent: true, createdAt: true, lastSeenAt: true },
    orderBy: { lastSeenAt: "desc" },
  });
}
