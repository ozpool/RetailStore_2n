import { prisma, requireServices } from "../lib/db";
import { Scope } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";
import { hasWebhookSecret, identitySession, send, sendForged, sendUnsigned } from "../lib/stripeWebhook";
import { isStubKyc } from "../../src/lib/kycProvider";

/**
 * Seller identity verification, and the payout gate behind it.
 *
 * Runs against whichever provider is configured. Under stripe_identity it
 * creates real Stripe test-mode sessions and settles them with signed webhooks,
 * because webhooks are the only way anyone ever gets verified — so a test that
 * shortcut them would not be testing the feature.
 */

const scope = new Scope("identity");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "seller identity → payouts",
  async (t) => {
    await requireServices({ api: true, web: true });

    if (isStubKyc()) {
      t.note("KYC_PROVIDER=stub — the Stripe-specific assertions are skipped");
    }
    if (!hasWebhookSecret()) {
      t.check(false, "STRIPE_WEBHOOK_SECRET is set (required to settle verifications)");
      return;
    }

    const seller = await scope.seller("seller");

    /* ---------------------------------------------------------- */
    t.section("payouts start locked");
    const locked = await seller.get("/api/seller/payouts");
    t.check(locked.status === 403 && locked.json.code === "PAYOUTS_LOCKED",
      "payouts refused before verification", `${locked.status} ${locked.json?.code}`);

    const before = await seller.get("/api/seller/verification");
    t.check(before.status === 200, "verification status loads");
    t.check(before.json.verification.status === "UNSTARTED", "starts UNSTARTED",
      before.json.verification.status);
    t.check(before.json.verification.isStub === isStubKyc(),
      "reports the provider honestly", before.json.verification.isStub);

    /* ---------------------------------------------------------- */
    t.section("starting a session");
    const started = await seller.post("/api/seller/verification");
    t.check(started.status === 201, "session created",
      `${started.status} ${started.text.slice(0, 160)}`);
    const session = started.json.session;
    t.note(`session: ${session.providerSessionId}`);

    if (isStubKyc()) {
      t.check(session.external === false, "stub hosts capture locally", session.external);
    } else {
      t.check(session.providerSessionId.startsWith("vs_"), "a real Stripe session id",
        session.providerSessionId);
      t.check(session.external === true, "marked external so the client leaves our site",
        session.external);
      t.check(/^https:\/\/verify\.stripe\.com\//.test(session.redirectUrl ?? ""),
        "redirect points at Stripe's hosted flow", session.redirectUrl?.slice(0, 45));

      const refused = await seller.post(
        `/api/seller/verification/${session.providerSessionId}/submit`,
        { documentType: "passport", country: "US", documentNumber: "X1234567" }
      );
      t.check(refused.status === 409 && refused.json.code === "PROVIDER_HOSTED",
        "submitting a document number here is refused", `${refused.status} ${refused.json?.code}`);
    }

    /* ---------------------------------------------------------- */
    t.section("resuming, not duplicating");
    const resumed = await seller.post("/api/seller/verification");
    t.check(resumed.status === 200 && resumed.json.resumed === true, "second start resumes",
      `${resumed.status} resumed=${resumed.json?.resumed}`);
    t.check(resumed.json.session.providerSessionId === session.providerSessionId,
      "same session, not a duplicate", resumed.json.session?.providerSessionId);
    const attempts = await prisma.kycAttempt.count({
      where: { sellerProfile: { user: { email: scope.emailFor("seller") } } },
    });
    t.check(attempts === 1, "exactly one attempt row", attempts);

    /* ---------------------------------------------------------- *
     * The signature check is the whole security model here.
     * ---------------------------------------------------------- */
    t.section("an unsigned webhook verifies nobody");
    const unsigned = await sendUnsigned(
      "identity.verification_session.verified",
      identitySession(session.providerSessionId, { status: "verified" })
    );
    t.check(unsigned.status === 400, "unsigned is rejected", unsigned.status);
    t.check(await isPayoutsEnabled() === false, "and payouts stayed locked");

    const forged = await sendForged(
      "identity.verification_session.verified",
      identitySession(session.providerSessionId, { status: "verified" })
    );
    t.check(forged.status === 400, "a forged signature is rejected", forged.status);
    t.check(await isPayoutsEnabled() === false, "payouts still locked");

    /* ---------------------------------------------------------- */
    t.section("a rejection");
    const rejected = await send(
      "identity.verification_session.requires_input",
      identitySession(session.providerSessionId, {
        status: "requires_input",
        last_error: { code: "selfie_face_mismatch", reason: "The selfie did not match." },
      })
    );
    t.check(rejected.status === 200, "rejection webhook accepted", rejected.status);

    const afterReject = await seller.get("/api/seller/verification");
    t.check(afterReject.json.verification.status === "REJECTED", "seller marked REJECTED",
      afterReject.json.verification.status);
    t.check(/selfie/i.test(afterReject.json.verification.rejectionReason ?? ""),
      "with a readable reason", afterReject.json.verification.rejectionReason);
    t.check(!/selfie_face_mismatch/.test(afterReject.json.verification.rejectionReason ?? ""),
      "and not the raw Stripe error code");
    t.check(afterReject.json.verification.payoutsEnabled === false, "payouts still locked");
    t.check((await seller.get("/api/seller/payouts")).status === 403,
      "and the payouts endpoint still refuses");

    /* ---------------------------------------------------------- *
     * requires_input means BOTH "not started" and "refused" in
     * Stripe's model. Only last_error separates them, so a fresh
     * session must not be recorded as a rejection.
     * ---------------------------------------------------------- */
    t.section("a fresh session is not a rejection");
    const second = await seller.post("/api/seller/verification");
    t.check(second.status === 201, "can start a new check after a rejection", second.status);
    const s2 = second.json.session.providerSessionId;
    t.check(s2 !== session.providerSessionId, "it's a genuinely new session", s2);

    const fresh = await send(
      "identity.verification_session.requires_input",
      identitySession(s2, { status: "requires_input", last_error: null })
    );
    t.check(fresh.status === 200 && /pending/.test(JSON.stringify(fresh.json)),
      "treated as pending, not a rejection", fresh.json);
    t.check((await seller.get("/api/seller/verification")).json.verification.status === "PENDING",
      "so the seller stays PENDING");

    /* ---------------------------------------------------------- */
    t.section("verified, and the gate opens");
    const ok = await send(
      "identity.verification_session.verified",
      identitySession(s2, { status: "verified" })
    );
    t.check(ok.status === 200, "verified webhook accepted", ok.status);

    const after = await seller.get("/api/seller/verification");
    t.check(after.json.verification.status === "VERIFIED", "seller is VERIFIED",
      after.json.verification.status);
    t.check(after.json.verification.payoutsEnabled === true, "payouts unlocked");
    t.check(after.json.verification.rejectionReason === null,
      "the old rejection reason was cleared", after.json.verification.rejectionReason);

    /**
     * What this suite owns is the GATE, not the payout arithmetic — that has
     * its own 52 assertions in tests/api/payouts.ts. So this asserts the same
     * endpoint that refused a moment ago now answers, and that it answers with
     * the real payout shape rather than the placeholder's fixed zero.
     */
    const payouts = await seller.get("/api/seller/payouts");
    t.check(payouts.status === 200, "the payouts endpoint now allows access",
      `${payouts.status} ${payouts.json?.code ?? ""}`);
    t.check(payouts.json.summary?.gates?.payoutsEnabled === true,
      "and reports the identity gate as open", payouts.json.summary?.gates);
    // Nothing sold, so zero — but a computed zero, not a hardcoded one.
    t.check(payouts.json.summary?.payableCents === 0, "nothing payable yet",
      payouts.json.summary?.payableCents);
    // The other gate is still shut: verification does not connect an account.
    t.check(payouts.json.summary?.gates?.payoutsReady === false,
      "the payout-account gate stays shut until an account is connected",
      payouts.json.summary?.gates?.payoutsReady);

    /* ---------------------------------------------------------- */
    t.section("idempotency and unknown sessions");
    const again = await send(
      "identity.verification_session.verified",
      identitySession(s2, { status: "verified" })
    );
    t.check(again.status === 200 && /ALREADY_DECIDED/.test(JSON.stringify(again.json)),
      "a redelivered webhook is a no-op", again.json);
    const verifiedRows = await prisma.kycAttempt.count({
      where: {
        status: "VERIFIED",
        sellerProfile: { user: { email: scope.emailFor("seller") } },
      },
    });
    t.check(verifiedRows === 1, "still exactly one verified attempt", verifiedRows);

    t.check(
      (await send("identity.verification_session.verified",
        identitySession("vs_from_another_environment", { status: "verified" }))).status === 200,
      "an unknown session is acknowledged, not retried forever"
    );

    const alreadyVerified = await seller.post("/api/seller/verification");
    t.check(alreadyVerified.status === 409 && alreadyVerified.json.code === "ALREADY_VERIFIED",
      "cannot start a check when already verified",
      `${alreadyVerified.status} ${alreadyVerified.json?.code}`);

    /* ---------------------------------------------------------- *
     * ADR 0006: store a reference, never the document.
     * ---------------------------------------------------------- */
    t.section("nothing from the document is stored");
    const profile = await prisma.sellerProfile.findFirstOrThrow({
      where: { user: { email: scope.emailFor("seller") } },
      select: {
        kycStatus: true, kycProvider: true, kycSessionId: true,
        kycDocType: true, kycCountry: true, kycRejectionReason: true,
      },
    });
    const rows = await prisma.kycAttempt.findMany({
      where: { sellerProfile: { user: { email: scope.emailFor("seller") } } },
    });
    const blob = JSON.stringify({ profile, rows });
    for (const forbidden of ["X1234567", "passport", "drivers_license", "national_id"]) {
      t.check(!blob.includes(forbidden), `no "${forbidden}" stored anywhere`);
    }
    t.note(`stored: ${JSON.stringify(profile)}`);

    async function isPayoutsEnabled() {
      const p = await prisma.sellerProfile.findFirst({
        where: { user: { email: scope.emailFor("seller") } },
        select: { payoutsEnabled: true },
      });
      return p?.payoutsEnabled ?? false;
    }
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
