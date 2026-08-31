import crypto from "crypto";
import { API } from "./db";
import { env } from "../../src/lib/stripeClient";

/**
 * Signs webhook payloads the way Stripe does, so tests exercise the real
 * verifier rather than a bypass.
 *
 * This matters more than it looks. The signature check IS the security model
 * for that endpoint — without it, anyone who found the URL could post "this
 * order is paid" or "this seller is verified". A test that skipped signing
 * would be testing a door with the lock taken off.
 */

export function hasWebhookSecret() {
  return Boolean(env("STRIPE_WEBHOOK_SECRET"));
}

function sign(payload: string) {
  const secret = env("STRIPE_WEBHOOK_SECRET");
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  const ts = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${payload}`)
    .digest("hex");
  return `t=${ts},v1=${signature}`;
}

async function deliver(payload: string, signature: string | null) {
  const res = await fetch(`${API}/webhooks/stripe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(signature ? { "stripe-signature": signature } : {}),
    },
    body: payload,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function envelope(type: string, object: Record<string, unknown>) {
  return JSON.stringify({
    id: `evt_${crypto.randomBytes(8).toString("hex")}`,
    object: "event",
    api_version: "2026-07-29.dahlia",
    created: Math.floor(Date.now() / 1000),
    type,
    data: { object },
  });
}

/** A correctly signed event. */
export function send(type: string, object: Record<string, unknown>) {
  const payload = envelope(type, object);
  return deliver(payload, sign(payload));
}

/** No signature header at all. */
export function sendUnsigned(type: string, object: Record<string, unknown>) {
  return deliver(envelope(type, object), null);
}

/** A signature that is present but wrong. */
export function sendForged(type: string, object: Record<string, unknown>) {
  return deliver(envelope(type, object), "t=1,v1=deadbeef");
}

export function identitySession(id: string, extra: Record<string, unknown> = {}) {
  return { object: "identity.verification_session", id, ...extra };
}

/**
 * A Stripe Refund object, as the refund events carry it.
 *
 * `status` is the whole point: succeeded, failed, canceled, pending, or
 * requires_action. The handler maps canceled onto failed, so both have to be
 * reachable from a test.
 */
export function refundObject(
  id: string,
  status: "succeeded" | "failed" | "canceled" | "pending" | "requires_action",
  extra: Record<string, unknown> = {}
) {
  return { object: "refund", id, status, ...extra };
}
