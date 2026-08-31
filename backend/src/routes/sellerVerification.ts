import { Router } from "express";
import { z } from "zod";
import {
  DOCUMENT_TYPES,
  KYC_PROVIDER,
  decide,
  getSessionState,
  isStubKyc,
  resumeSession,
  startSession,
} from "../lib/kycProvider";
import { prisma } from "../lib/prisma";
import { applyDecision } from "../lib/verification";
import { checkRateLimit } from "../lib/rateLimit";
import { requireAuth } from "../middleware/requireAuth";
import { requireSeller } from "../middleware/requireSeller";
import { VerificationStatus } from "../generated/prisma/enums";

/**
 * Identity verification and the payout gate.
 *
 * Verification gates PAYOUTS, not listing creation. That is the Stripe Connect
 * model and what real marketplaces do: authoring a listing is harmless, so
 * blocking it only costs seller onboarding. Money leaving the platform is the
 * step that needs a verified identity behind it.
 */
export const sellerVerificationRouter = Router();

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";

sellerVerificationRouter.use(requireAuth, requireSeller);

function serializeAttempt(a: {
  id: string;
  provider: string;
  providerSessionId: string;
  status: string;
  documentType: string | null;
  country: string | null;
  rejectionReason: string | null;
  createdAt: Date;
  completedAt: Date | null;
}) {
  return {
    id: a.id,
    provider: a.provider,
    providerSessionId: a.providerSessionId,
    status: a.status,
    documentType: a.documentType,
    country: a.country,
    rejectionReason: a.rejectionReason,
    createdAt: a.createdAt.toISOString(),
    completedAt: a.completedAt ? a.completedAt.toISOString() : null,
  };
}

sellerVerificationRouter.get("/verification", async (req, res) => {
  try {
    const profile = await prisma.sellerProfile.findUnique({
      where: { id: req.sellerId },
      select: {
        kycStatus: true,
        kycProvider: true,
        kycDocType: true,
        kycCountry: true,
        kycVerifiedAt: true,
        kycRejectionReason: true,
        payoutsEnabled: true,
      },
    });

    if (!profile) {
      return res.status(404).json({ error: "Seller profile not found." });
    }

    const attempts = await prisma.kycAttempt.findMany({
      where: { sellerProfileId: req.sellerId },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    res.json({
      verification: {
        status: profile.kycStatus,
        provider: profile.kycProvider,
        documentType: profile.kycDocType,
        country: profile.kycCountry,
        verifiedAt: profile.kycVerifiedAt ? profile.kycVerifiedAt.toISOString() : null,
        rejectionReason: profile.kycRejectionReason,
        payoutsEnabled: profile.payoutsEnabled,
        // Surfaced so the UI can label the stub honestly rather than implying a
        // real identity check took place.
        isStub: isStubKyc(),
      },
      attempts: attempts.map(serializeAttempt),
    });
  } catch (err) {
    console.error("GET /seller/verification failed", err);
    res.status(500).json({ error: "Could not load your verification status." });
  }
});

sellerVerificationRouter.post("/verification", async (req, res) => {
  try {
    const profile = await prisma.sellerProfile.findUnique({
      where: { id: req.sellerId },
      select: { id: true, kycStatus: true },
    });

    if (!profile) {
      return res.status(404).json({ error: "Seller profile not found." });
    }

    if (profile.kycStatus === VerificationStatus.VERIFIED) {
      return res
        .status(409)
        .json({ error: "Your identity is already verified.", code: "ALREADY_VERIFIED" });
    }

    // Attempts are capped: the stub decides deterministically from the document
    // number, so an unbounded endpoint would let someone probe for outcomes.
    const limit = await checkRateLimit(`kyc:${req.userId}`, 5, 60 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "Too many verification attempts. Try again later.",
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    // An in-flight session is resumed rather than duplicated. With Stripe the
    // hosted link expires, so resuming re-reads the session for a fresh URL
    // rather than handing back the one issued the first time.
    const pending = await prisma.kycAttempt.findFirst({
      where: { sellerProfileId: profile.id, status: VerificationStatus.PENDING },
      orderBy: { createdAt: "desc" },
    });

    if (pending) {
      const resumedSession = await resumeSession(pending.providerSessionId);
      if (resumedSession) {
        return res.json({ session: resumedSession, resumed: true });
      }
      // The old session is dead at the provider. Close it out and fall through
      // to starting a fresh one rather than stranding the seller.
      await prisma.kycAttempt.update({
        where: { id: pending.id },
        data: {
          status: VerificationStatus.REJECTED,
          rejectionReason: "That check expired before it was finished.",
          completedAt: new Date(),
        },
      });
    }

    const session = await startSession({
      sellerProfileId: profile.id,
      returnUrl: `${FRONTEND_ORIGIN}/seller/verify/return`,
    });

    await prisma.$transaction([
      prisma.kycAttempt.create({
        data: {
          sellerProfileId: profile.id,
          provider: KYC_PROVIDER,
          providerSessionId: session.providerSessionId,
          status: VerificationStatus.PENDING,
        },
      }),
      prisma.sellerProfile.update({
        where: { id: profile.id },
        data: {
          kycStatus: VerificationStatus.PENDING,
          kycProvider: KYC_PROVIDER,
          kycSessionId: session.providerSessionId,
          kycRejectionReason: null,
        },
      }),
    ]);

    res.status(201).json({ session, resumed: false });
  } catch (err) {
    console.error("POST /seller/verification failed", err);
    res.status(500).json({ error: "Could not start verification." });
  }
});

const submissionBody = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  country: z.string().trim().length(2).toUpperCase(),
  // Read, evaluated, and discarded. Never persisted anywhere — asserted by test.
  documentNumber: z.string().trim().min(6).max(40),
});

/**
 * Applies a provider decision.
 *
 * With a real provider this transition arrives as a signed webhook
 * (identity.verification_session.verified / .requires_input) whose signature we
 * would verify before trusting it. The stub is driven by the seller's own
 * submission instead, which is why the lookup below is scoped to the owner.
 */
sellerVerificationRouter.post("/verification/:sessionId/submit", async (req, res) => {
  try {
    if (!isStubKyc()) {
      // With a real provider the seller submits at the provider. Accepting a
      // document number here would put one back in our process for no reason.
      return res.status(409).json({
        error: "Verification is completed at the provider, not here.",
        code: "PROVIDER_HOSTED",
      });
    }

    const parsed = submissionBody.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return res.status(400).json({
        error: first?.message ?? "Check the details and try again.",
        code: "INVALID_INPUT",
        field: first?.path?.[0] != null ? String(first.path[0]) : undefined,
      });
    }

    // Scoped by sellerProfileId so one seller can never resolve another's session.
    const attempt = await prisma.kycAttempt.findFirst({
      where: {
        providerSessionId: req.params.sessionId,
        sellerProfileId: req.sellerId,
      },
    });

    if (!attempt) {
      return res
        .status(404)
        .json({ error: "Verification session not found.", code: "NOT_FOUND" });
    }
    if (attempt.status !== VerificationStatus.PENDING) {
      return res.status(409).json({
        error: "That verification session is already finished.",
        code: "SESSION_CLOSED",
      });
    }

    const decision = decide(parsed.data);

    // Same writer the webhook uses, so the two paths cannot drift apart on the
    // one thing that matters: never enabling payouts without a recorded decision.
    const applied = await applyDecision({
      providerSessionId: req.params.sessionId,
      sellerProfileId: req.sellerId,
      decision,
    });

    if (!applied.applied) {
      return res.status(409).json({
        error: "That verification session is already finished.",
        code: "SESSION_CLOSED",
      });
    }

    res.json({
      outcome: decision.outcome,
      rejectionReason: decision.outcome === "REJECTED" ? decision.rejectionReason : null,
      payoutsEnabled: applied.verified,
    });
  } catch (err) {
    console.error("POST /seller/verification/:sessionId/submit failed", err);
    res.status(500).json({ error: "Could not complete verification." });
  }
});

/**
 * Where a session stands, asked of the provider directly.
 *
 * WHY THIS EXISTS ALONGSIDE THE WEBHOOK
 * The webhook is the primary path, and webhooks get missed: the tunnel wasn't
 * running, the process was restarting, the delivery failed its retries. A
 * seller left staring at "pending" forever because of one lost HTTP request is
 * not an acceptable outcome, so the page they land on after Stripe can poll
 * this and settle it themselves.
 *
 * Scoped to the owner, so nobody can read or resolve another seller's session.
 */
sellerVerificationRouter.get("/verification/:sessionId/status", async (req, res) => {
  try {
    const attempt = await prisma.kycAttempt.findFirst({
      where: { providerSessionId: req.params.sessionId, sellerProfileId: req.sellerId },
      select: { status: true, rejectionReason: true, provider: true },
    });

    if (!attempt) {
      return res
        .status(404)
        .json({ error: "Verification session not found.", code: "NOT_FOUND" });
    }

    // Already settled, by webhook or by an earlier poll.
    if (attempt.status !== VerificationStatus.PENDING) {
      const profile = await prisma.sellerProfile.findUnique({
        where: { id: req.sellerId },
        select: { payoutsEnabled: true },
      });
      return res.json({
        status: attempt.status,
        rejectionReason: attempt.rejectionReason,
        payoutsEnabled: profile?.payoutsEnabled ?? false,
        settledBy: "already",
      });
    }

    if (isStubKyc()) {
      // No provider-side state to consult; the stub waits on a submission.
      return res.json({
        status: VerificationStatus.PENDING,
        rejectionReason: null,
        payoutsEnabled: false,
        settledBy: null,
      });
    }

    const state = await getSessionState(req.params.sessionId);

    if (state.state === "PENDING") {
      return res.json({
        status: VerificationStatus.PENDING,
        rejectionReason: null,
        payoutsEnabled: false,
        settledBy: null,
      });
    }

    if (state.state === "CANCELLED") {
      return res.json({
        status: VerificationStatus.UNSTARTED,
        rejectionReason: null,
        payoutsEnabled: false,
        settledBy: "poll",
      });
    }

    const applied = await applyDecision({
      providerSessionId: req.params.sessionId,
      sellerProfileId: req.sellerId,
      decision: state.decision,
    });

    res.json({
      status: applied.applied
        ? applied.verified
          ? VerificationStatus.VERIFIED
          : VerificationStatus.REJECTED
        : VerificationStatus.PENDING,
      rejectionReason:
        state.decision.outcome === "REJECTED" ? state.decision.rejectionReason : null,
      payoutsEnabled: applied.applied ? applied.verified : false,
      // Useful in the logs: says whether the webhook or the poll got there first.
      settledBy: "poll",
    });
  } catch (err) {
    console.error("GET /seller/verification/:sessionId/status failed", err);
    res.status(500).json({ error: "Could not check that verification." });
  }
});

/*
 * `GET /seller/payouts` used to live here: a 403 gate over an honest zero
 * balance, from when there was no payout pipeline to gate. The real route is
 * in sellerPayouts.ts now and carries the same `PAYOUTS_LOCKED` refusal, so
 * this one is gone rather than shadowed. Both were mounted at /seller, and two
 * handlers for one path is a bug waiting for whoever reorders the mounts.
 */
