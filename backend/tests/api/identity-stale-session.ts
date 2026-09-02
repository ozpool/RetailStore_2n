import { prisma, requireServices } from "../lib/db";
import { Scope } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";
import { isStubKyc } from "../../src/lib/kycProvider";

/**
 * The migration case: a seller left PENDING on a stub session while the
 * provider was switched to stripe_identity.
 *
 * This is not hypothetical — it is the exact state the site owner's own account
 * was in after the switch, which is why it earned a test. Resuming must not
 * strand them: the dead session gets closed and a real one started.
 */

const scope = new Scope("stalekyc");
const STALE_ID = "stub_deadbeefdeadbeefdeadbeefdeadbeef";

wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "identity: stale session after a provider switch",
  async (t) => {
    await requireServices({ api: true, web: true });

    if (isStubKyc()) {
      t.note("KYC_PROVIDER=stub — this case only arises under a real provider. Skipped.");
      return;
    }

    const seller = await scope.seller("seller");
    const profile = await prisma.sellerProfile.findFirstOrThrow({
      where: { user: { email: scope.emailFor("seller") } },
      select: { id: true },
    });

    // Forge the pre-switch state: a PENDING attempt on a stub-style session id.
    await prisma.kycAttempt.create({
      data: {
        sellerProfileId: profile.id,
        provider: "stub",
        providerSessionId: STALE_ID,
        status: "PENDING",
      },
    });
    await prisma.sellerProfile.update({
      where: { id: profile.id },
      data: { kycStatus: "PENDING", kycProvider: "stub", kycSessionId: STALE_ID },
    });

    const before = await seller.get("/api/seller/verification");
    t.check(before.json.verification.status === "PENDING", "starts in the stale PENDING state",
      before.json.verification.status);

    /* The click that has to rescue them. */
    const started = await seller.post("/api/seller/verification");
    t.check(started.status === 201, "a fresh session is created, not a resume of the dead one",
      `${started.status} resumed=${started.json?.resumed}`);
    t.check(started.json.session.providerSessionId.startsWith("vs_"),
      "and it is a real Stripe session", started.json.session?.providerSessionId);
    t.check(started.json.session.external === true, "external, so the seller goes to Stripe");

    const stale = await prisma.kycAttempt.findFirst({
      where: { providerSessionId: STALE_ID },
      select: { status: true },
    });
    t.check(stale?.status !== "PENDING", "the dead stub attempt was closed out, not left hanging",
      stale?.status);

    const pending = await prisma.kycAttempt.count({
      where: { status: "PENDING", sellerProfileId: profile.id },
    });
    t.check(pending === 1, "exactly one pending attempt remains", pending);

    t.check((await seller.get("/api/seller/payouts")).status === 403,
      "payouts stayed locked throughout");
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
