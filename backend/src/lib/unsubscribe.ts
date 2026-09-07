import crypto from "crypto";
import { DeliveryChannel, NotificationType } from "../generated/prisma/enums";

/**
 * Unsubscribe links that work without signing in.
 *
 * AN UNSUBSCRIBE THAT REQUIRES A PASSWORD IS AN UNSUBSCRIBE PEOPLE REPLACE WITH
 * THE SPAM BUTTON, and a spam report costs the sending domain far more than the
 * mail it was objecting to. So the link carries its own authority.
 *
 * That means the token has to be unguessable and unforgeable, and it must not
 * be a session. It authorises exactly one thing: turning off one channel for
 * one event type — or all optional mail — for the user it names. It cannot log
 * anybody in, read anything, or turn a notification back on.
 *
 * WHY NO EXPIRY
 * A link in a two-year-old email is exactly when somebody wants to unsubscribe,
 * and an expired one sends them to a page that says no. The token stays valid
 * for as long as the secret does. Rotating JWT_SECRET invalidates every
 * outstanding link along with every session, which is the correct blast radius.
 *
 * See docs/adr/0027-notification-consent-and-preferences.md
 */

/**
 * A separate key, derived rather than configured — exactly as lib/adminAuth.ts
 * derives its own. Separate so an unsubscribe token can never be presented as
 * a session token even if the verifying code is confused; derived so there is
 * not a second environment variable to forget to set, which would silently fall
 * back to the main secret and undo the separation.
 */
function key(): Buffer {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error("JWT_SECRET is not set");
  return crypto.createHmac("sha256", base).update("retailstore-2n:unsubscribe:v1").digest();
}

/** `all` turns off every optional type on the channel. */
export type UnsubscribeScope = NotificationType | "all";

export type UnsubscribeToken = {
  userId: string;
  channel: DeliveryChannel;
  scope: UnsubscribeScope;
};

function payload(t: UnsubscribeToken): string {
  return `${t.userId}.${t.channel}.${t.scope}`;
}

function sign(body: string): string {
  return crypto.createHmac("sha256", key()).update(body).digest("base64url");
}

export function mintUnsubscribeToken(t: UnsubscribeToken): string {
  const body = Buffer.from(payload(t), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

/**
 * Returns null on anything that does not verify, without saying which part
 * failed. A tampered token and an unknown one are the same answer.
 */
export function readUnsubscribeToken(token: string | undefined): UnsubscribeToken | null {
  if (!token) return null;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const expected = sign(body);
  // Constant time: a byte-by-byte comparison leaks how much of a forged MAC was
  // correct, which is enough to construct one given enough attempts.
  if (
    mac.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
  ) {
    return null;
  }

  const [userId, channel, scope] = Buffer.from(body, "base64url")
    .toString("utf8")
    .split(".");

  if (!userId || !channel) return null;
  if (!Object.values(DeliveryChannel).includes(channel as DeliveryChannel)) return null;
  if (
    scope !== "all" &&
    !Object.values(NotificationType).includes(scope as NotificationType)
  ) {
    return null;
  }

  return {
    userId,
    channel: channel as DeliveryChannel,
    scope: scope as UnsubscribeScope,
  };
}

function frontendOrigin(): string {
  return process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
}

/** Where the recipient lands. A page, not an endpoint — see below. */
export function unsubscribeUrl(t: UnsubscribeToken): string {
  return `${frontendOrigin()}/unsubscribe?token=${mintUnsubscribeToken(t)}`;
}

/**
 * The headers that make the mail client's own "unsubscribe" button work.
 *
 * WHY BOTH HEADERS, AND WHY THE POST ONE MATTERS
 * `List-Unsubscribe` alone offers a link. Gmail and Outlook only show their
 * built-in unsubscribe control when `List-Unsubscribe-Post` is present too,
 * because that is what promises a single POST will do the job with no page to
 * click through. Without it, people use the spam button instead, and that is
 * the outcome this whole mechanism exists to avoid.
 *
 * The POST target is the API directly. The mailto and the browser link go to
 * the frontend page, which asks for a confirmation — because a link in an email
 * gets fetched by scanners and prefetchers that would otherwise silently
 * unsubscribe people who never clicked anything.
 */
export function unsubscribeHeaders(t: UnsubscribeToken): Record<string, string> {
  const token = mintUnsubscribeToken(t);
  const api = process.env.PUBLIC_API_BASE ?? `http://localhost:${process.env.PORT ?? 4000}`;
  return {
    "List-Unsubscribe": `<${api}/notifications/unsubscribe?token=${token}>, <${unsubscribeUrl(t)}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
