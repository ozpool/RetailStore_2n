import { prisma } from "./prisma";
import { events } from "./notifications";
import type { Decision } from "./kycProvider";
import { VerificationStatus } from "../generated/prisma/enums";

/**
 * Recording an identity decision, and the payout permission that follows it.
 *
 * ONE PLACE, TWO CALLERS
 * The stub is driven by the seller's own submission; Stripe Identity arrives as
 * a webhook. Both end here, because the dangerous part is the same either way:
 * `payoutsEnabled` must never be written without a verified decision recorded
 * beside it, and the two writes must not be able to come apart. A transaction
 * is what guarantees that, and having a second copy of this logic would be one
 * copy that eventually forgets.
 *
 * IDEMPOTENT
 * Stripe delivers webhooks at least once and retries on failure, so the same
 * decision can legitimately arrive twice. A repeat is a no-op rather than a
 * second round of writes.
 */
export async function applyDecision(input: {
  providerSessionId: string;
  decision: Decision;
  /** Restricts the update to one seller. Omitted for webhooks, which are trusted
   *  by signature and carry no session of their own. */
  sellerProfileId?: string;
}): Promise<
  | { applied: true; verified: boolean; sellerProfileId: string }
  | { applied: false; reason: "NOT_FOUND" | "ALREADY_DECIDED" }
> {
  const attempt = await prisma.kycAttempt.findFirst({
    where: {
      providerSessionId: input.providerSessionId,
      ...(input.sellerProfileId ? { sellerProfileId: input.sellerProfileId } : {}),
    },
    select: { id: true, sellerProfileId: true, status: true },
  });

  if (!attempt) return { applied: false, reason: "NOT_FOUND" };

  if (attempt.status !== VerificationStatus.PENDING) {
    return { applied: false, reason: "ALREADY_DECIDED" };
  }

  const verified = input.decision.outcome === "VERIFIED";
  const rejectionReason =
    input.decision.outcome === "REJECTED" ? input.decision.rejectionReason : null;
  const now = new Date();

  await prisma.$transaction([
    prisma.kycAttempt.update({
      where: { id: attempt.id },
      data: {
        status: verified ? VerificationStatus.VERIFIED : VerificationStatus.REJECTED,
        documentType: input.decision.documentType,
        country: input.decision.country,
        rejectionReason,
        completedAt: now,
      },
    }),
    prisma.sellerProfile.update({
      where: { id: attempt.sellerProfileId },
      data: {
        kycStatus: verified ? VerificationStatus.VERIFIED : VerificationStatus.REJECTED,
        kycDocType: input.decision.documentType,
        kycCountry: input.decision.country,
        kycVerifiedAt: verified ? now : null,
        kycRejectionReason: rejectionReason,
        // The gate. Written in the same transaction as the decision above.
        payoutsEnabled: verified,
      },
    }),
  ]);

  // After the transaction: telling them must not be able to undo the decision.
  const profile = await prisma.sellerProfile.findUnique({
    where: { id: attempt.sellerProfileId },
    select: { userId: true },
  });
  if (profile) {
    if (verified) void events.identityVerified(profile.userId);
    else void events.identityRejected({ userId: profile.userId, reason: rejectionReason ?? "" });
  }

  return { applied: true, verified, sellerProfileId: attempt.sellerProfileId };
}

/** Marks an abandoned or provider-cancelled session as closed. */
export async function cancelAttempt(providerSessionId: string) {
  const attempt = await prisma.kycAttempt.findFirst({
    where: { providerSessionId, status: VerificationStatus.PENDING },
    select: { id: true, sellerProfileId: true },
  });
  if (!attempt) return false;

  await prisma.$transaction([
    prisma.kycAttempt.update({
      where: { id: attempt.id },
      data: {
        status: VerificationStatus.REJECTED,
        rejectionReason: "That check was left unfinished.",
        completedAt: new Date(),
      },
    }),
    prisma.sellerProfile.update({
      where: { id: attempt.sellerProfileId },
      data: {
        // Back to UNSTARTED, not REJECTED: abandoning a check is not a failed
        // identity check, and leaving it as a rejection reads as an accusation.
        kycStatus: VerificationStatus.UNSTARTED,
        kycRejectionReason: null,
        // Cleared too. Leaving it would point at a session that no longer
        // exists at the provider, which is worse than pointing at nothing.
        kycSessionId: null,
      },
    }),
  ]);
  return true;
}

/**
 * Finds the seller a webhook belongs to.
 *
 * Prefers our own attempt row over the metadata Stripe echoes back, because the
 * attempt row is something only we can write.
 */
export async function sellerForSession(providerSessionId: string) {
  const attempt = await prisma.kycAttempt.findFirst({
    where: { providerSessionId },
    select: { sellerProfileId: true, status: true },
  });
  return attempt;
}
