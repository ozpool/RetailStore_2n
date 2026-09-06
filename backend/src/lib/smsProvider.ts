import { env } from "./stripeClient";
import { maskPhone } from "./phone";

/**
 * The SMS provider seam.
 *
 * Same shape as payments (ADR 0013) and identity (ADR 0006), for the same
 * reason: CI must never send a real message and must never need a secret to
 * pass. A fork's pull request runs the whole SMS path against the stub.
 *
 *   stub    — records the message in memory and returns a fake id. The
 *             default, and what the suite runs.
 *   twilio  — the real thing.
 *
 * WHY THE REST API AND NOT THE `twilio` SDK
 * Sending one SMS is a single form-encoded POST with basic auth. The Stripe SDK
 * earns its place because Stripe's surface here is large — PaymentIntents,
 * Refunds, Identity, and webhook signature verification, which is subtle enough
 * that hand-rolling it would be a bug farm. None of that applies to one
 * endpoint. A dependency that exists to save fifteen lines is fifteen lines of
 * someone else's supply chain.
 *
 * WHAT IS NEVER LOGGED
 * The message body and the full number. The body carries order details, and a
 * number in a log is personal data in the system with the weakest access
 * controls in the stack. Errors carry a masked number and the provider's code.
 */

export const SMS_PROVIDER = env("SMS_PROVIDER") ?? "stub";

export function isStubSms(): boolean {
  return SMS_PROVIDER === "stub";
}

export type SentSms = { providerMessageId: string };

/**
 * A provider failure, carrying whether trying again could plausibly help.
 *
 * The caller turns `permanent` into `PermanentFailure` so the retry ladder
 * routes it. Deciding here rather than at the call site is deliberate: only
 * this file knows what a Twilio error code means.
 */
export class SmsSendError extends Error {
  readonly permanent: boolean;
  readonly code: string | number | null;

  constructor(message: string, opts: { permanent: boolean; code?: string | number | null }) {
    super(message);
    this.name = "SmsSendError";
    this.permanent = opts.permanent;
    this.code = opts.code ?? null;
  }
}

/* ------------------------------------------------------------------ *
 * Which failures are worth retrying
 * ------------------------------------------------------------------ */

/**
 * Twilio error codes that will produce the identical result on every retry.
 *
 * Retrying these is not merely wasteful. 21610 is a recipient who texted STOP;
 * sending again is the thing they explicitly refused, and in most jurisdictions
 * it is also unlawful. 21211 is a number that does not exist, and hammering it
 * is how a messaging service earns a reputation score that starts affecting
 * the messages people do want.
 *
 * https://www.twilio.com/docs/api/errors
 */
const PERMANENT_TWILIO_CODES = new Set([
  21211, // 'To' is not a valid phone number
  21214, // 'To' is not a mobile number
  21217, // 'To' is not a valid SMS-capable number
  21408, // permission to send to this region is not enabled
  21606, // the 'From' number is not SMS-capable
  21610, // the recipient has unsubscribed (replied STOP)
  21612, // the message cannot be routed to this number
  21614, // 'To' is not a valid mobile number
  30003, // handset unreachable, permanently
  30005, // unknown destination handset
  30006, // landline, or unreachable carrier
]);

/**
 * Everything else is transient by default, including codes we have never seen.
 *
 * The asymmetry decides it: an unnecessary retry costs one message, and a
 * missing retry loses the notification. A new Twilio code we do not recognise
 * is far more likely to be a capacity problem than a permanently dead number.
 */
function isPermanentCode(code: unknown): boolean {
  const n = Number(code);
  return Number.isFinite(n) && PERMANENT_TWILIO_CODES.has(n);
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

function assertKnownProvider() {
  if (SMS_PROVIDER !== "stub" && SMS_PROVIDER !== "twilio") {
    throw new Error(
      `SMS_PROVIDER="${SMS_PROVIDER}" is not implemented. Use "stub" or "twilio", ` +
        "or add the adapter in src/lib/smsProvider.ts."
    );
  }
}

type TwilioConfig = {
  accountSid: string;
  authToken: string;
  /** Either a number we own, or a Messaging Service SID. Exactly one. */
  from: string;
  fromIsService: boolean;
};

function twilioConfig(): TwilioConfig {
  const accountSid = env("TWILIO_ACCOUNT_SID");
  const authToken = env("TWILIO_AUTH_TOKEN");
  const messagingServiceSid = env("TWILIO_MESSAGING_SERVICE_SID");
  const fromNumber = env("TWILIO_FROM_NUMBER");

  if (!accountSid || !authToken) {
    throw new Error(
      'SMS_PROVIDER="twilio" requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN. ' +
        'Set them, or use SMS_PROVIDER="stub".'
    );
  }
  if (!accountSid.startsWith("AC")) {
    throw new Error("TWILIO_ACCOUNT_SID should begin with 'AC'.");
  }

  /**
   * A Messaging Service is preferred where there is one: it is what carries
   * sender pools, per-country sender selection, and — the part that matters
   * here — Twilio's own STOP/START handling, so an opt-out is honoured by the
   * provider even if a bug in this codebase would have sent anyway.
   */
  if (messagingServiceSid) {
    if (!messagingServiceSid.startsWith("MG")) {
      throw new Error("TWILIO_MESSAGING_SERVICE_SID should begin with 'MG'.");
    }
    return { accountSid, authToken, from: messagingServiceSid, fromIsService: true };
  }

  if (!fromNumber) {
    throw new Error(
      'SMS_PROVIDER="twilio" requires TWILIO_MESSAGING_SERVICE_SID (preferred) or ' +
        "TWILIO_FROM_NUMBER. Without a sender there is nothing to send from."
    );
  }
  if (!fromNumber.startsWith("+")) {
    throw new Error("TWILIO_FROM_NUMBER must be E.164, starting with +.");
  }

  return { accountSid, authToken, from: fromNumber, fromIsService: false };
}

/** Validated at boot, beside the payment, identity, mail, and push checks. */
export function assertSmsConfigured(): string {
  if (SMS_PROVIDER === "stub") {
    return "stub (nothing is sent, and no secret is needed)";
  }
  assertKnownProvider();

  const cfg = twilioConfig();
  return cfg.fromIsService
    ? `twilio (messaging service ${cfg.from})`
    : `twilio (from ${maskPhone(cfg.from)})`;
}

/* ------------------------------------------------------------------ *
 * The stub
 * ------------------------------------------------------------------ */

export type StubMessage = { to: string; body: string; at: Date };

const stubOutbox: StubMessage[] = [];

/** What the stub "sent", for assertions. Never populated under twilio. */
export function stubMessages(): readonly StubMessage[] {
  return stubOutbox;
}

export function __clearStubMessages() {
  stubOutbox.length = 0;
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

/** How long to wait on Twilio before calling it a transient failure. */
const REQUEST_TIMEOUT_MS = 10_000;

export async function sendSms(input: { to: string; body: string }): Promise<SentSms> {
  assertKnownProvider();

  if (SMS_PROVIDER === "stub") {
    stubOutbox.push({ to: input.to, body: input.body, at: new Date() });
    return { providerMessageId: `stub_sm_${stubOutbox.length}` };
  }

  const cfg = twilioConfig();

  const form = new URLSearchParams();
  form.set("To", input.to);
  form.set("Body", input.body);
  if (cfg.fromIsService) form.set("MessagingServiceSid", cfg.from);
  else form.set("From", cfg.from);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`;
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    /**
     * A timeout or a socket error is ALWAYS transient, and it is also the one
     * case where the message may in fact have been sent — the request could
     * have arrived and the response been lost. That ambiguity is exactly why
     * the ledger claims the delivery before this call rather than after: the
     * retry re-uses the same row and the same event, so the far end sees at
     * most one extra message rather than an unbounded number.
     */
    throw new SmsSendError(
      `could not reach the SMS provider: ${err instanceof Error ? err.message : String(err)}`,
      { permanent: false }
    );
  }

  const text = await response.text();
  let payload: { sid?: string; code?: number; message?: string } = {};
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    // Twilio returns JSON on success and on error. Anything else is a proxy or
    // an outage page, which is transient by nature.
    if (!response.ok) {
      throw new SmsSendError(`SMS provider returned HTTP ${response.status}`, {
        permanent: false,
      });
    }
  }

  if (!response.ok) {
    const permanent = isPermanentCode(payload.code);
    throw new SmsSendError(
      `SMS provider refused the message (HTTP ${response.status}, code ${payload.code ?? "none"}): ` +
        `${payload.message ?? "no detail"} [to ${maskPhone(input.to)}]`,
      { permanent, code: payload.code ?? null }
    );
  }

  if (!payload.sid) {
    // Accepted, but with nothing to record. Treated as sent rather than failed:
    // retrying would be a second message for a first that probably went out.
    return { providerMessageId: "unknown" };
  }

  return { providerMessageId: payload.sid };
}
