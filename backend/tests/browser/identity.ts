import { WEB, prisma, requireServices } from "../lib/db";
import { Scope } from "../lib/fixtures";
import { login, openBrowser } from "../lib/browser";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";
import { hasWebhookSecret, identitySession, send } from "../lib/stripeWebhook";
import { isStubKyc } from "../../src/lib/kycProvider";

/**
 * Identity verification, in a browser.
 *
 * The interesting assertion is a negative one: under a real provider the local
 * document form must not render at all. The whole point of delegating identity
 * is that no document reaches this application, and a capture form left up
 * would quietly undo that.
 *
 * Stripe's own hosted page cannot be driven from here — it needs a camera — so
 * the outcome is settled with a signed webhook, which is what really happens.
 */

const scope = new Scope("uikyc");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "identity verification (browser)",
  async (t) => {
    await requireServices({ api: true, web: true });

    if (isStubKyc()) {
      t.note("KYC_PROVIDER=stub — this suite covers the hosted-provider flow. Skipped.");
      return;
    }
    if (!hasWebhookSecret()) {
      t.check(false, "STRIPE_WEBHOOK_SECRET is set (required to settle verifications)");
      return;
    }

    const email = await scope.register("seller", { seller: true });

    const h = await openBrowser("identity");
    try {
      h.phase("pre-login");
      await login(h.page, email);
      h.phase("verifying");
      t.check(true, "logged in as a seller");

      /* ---- the verification page ---- */
      await h.page.goto(`${WEB}/seller/verify`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2000);
      const verify = await h.page.locator("main").innerText();
      t.check(/not verified yet/i.test(verify), "shows the unverified state");
      t.check(!/simulated|no real identity/i.test(verify),
        "does not claim to be a simulation, because it isn't any more");
      await h.shot("1-unverified");

      /* ---- starting must leave our site ---- */
      await h.page.getByRole("button", { name: /verif|start/i }).first().click();
      await h.page.waitForURL(/verify\.stripe\.com/, { timeout: 30000 });
      t.check(h.page.url().startsWith("https://verify.stripe.com/"),
        "redirected to Stripe's domain, not ours", h.page.url().slice(0, 45));
      await h.page.waitForTimeout(3500);
      t.check(/verif|identity|document|stripe/i.test(await h.page.locator("body").innerText()),
        "Stripe's hosted page actually rendered");
      await h.shot("2-stripe-hosted");

      const sessionId = await prisma.kycAttempt
        .findFirstOrThrow({
          where: { sellerProfile: { user: { email } } },
          orderBy: { createdAt: "desc" },
          select: { providerSessionId: true },
        })
        .then((a) => a.providerSessionId);
      t.check(sessionId.startsWith("vs_"), "a real Stripe session was recorded", sessionId);

      /* ---- the local capture form must refuse to render ---- */
      await h.page.goto(`${WEB}/seller/verify/${sessionId}`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(3000);
      t.check(
        await h.page.locator('input[name="documentNumber"], #documentNumber').count() === 0,
        "the local document form is not rendered under a real provider"
      );
      t.check(h.page.url().includes("/seller/verify/return"),
        "and it redirects to the return page", h.page.url());

      /* ---- the return page, while pending ---- */
      await h.page.goto(`${WEB}/seller/verify/return`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(3000);
      t.check(/checking your verification|waiting for the result/i.test(
        await h.page.locator("main").innerText()
      ), "the return page says it's waiting");
      await h.shot("3-return-pending");

      /* ---- a rejection reaches the UI ---- */
      const rejected = await send(
        "identity.verification_session.requires_input",
        identitySession(sessionId, {
          status: "requires_input",
          last_error: { code: "selfie_face_mismatch", reason: "no match" },
        })
      );
      t.check(rejected.status === 200, "rejection webhook accepted", rejected.status);

      await h.page.goto(`${WEB}/seller/verify`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2500);
      const rej = await h.page.locator("main").innerText();
      t.check(/didn['’]t go through|didn['’]t pass/i.test(rej), "the UI shows the rejection");
      t.check(/selfie/i.test(rej), "with the readable reason");
      t.check(!/selfie_face_mismatch/.test(rej), "and not the raw Stripe error code");
      await h.shot("4-rejected");

      /* ---- verified, and payouts unlock ---- */
      await h.page.getByRole("button", { name: /verif|start|try again/i }).first().click();
      await h.page.waitForURL(/verify\.stripe\.com/, { timeout: 30000 });
      const second = await prisma.kycAttempt
        .findFirstOrThrow({
          where: { sellerProfile: { user: { email } } },
          orderBy: { createdAt: "desc" },
          select: { providerSessionId: true },
        })
        .then((a) => a.providerSessionId);
      t.check(second !== sessionId, "a new session after the rejection", second);

      t.check(
        (await send("identity.verification_session.verified",
          identitySession(second, { status: "verified" }))).status === 200,
        "verified webhook accepted"
      );

      await h.page.goto(`${WEB}/seller/verify/return`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(3000);
      const done = await h.page.locator("main").innerText();
      t.check(/you['’]re verified/i.test(done), "the return page shows verified");
      t.check(/payouts are unlocked/i.test(done), "and says payouts are unlocked");
      t.check(/no image, no number/i.test(done), "and states what we did not keep");
      await h.shot("5-verified");

      await h.page.goto(`${WEB}/seller/verify`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2500);
      t.check(/identity verified/i.test(await h.page.locator("main").innerText()),
        "the verification page shows verified");
      await h.shot("6-final");

      t.check(h.jsErrors.length === 0, "no JavaScript errors", h.jsErrors.slice(0, 2).join(" | "));
    } finally {
      await h.close();
    }
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
