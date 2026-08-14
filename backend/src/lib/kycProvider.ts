import crypto from "crypto";
import type Stripe from "stripe";
import { env, getStripe } from "./stripeClient";

/**
 * Identity verification provider.
 *
 * WHY THIS IS AN ABSTRACTION, AND WHY THE DEFAULT IS A STUB
 * --------------------------------------------------------
 * Government ID documents must never be stored by this application. They are
 * special-category personal data (GDPR Art. 9-adjacent; India's DPDP Act treats
 * them similarly), and holding ID images or numbers turns our database into a
 * high-value breach target for no product benefit. Real deployments delegate the
 * check to a provider that is built and audited for it, and keep only a
 * reference to the outcome.
 *
 * TWO ADAPTERS
 *   stub            — deterministic outcomes from a document number, so both
 *                     branches are testable without anyone's real ID.
 *   stripe_identity — real Stripe Identity. The seller is sent to Stripe's
 *                     hosted flow, uploads there, and the result arrives as a
 *                     signed webhook. This process never sees a document.
 *
 * THE STUB IS THE WEAKER PRIVACY MODEL, NOT THE STRONGER ONE
 * The stub accepts a document number into memory because it has to decide
 * something. Stripe Identity removes even that: the number never reaches this
 * server at all. So switching provider does not merely swap an implementation,
 * it shrinks what this application is capable of leaking — which is the reason
 * the seam exists.
 *
 * WHAT WE STORE, EITHER WAY
 * A session id and a status. Stripe keeps the extracted data in a separate
 * VerificationReport that we deliberately never expand, so ADR 0006 is enforced
 * by the provider rather than by our own restraint.
 */

export const KYC_PROVIDER = env("KYC_PROVIDER") ?? "stub";

export function isStubKyc() {
  return KYC_PROVIDER === "stub";
}

export const DOCUMENT_TYPES = ["passport", "drivers_license", "national_id"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export type StartedSession = {
  providerSessionId: string;
  /** Where the seller completes the check. */
  redirectUrl: string;
  /**
   * True when redirectUrl points at the provider rather than at us, so the
   * client knows to leave the site instead of routing internally.
   */
  external: boolean;
};

export type Decision =
  | { outcome: "VERIFIED"; documentType: DocumentType | null; country: string | null }
  | {
      outcome: "REJECTED";
      documentType: DocumentType | null;
      country: string | null;
      rejectionReason: string;
    };

export type SessionState =
  /** Still waiting on the seller, or on the provider's review. */
  | { state: "PENDING" }
  | { state: "DECIDED"; decision: Decision }
  /** The seller abandoned it, or we cancelled it. */
  | { state: "CANCELLED" };

export type DocumentSubmission = {
  documentType: DocumentType;
  country: string;
  /**
   * Passes through memory only. It is never returned in a Decision, never
   * logged, and never written to the database — see the assertion test.
   *
   * Only exists for the stub. With stripe_identity there is no such field
   * anywhere in this codebase.
   */
  documentNumber: string;
};

export class KycError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KycError";
  }
}

function assertKnownProvider() {
  if (KYC_PROVIDER !== "stub" && KYC_PROVIDER !== "stripe_identity") {
    throw new KycError(
      `KYC_PROVIDER="${KYC_PROVIDER}" is not implemented. Use "stub" or ` +
        `"stripe_identity", or add the adapter in src/lib/kycProvider.ts.`
    );
  }
}

/** Validates configuration at boot, like the payment provider does. */
export function assertKycConfigured(): string {
  if (KYC_PROVIDER === "stub") {
    return "stub (deterministic; no real identity is checked)";
  }
  assertKnownProvider();

  const key = env("STRIPE_SECRET_KEY");
  if (!key) {
    throw new Error(
      'KYC_PROVIDER="stripe_identity" requires STRIPE_SECRET_KEY. ' +
        'Set it, or use KYC_PROVIDER="stub".'
    );
  }
  if (!env("STRIPE_WEBHOOK_SECRET")) {
    throw new Error(
      'KYC_PROVIDER="stripe_identity" requires STRIPE_WEBHOOK_SECRET. Verification ' +
        "results arrive only as webhooks, so without it no seller can ever be verified."
    );
  }

  const mode = key.startsWith("sk_test_") || key.startsWith("rk_test_") ? "test" : "LIVE";
  return `stripe_identity (${mode} mode)`;
}

/* ------------------------------------------------------------------ *
 * Starting a session
 * ------------------------------------------------------------------ */

export async function startSession(input: {
  /** Stored on the provider session so a webhook can be traced back. */
  sellerProfileId: string;
  /** Where the seller lands after finishing at the provider. */
  returnUrl: string;
}): Promise<StartedSession> {
  assertKnownProvider();

  if (KYC_PROVIDER === "stub") {
    const providerSessionId = `stub_${crypto.randomBytes(16).toString("hex")}`;
    // The stub "hosts" its capture page inside our own frontend.
    return {
      providerSessionId,
      redirectUrl: `/seller/verify/${providerSessionId}`,
      external: false,
    };
  }

  try {
    const session = await getStripe().identity.verificationSessions.create({
      type: "document",
      options: {
        document: {
          /**
           * A live selfie matched against the document photo. Slower for the
           * seller, and the right trade for a gate on money leaving the
           * platform — a stolen document alone should not be enough.
           */
          require_matching_selfie: true,
          require_live_capture: true,
        },
      },
      // Stripe does not interpret metadata; it is for tracing a webhook back to
      // a seller. Nothing sensitive goes here — it is visible to anyone with
      // dashboard access.
      metadata: { sellerProfileId: input.sellerProfileId },
      return_url: input.returnUrl,
    });

    if (!session.url) {
      throw new KycError("Stripe did not return a verification URL.");
    }

    return { providerSessionId: session.id, redirectUrl: session.url, external: true };
  } catch (err) {
    throw translate(err);
  }
}

/**
 * A fresh hosted URL for a session already in flight.
 *
 * Stripe's hosted links expire, so resuming an abandoned attempt cannot reuse
 * the URL handed out the first time — it has to be re-read from the session.
 */
export async function resumeSession(providerSessionId: string): Promise<StartedSession | null> {
  assertKnownProvider();

  if (KYC_PROVIDER === "stub") {
    return {
      providerSessionId,
      redirectUrl: `/seller/verify/${providerSessionId}`,
      external: false,
    };
  }

  try {
    const session = await getStripe().identity.verificationSessions.retrieve(providerSessionId);
    if (!session.url || session.status !== "requires_input") return null;
    return { providerSessionId: session.id, redirectUrl: session.url, external: true };
  } catch {
    // An unreadable session is not resumable; the caller starts a new one.
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Reading a decision
 * ------------------------------------------------------------------ */

/**
 * Asks the provider where a session stands.
 *
 * Needed because webhooks are the primary path and webhooks can be missed —
 * the tunnel wasn't running, the process was down, the delivery failed. A
 * seller staring at "pending" forever because of a lost HTTP request is not an
 * acceptable failure mode, so the return page polls this.
 */
export async function getSessionState(providerSessionId: string): Promise<SessionState> {
  assertKnownProvider();

  if (KYC_PROVIDER === "stub") {
    // The stub has no provider-side state; its decision arrives by submission.
    return { state: "PENDING" };
  }

  try {
    const session = await getStripe().identity.verificationSessions.retrieve(providerSessionId);
    return interpret(session);
  } catch (err) {
    throw translate(err);
  }
}

/** Maps a Stripe session to our decision vocabulary. */
export function interpret(session: Stripe.Identity.VerificationSession): SessionState {
  switch (session.status) {
    case "verified":
      return {
        state: "DECIDED",
        decision: {
          outcome: "VERIFIED",
          // Deliberately null: reading the document type back means expanding
          // the VerificationReport, which is exactly the data ADR 0006 says we
          // should not hold. The status is what gates payouts.
          documentType: null,
          country: null,
        },
      };
    case "canceled":
      return { state: "CANCELLED" };
    case "requires_input": {
      /**
       * Ambiguous by design in Stripe's model: a brand-new session and a
       * failed one are both `requires_input`. `last_error` is what separates
       * "hasn't started" from "was refused".
       */
      if (!session.last_error) return { state: "PENDING" };
      return {
        state: "DECIDED",
        decision: {
          outcome: "REJECTED",
          documentType: null,
          country: null,
          rejectionReason: friendlyError(session.last_error),
        },
      };
    }
    case "processing":
    default:
      return { state: "PENDING" };
  }
}

/**
 * Stripe's reasons are terse codes. These are the seller-facing versions —
 * specific enough to act on, without coaching someone through a forgery.
 */
function friendlyError(error: Stripe.Identity.VerificationSession.LastError): string {
  switch (error.code) {
    case "document_expired":
      return "That document has expired. Try one that's still valid.";
    case "document_unverified_other":
      return "We couldn't verify that document. Try again with a clearer photo.";
    case "document_type_not_supported":
      return "That type of document isn't accepted. Try a passport or driving licence.";
    case "selfie_document_missing_photo":
      return "That document has no photo to match against. Try a different one.";
    case "selfie_face_mismatch":
      return "The selfie didn't match the photo on the document.";
    case "selfie_unverified_other":
      return "We couldn't verify the selfie. Try again in better light.";
    case "selfie_manipulated":
      return "The selfie couldn't be accepted. Take a new photo rather than uploading one.";
    case "under_supported_age":
      return "You must be old enough to sell on RetailStore_2n.";
    case "consent_declined":
      return "Verification needs your consent to go ahead.";
    case "abandoned":
      return "That check was left unfinished. Start it again when you're ready.";
    default:
      return error.reason ?? "That verification didn't pass. You can try again.";
  }
}

/* ------------------------------------------------------------------ *
 * Stub decisions
 * ------------------------------------------------------------------ */

/**
 * Stub decision rules, deliberately deterministic so both branches are testable
 * without anyone's real ID. Mirrors how Stripe and Persona expose fixed test
 * outcomes in their sandboxes.
 *
 *   number ending 0000 -> rejected, document could not be read
 *   number ending 0001 -> rejected, name did not match the account
 *   anything else       -> verified
 */
export function decide(submission: DocumentSubmission): Decision {
  if (KYC_PROVIDER !== "stub") {
    throw new KycError(
      "Submissions are only accepted by the stub. With a real provider the " +
        "seller submits at the provider and the result arrives as a webhook."
    );
  }

  const { documentType, country, documentNumber } = submission;
  const trimmed = documentNumber.trim();

  if (trimmed.endsWith("0000")) {
    return {
      outcome: "REJECTED",
      documentType,
      country,
      rejectionReason: "The document image couldn't be read clearly.",
    };
  }

  if (trimmed.endsWith("0001")) {
    return {
      outcome: "REJECTED",
      documentType,
      country,
      rejectionReason: "The name on the document didn't match this account.",
    };
  }

  return { outcome: "VERIFIED", documentType, country };
}

function translate(err: unknown): Error {
  if (err instanceof KycError) return err;
  const message = err instanceof Error ? err.message : "Identity verification failed.";
  return new KycError(message);
}
