import Stripe from "stripe";

/**
 * The shared Stripe client.
 *
 * WHY THIS IS SEPARATE FROM paymentProvider.ts
 * Payments and identity verification are independently configurable:
 * PAYMENT_PROVIDER=stub with KYC_PROVIDER=stripe_identity is a perfectly
 * reasonable setup, and so is the reverse. Building the client inside the
 * payments module would tie identity verification to a payments setting that
 * has nothing to do with it.
 *
 * Webhook verification lives here for the same reason: one endpoint receives
 * both payment and identity events, signed with the same secret, and it must
 * work whichever of the two features is switched on.
 */

/** Trims and treats blank as unset — see the note in paymentProvider.ts. */
export function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

let client: Stripe | null = null;

export class StripeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeConfigError";
  }
}

export function getStripe(): Stripe {
  if (client) return client;

  const key = env("STRIPE_SECRET_KEY");
  if (!key) {
    throw new StripeConfigError(
      "STRIPE_SECRET_KEY is not set. Use a test key (sk_test_…) from the Stripe " +
        "dashboard, or switch the feature back to its stub."
    );
  }
  if (key.startsWith("pk_")) {
    throw new StripeConfigError(
      "STRIPE_SECRET_KEY holds a publishable key (pk_...). The secret key begins sk_test_."
    );
  }
  if (
    !key.startsWith("sk_test_") &&
    !key.startsWith("rk_test_") &&
    process.env.NODE_ENV !== "production"
  ) {
    throw new StripeConfigError(
      "STRIPE_SECRET_KEY is not a test key. Refusing to start outside production — " +
        "a live key here would take real money and run real identity checks."
    );
  }

  client = new Stripe(key, {
    // Pinned: an unpinned version lets Stripe change response shapes under a
    // running deployment.
    apiVersion: "2026-07-29.dahlia",
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: "RetailStore_2n", url: "https://github.com/ozpool/RetailStore_2n" },
  });
  return client;
}

export function isTestKey(): boolean {
  const key = env("STRIPE_SECRET_KEY") ?? "";
  return key.startsWith("sk_test_") || key.startsWith("rk_test_");
}

/**
 * Verifies a webhook and returns the raw event.
 *
 * The signature check is the entire security model for that endpoint: without
 * it, anyone who found the URL could post "this seller is verified" or "this
 * order is paid". Stripe signs the exact bytes it sent, so the body must reach
 * this function unparsed.
 */
export function verifyStripeWebhook(
  rawBody: Buffer,
  signature: string | undefined
): Stripe.Event {
  const secret = env("STRIPE_WEBHOOK_SECRET");
  if (!secret) {
    throw new StripeConfigError(
      "STRIPE_WEBHOOK_SECRET is not set; refusing to trust this webhook."
    );
  }
  if (!signature) {
    throw new StripeConfigError("Missing Stripe signature header.");
  }

  /**
   * Verification does NOT need API credentials.
   *
   * It is an HMAC of the raw body against STRIPE_WEBHOOK_SECRET — no network
   * call, no account. This used to go through getStripe(), which throws when
   * STRIPE_SECRET_KEY is unset, and the catch below then reported a missing key
   * as "Invalid webhook signature": a configuration mistake disguised as a
   * forgery, with nothing in the log to say otherwise.
   *
   * That also made the endpoint untestable with the stub providers, which is
   * how it was found — the suites sign their own payloads and had no reason to
   * need a Stripe account.
   *
   * A throwaway client is used when no key is configured. It is never used to
   * reach Stripe; constructEvent only reads the crypto.
   */
  const verifier = hasSecretKey() ? getStripe() : signatureOnlyClient();

  try {
    return verifier.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    // Deliberately opaque: a caller probing this endpoint learns nothing about
    // why their forgery failed.
    throw new StripeConfigError("Invalid webhook signature.");
  }
}

function hasSecretKey(): boolean {
  return Boolean(env("STRIPE_SECRET_KEY"));
}

let verifierClient: Stripe | null = null;

/**
 * A Stripe instance built solely to verify signatures.
 *
 * The key is a placeholder and is never sent anywhere — constructEvent does not
 * make requests. Kept separate from the real client so there is no chance of
 * this one being used to talk to Stripe with a nonsense credential.
 */
function signatureOnlyClient(): Stripe {
  if (!verifierClient) {
    verifierClient = new Stripe("sk_test_signature_verification_only", {
      apiVersion: "2026-07-29.dahlia",
    });
  }
  return verifierClient;
}
