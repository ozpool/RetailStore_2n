import { Router } from "express";
import { prisma } from "../lib/prisma";
import { checkRateLimit } from "../lib/rateLimit";
import { requireAuth } from "../middleware/requireAuth";
import { requireSeller } from "../middleware/requireSeller";
import {
  __completeStubOnboarding,
  accountStatus,
  createAccount,
  isStubPayouts,
  onboardingLink,
} from "../lib/payoutProvider";
import { earningsSummary, holdDays, payableItems, runPayout } from "../lib/payouts";

/**
 * Getting paid.
 *
 * The money reaches the platform first and moves onward afterwards — see
 * ADR 0029 — so nothing here touches checkout. These endpoints let a seller
 * connect an account, see what they are owed and why, and trigger the transfer.
 *
 * NOTHING SCHEDULES A PAYOUT. It is requested by a seller or an admin, never
 * begun by a timer, and that is a product decision rather than a missing
 * feature — a seller decides when to take their money.
 *
 * There IS a scheduled job in the Kubernetes deployment, and it does not
 * contradict this: `payouts:pending` FINISHES payouts that were already
 * claimed by a request here and never transferred, because the claim commits
 * before the provider call (ADR 0029). It settles; it never initiates.
 * See docs/adr/0032-kubernetes-manifests.md
 */
export const sellerPayoutsRouter = Router();

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";

sellerPayoutsRouter.use("/payouts", requireAuth, requireSeller);

/**
 * The verification gate, on every route in this file.
 *
 * ADR 0007 put `403 PAYOUTS_LOCKED` on `GET /seller/payouts` when there was no
 * payout pipeline and the endpoint returned an honest zero. The pipeline exists
 * now, so the gate has to move with it rather than be replaced by it: an
 * unverified seller sees the same refusal for the same reason.
 *
 * It covers onboarding too, which the old placeholder never had to consider.
 * Creating a connected account is a real account at a real provider under
 * somebody's name, and doing that before we have checked who they are is the
 * wrong order. `runPayout` refuses unverified sellers on its own — this is the
 * outer gate, not the only one.
 *
 * PATH-SCOPED, and that is not cosmetic. This router is mounted at `/seller`
 * alongside the verification router, and a `use()` with no path runs for every
 * request reaching that mount — including `/seller/verification`, which an
 * unverified seller has to be able to reach in order to stop being unverified.
 * An unscoped gate here locks that door from the inside. Every `use()` in this
 * file is scoped for the same reason.
 */
sellerPayoutsRouter.use("/payouts", async (req, res, next) => {
  try {
    const profile = await prisma.sellerProfile.findUnique({
      where: { id: req.sellerId! },
      select: { payoutsEnabled: true, kycStatus: true },
    });

    if (!profile) {
      return res.status(404).json({ error: "Seller profile not found." });
    }
    if (!profile.payoutsEnabled) {
      return res.status(403).json({
        error: "Verify your identity before you can receive payouts.",
        code: "PAYOUTS_LOCKED",
        kycStatus: profile.kycStatus,
      });
    }
    next();
  } catch (err) {
    console.error("payout gate failed", err);
    res.status(500).json({ error: "Could not check your payout permissions." });
  }
});

function fail(res: import("express").Response, err: unknown, message: string) {
  console.error(message, err);
  res.status(500).json({ error: message, code: "SERVER_ERROR" });
}

/* ------------------------------------------------------------------ *
 * What am I owed?
 * ------------------------------------------------------------------ */

sellerPayoutsRouter.get("/payouts", async (req, res) => {
  try {
    const sellerId = req.sellerId!;
    const [summary, payable, history] = await Promise.all([
      earningsSummary(sellerId),
      payableItems(sellerId),
      prisma.payout.findMany({
        where: { sellerId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          amountCents: true,
          nettedCents: true,
          currency: true,
          status: true,
          failureReason: true,
          createdAt: true,
          completedAt: true,
          items: {
            select: { orderItemId: true, amountCents: true, reversedAt: true },
          },
        },
      }),
    ]);

    res.json({
      summary,
      holdDays: holdDays(),
      /** The exact lines, so "what is this $84 for?" has an answer on screen. */
      payable,
      history,
      isStub: isStubPayouts(),
    });
  } catch (err) {
    fail(res, err, "Could not load your payouts.");
  }
});

/* ------------------------------------------------------------------ *
 * Connecting an account
 * ------------------------------------------------------------------ */

sellerPayoutsRouter.post("/payouts/account", async (req, res) => {
  try {
    const sellerId = req.sellerId!;

    /**
     * Rate limited because each call can create a connected account at Stripe,
     * and an unlimited endpoint is a way to fill somebody's dashboard with
     * abandoned ones.
     */
    const limit = await checkRateLimit(`payout-onboard:${sellerId}`, 6, 60 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "Too many attempts. Try again later.",
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const profile = await prisma.sellerProfile.findUniqueOrThrow({
      where: { id: sellerId },
      select: { connectAccountId: true, user: { select: { email: true } } },
    });

    /**
     * Reuse the existing account rather than making another. Stripe has no
     * "delete account" worth relying on, and a seller who refreshes the page
     * mid-onboarding must not end up with two.
     */
    let accountId = profile.connectAccountId;
    if (!accountId) {
      const created = await createAccount({ email: profile.user.email });
      accountId = created.accountId;
      await prisma.sellerProfile.update({
        where: { id: sellerId },
        data: { connectAccountId: accountId },
      });
    }

    const link = await onboardingLink({
      accountId,
      returnUrl: `${FRONTEND_ORIGIN}/seller/payouts?onboarding=done`,
      // Stripe expires these in minutes and sends the seller back here, so this
      // has to start a fresh link rather than show an error.
      refreshUrl: `${FRONTEND_ORIGIN}/seller/payouts?onboarding=retry`,
    });

    res.status(201).json({ url: link.url, external: link.external, expiresAt: link.expiresAt });
  } catch (err) {
    fail(res, err, "Could not start payout onboarding.");
  }
});

/**
 * Re-reads the account from the provider and updates `payoutsReady`.
 *
 * The webhook is the primary path; this exists because a seller returning from
 * onboarding should not have to wait on a webhook to see the padlock open, and
 * because a missed webhook must be recoverable without a database console.
 */
sellerPayoutsRouter.post("/payouts/account/refresh", async (req, res) => {
  try {
    const sellerId = req.sellerId!;
    const profile = await prisma.sellerProfile.findUniqueOrThrow({
      where: { id: sellerId },
      select: { connectAccountId: true, connectOnboardedAt: true },
    });
    if (!profile.connectAccountId) {
      return res.status(409).json({ error: "No payout account yet.", code: "NO_ACCOUNT" });
    }

    const status = await accountStatus(profile.connectAccountId);
    await prisma.sellerProfile.update({
      where: { id: sellerId },
      data: {
        payoutsReady: status.payoutsEnabled,
        // Write-once, for the same reason as the webhook: the day details were
        // submitted is not a fact that moves every time somebody reloads.
        connectOnboardedAt: status.detailsSubmitted
          ? (profile.connectOnboardedAt ?? new Date())
          : null,
      },
    });

    res.json({
      payoutsReady: status.payoutsEnabled,
      detailsSubmitted: status.detailsSubmitted,
      pending: status.pending,
    });
  } catch (err) {
    fail(res, err, "Could not check your payout account.");
  }
});

/**
 * The stub's stand-in for Stripe's hosted onboarding.
 *
 * Refused outright under `stripe_connect`: an endpoint that can mark an account
 * ready to receive money must not exist on a real deployment, whatever it is
 * guarded by. The identity stub takes the same position.
 */
sellerPayoutsRouter.post("/payouts/account/stub-complete", async (req, res) => {
  try {
    if (!isStubPayouts()) {
      return res.status(404).json({ error: "Not found.", code: "NOT_FOUND" });
    }

    const sellerId = req.sellerId!;
    const profile = await prisma.sellerProfile.findUniqueOrThrow({
      where: { id: sellerId },
      select: { connectAccountId: true },
    });
    if (!profile.connectAccountId || !__completeStubOnboarding(profile.connectAccountId)) {
      return res.status(409).json({ error: "No payout account yet.", code: "NO_ACCOUNT" });
    }

    await prisma.sellerProfile.update({
      where: { id: sellerId },
      data: { payoutsReady: true, connectOnboardedAt: new Date() },
    });
    res.json({ payoutsReady: true });
  } catch (err) {
    fail(res, err, "Could not finish stub onboarding.");
  }
});

/* ------------------------------------------------------------------ *
 * Getting the money
 * ------------------------------------------------------------------ */

sellerPayoutsRouter.post("/payouts/run", async (req, res) => {
  try {
    const sellerId = req.sellerId!;

    /**
     * Rate limited hard. Every call can move money, and the claim is what
     * makes a double-click safe rather than this limit — but a limit is still
     * the cheaper place to stop a hammering client.
     */
    const limit = await checkRateLimit(`payout-run:${sellerId}`, 10, 60 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "Too many payout attempts. Try again later.",
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const outcome = await runPayout(sellerId);

    if (outcome.sent) {
      return res.status(201).json({
        paid: true,
        payoutId: outcome.payoutId,
        amountCents: outcome.amountCents,
      });
    }

    /**
     * Each reason is a different thing for the seller to do, so each gets its
     * own message rather than a generic failure. "Nothing to pay out" is a 200:
     * it is the ordinary answer, not an error.
     */
    const explain: Record<string, { status: number; code: string; error: string }> = {
      "nothing-payable": {
        status: 200,
        code: "NOTHING_PAYABLE",
        error: "Nothing is ready to pay out yet.",
      },
      "no-account": {
        status: 409,
        code: "NO_ACCOUNT",
        error: "Connect a payout account first.",
      },
      "not-verified": {
        status: 409,
        code: "NOT_VERIFIED",
        error: "Your identity check has not been approved yet.",
      },
      "not-ready": {
        status: 409,
        code: "NOT_READY",
        error: "Your payout account is not finished. Check what is outstanding.",
      },
      raced: {
        status: 409,
        code: "ALREADY_RUNNING",
        error: "A payout is already being processed.",
      },
      refused: {
        status: 502,
        code: "PROVIDER_REFUSED",
        error: "The transfer was refused. Check your payout account.",
      },
      "retry-later": {
        status: 503,
        code: "RETRY_LATER",
        error: "Could not reach the payment provider. The payout is queued.",
      },
      "already-settled": {
        status: 409,
        code: "ALREADY_SETTLED",
        error: "That payout has already been settled.",
      },
      "no-such-payout": { status: 404, code: "NOT_FOUND", error: "No such payout." },
    };

    const e = explain[outcome.reason] ?? {
      status: 500,
      code: "SERVER_ERROR",
      error: "Could not run the payout.",
    };
    res.status(e.status).json({ paid: false, code: e.code, error: e.error });
  } catch (err) {
    fail(res, err, "Could not run the payout.");
  }
});

/** Everything one past payout covered, for the "what was this?" question. */
sellerPayoutsRouter.get("/payouts/:id", async (req, res) => {
  try {
    const payout = await prisma.payout.findFirst({
      // Scoped by seller, so nobody can read someone else's by guessing an id.
      where: { id: req.params.id, sellerId: req.sellerId! },
      select: {
        id: true,
        amountCents: true,
        nettedCents: true,
        currency: true,
        status: true,
        failureReason: true,
        createdAt: true,
        completedAt: true,
        items: { select: { orderItemId: true, amountCents: true, reversedAt: true } },
      },
    });
    if (!payout) return res.status(404).json({ error: "No such payout.", code: "NOT_FOUND" });

    const items = await prisma.orderItem.findMany({
      where: { id: { in: payout.items.map((i) => i.orderItemId) } },
      select: { id: true, title: true, order: { select: { reference: true } } },
    });
    const titles = new Map(items.map((i) => [i.id, i]));

    res.json({
      payout: {
        ...payout,
        items: payout.items.map((i) => ({
          ...i,
          title: titles.get(i.orderItemId)?.title ?? "an item since deleted",
          orderReference: titles.get(i.orderItemId)?.order.reference ?? null,
        })),
      },
    });
  } catch (err) {
    fail(res, err, "Could not load that payout.");
  }
});
