import crypto from "crypto";
import { env, getStripe } from "./stripeClient";

/**
 * Paying sellers: the sixth provider seam.
 *
 * Same shape as payments, identity, mail, SMS and the notification transport,
 * and for the same reason: CI must exercise the whole path with no credentials,
 * so a pull request from a fork — which cannot read this repository's secrets —
 * still gets a meaningful green run.
 *
 *   stub            in memory, deterministic ids, no network. The default.
 *   stripe_connect  real Connect Express accounts and real transfers.
 *
 * WHY EXPRESS ACCOUNTS
 * The sellers here are individuals clearing out a flat, not businesses with a
 * finance function. Express means Stripe hosts onboarding and carries identity
 * verification, bank details and tax reporting. Standard would ask someone
 * selling one chair to sign up for a payments processor; Custom would move the
 * compliance liability onto this platform, which is a business undertaking
 * rather than a default. See ADR 0029.
 *
 * WHAT THIS MODULE DOES NOT DECIDE
 * Whether a transfer *should* happen. Eligibility — delivered, held, unrefunded,
 * both gates passed — is lib/payouts.ts, and it is deliberately not here: a
 * provider adapter that also decides who gets paid is one where a provider
 * change can quietly change the rules. See ADR 0030.
 */

export const PAYOUT_PROVIDER = env("PAYOUT_PROVIDER") ?? "stub";

export function isStubPayouts(): boolean {
  return PAYOUT_PROVIDER === "stub";
}

function assertKnownProvider() {
  if (PAYOUT_PROVIDER !== "stub" && PAYOUT_PROVIDER !== "stripe_connect") {
    throw new Error(
      `PAYOUT_PROVIDER="${PAYOUT_PROVIDER}" is not implemented. Use "stub" or ` +
        `"stripe_connect", or add the adapter in src/lib/payoutProvider.ts.`
    );
  }
}

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export type CreatedAccount = {
  accountId: string;
};

export type OnboardingLink = {
  url: string;
  /**
   * True when the URL points at Stripe rather than at us, so the client knows
   * to leave the site instead of routing internally — the same flag the
   * identity seam returns for the same reason.
   */
  external: boolean;
  expiresAt: Date;
};

export type AccountStatus = {
  /**
   * Whether Stripe will actually move money to this account. Mirrored onto
   * SellerProfile.payoutsReady; never conflated with this platform's own
   * verification decision.
   */
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** What Stripe is still waiting for, for the seller-facing explanation. */
  pending: string[];
};

export type TransferResult = {
  transferId: string;
};

export type ReversalResult = {
  reversalId: string;
  /** What actually came back, which can be less than was asked for. */
  reversedCents: number;
};

/**
 * A transfer that failed in a way retrying cannot fix.
 *
 * A closed account, a rejected account, a currency the destination cannot
 * receive. Distinct from a network blip, because the payout machinery must not
 * keep re-attempting something that will be refused identically — and because
 * money movement is the last place to guess.
 */
export class PayoutError extends Error {
  readonly permanent: boolean;

  constructor(message: string, opts: { permanent: boolean }) {
    super(message);
    this.name = "PayoutError";
    this.permanent = opts.permanent;
  }
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

/** Validated at boot, beside the payment, identity, mail, SMS and push checks. */
export function assertPayoutsConfigured(): string {
  if (PAYOUT_PROVIDER === "stub") {
    return "stub (no money moves, and no secret is needed)";
  }
  assertKnownProvider();

  const key = env("STRIPE_SECRET_KEY");
  if (!key) {
    throw new Error(
      'PAYOUT_PROVIDER="stripe_connect" requires STRIPE_SECRET_KEY. Set it, or ' +
        'use PAYOUT_PROVIDER="stub".'
    );
  }
  if (!env("STRIPE_WEBHOOK_SECRET")) {
    throw new Error(
      'PAYOUT_PROVIDER="stripe_connect" requires STRIPE_WEBHOOK_SECRET. Whether ' +
        "an account can receive money arrives only as an account.updated webhook, " +
        "so without it no seller is ever marked ready to be paid."
    );
  }

  const mode = key.startsWith("sk_test_") || key.startsWith("rk_test_") ? "test" : "LIVE";
  return `stripe_connect (${mode} mode, Express accounts)`;
}

/* ------------------------------------------------------------------ *
 * The stub
 * ------------------------------------------------------------------ */

type StubAccount = {
  accountId: string;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
};

const stubAccounts = new Map<string, StubAccount>();
const stubTransfers = new Map<string, { amountCents: number; reversedCents: number }>();

/**
 * Finishes onboarding for a stub account.
 *
 * The stub's equivalent of the seller completing Stripe's hosted flow. Exposed
 * so the suite and a local developer can get to a payable state without a
 * Stripe account — the identity stub hosts its capture page inside our own
 * frontend for exactly the same reason.
 */
export function __completeStubOnboarding(accountId: string): boolean {
  const acct = stubAccounts.get(accountId);
  if (!acct) return false;
  acct.detailsSubmitted = true;
  acct.payoutsEnabled = true;
  return true;
}

/** What the stub believes it sent, for assertions. Empty under stripe_connect. */
export function stubTransferCount(): number {
  return stubTransfers.size;
}

export function __resetStubPayouts() {
  stubAccounts.clear();
  stubTransfers.clear();
}

/* ------------------------------------------------------------------ *
 * Accounts
 * ------------------------------------------------------------------ */

export async function createAccount(input: {
  /** Only ever used to prefill Stripe's form; this platform stores no bank data. */
  email: string;
  country?: string;
}): Promise<CreatedAccount> {
  assertKnownProvider();

  if (PAYOUT_PROVIDER === "stub") {
    const accountId = `acct_stub_${crypto.randomBytes(10).toString("hex")}`;
    stubAccounts.set(accountId, {
      accountId,
      detailsSubmitted: false,
      payoutsEnabled: false,
    });
    return { accountId };
  }

  try {
    const account = await getStripe().accounts.create({
      type: "express",
      email: input.email,
      country: input.country,
      capabilities: { transfers: { requested: true } },
      /**
       * Stripe collects and holds the bank details, tax identity and payout
       * schedule. This platform never sees them, which is the same reasoning
       * ADR 0006 applies to identity documents: the safest way to hold
       * sensitive data is to not be the one holding it.
       */
      business_type: "individual",
    });
    return { accountId: account.id };
  } catch (err) {
    throw new PayoutError(
      `could not create a connected account: ${err instanceof Error ? err.message : String(err)}`,
      { permanent: false }
    );
  }
}

export async function onboardingLink(input: {
  accountId: string;
  returnUrl: string;
  refreshUrl: string;
}): Promise<OnboardingLink> {
  assertKnownProvider();

  if (PAYOUT_PROVIDER === "stub") {
    return {
      // The stub "hosts" its onboarding inside our own frontend.
      url: `/seller/payouts/onboarding/${input.accountId}`,
      external: false,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    };
  }

  try {
    const link = await getStripe().accountLinks.create({
      account: input.accountId,
      type: "account_onboarding",
      return_url: input.returnUrl,
      /**
       * Stripe expires these in minutes and sends the seller here if one goes
       * stale, so this must start a fresh link rather than show an error.
       */
      refresh_url: input.refreshUrl,
    });
    return {
      url: link.url,
      external: true,
      expiresAt: new Date(link.expires_at * 1000),
    };
  } catch (err) {
    throw new PayoutError(
      `could not start onboarding: ${err instanceof Error ? err.message : String(err)}`,
      { permanent: false }
    );
  }
}

export async function accountStatus(accountId: string): Promise<AccountStatus> {
  assertKnownProvider();

  if (PAYOUT_PROVIDER === "stub") {
    const acct = stubAccounts.get(accountId);
    if (!acct) {
      return { payoutsEnabled: false, detailsSubmitted: false, pending: ["unknown account"] };
    }
    return {
      payoutsEnabled: acct.payoutsEnabled,
      detailsSubmitted: acct.detailsSubmitted,
      pending: acct.payoutsEnabled ? [] : ["onboarding not finished"],
    };
  }

  try {
    const account = await getStripe().accounts.retrieve(accountId);
    return {
      payoutsEnabled: account.payouts_enabled === true,
      detailsSubmitted: account.details_submitted === true,
      /**
       * Stripe's own words for what is missing, passed through rather than
       * paraphrased — a seller told "verification pending" cannot act, and a
       * seller told which document is missing can.
       */
      pending: account.requirements?.currently_due ?? [],
    };
  } catch (err) {
    throw new PayoutError(
      `could not read the account: ${err instanceof Error ? err.message : String(err)}`,
      { permanent: false }
    );
  }
}

/* ------------------------------------------------------------------ *
 * Moving money
 * ------------------------------------------------------------------ */

/**
 * Sends one payout.
 *
 * `payoutId` becomes the idempotency key, and that is not decoration: a retry
 * after a timeout is the one case where this platform cannot tell whether the
 * money already moved. With the key, Stripe answers with the original transfer
 * instead of making a second one.
 */
export async function transfer(input: {
  accountId: string;
  amountCents: number;
  currency: string;
  payoutId: string;
}): Promise<TransferResult> {
  assertKnownProvider();

  if (input.amountCents <= 0) {
    throw new PayoutError("refusing to transfer a non-positive amount", { permanent: true });
  }

  if (PAYOUT_PROVIDER === "stub") {
    const transferId = `tr_stub_${input.payoutId}`;
    stubTransfers.set(transferId, { amountCents: input.amountCents, reversedCents: 0 });
    return { transferId };
  }

  try {
    const tr = await getStripe().transfers.create(
      {
        amount: input.amountCents,
        currency: input.currency.toLowerCase(),
        destination: input.accountId,
        metadata: { payoutId: input.payoutId },
      },
      { idempotencyKey: `payout_${input.payoutId}` }
    );
    return { transferId: tr.id };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    /**
     * A rejected or closed destination will refuse identically every time.
     * Anything else — rate limits, timeouts, Stripe having a bad minute — is
     * transient. Unrecognised codes are treated as transient, because the cost
     * of being wrong is asymmetric: a delayed payout is a support message, a
     * wrongly-abandoned one is a seller who never gets paid.
     */
    const permanent =
      code === "account_invalid" ||
      code === "balance_insufficient" ||
      code === "transfers_not_allowed";
    throw new PayoutError(
      `transfer refused${code ? ` (${code})` : ""}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { permanent }
    );
  }
}

/**
 * Claws back part of a transfer, because a refund arrived after the seller was
 * paid.
 *
 * Returns how much actually came back, which can be less than was asked for —
 * a seller who has already withdrawn the money leaves nothing to reverse. The
 * caller records the shortfall as a debt rather than pretending it succeeded.
 */
export async function reverseTransfer(input: {
  transferId: string;
  amountCents: number;
}): Promise<ReversalResult> {
  assertKnownProvider();

  if (PAYOUT_PROVIDER === "stub") {
    const tr = stubTransfers.get(input.transferId);
    if (!tr) throw new PayoutError("no such transfer", { permanent: true });
    const available = Math.max(0, tr.amountCents - tr.reversedCents);
    const reversed = Math.min(available, input.amountCents);
    tr.reversedCents += reversed;
    return { reversalId: `trr_stub_${input.transferId}_${tr.reversedCents}`, reversedCents: reversed };
  }

  try {
    const rev = await getStripe().transfers.createReversal(input.transferId, {
      amount: input.amountCents,
    });
    return { reversalId: rev.id, reversedCents: rev.amount };
  } catch (err) {
    throw new PayoutError(
      `reversal refused: ${err instanceof Error ? err.message : String(err)}`,
      { permanent: true }
    );
  }
}
