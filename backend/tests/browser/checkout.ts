import { WEB, prisma, requireCatalog, requireServices } from "../lib/db";
import { Scope } from "../lib/fixtures";
import { brokenImages, login, openBrowser, realFailures } from "../lib/browser";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * Checkout, in a real browser.
 *
 * This suite earns its runtime: it caught two things the API assertions passed
 * straight over — a decline reason printed twice, and a failed order still
 * telling the buyer their items were held after the stock had been released.
 * Both were only visible by looking at the page.
 */

const scope = new Scope("uicheckout");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "checkout (browser)",
  async (t) => {
    await requireServices({ api: true, web: true });
    await requireCatalog();

    const email = await scope.register("buyer");
    const listing = await scope.claimListing();
    t.note(`using "${listing.title}"`);

    const h = await openBrowser("checkout");
    try {
      h.phase("pre-login");
      await login(h.page, email);
      t.check(true, "logged in through the UI");
      h.phase("shopping");

      /* ---- hold from the listing page ---- */
      await h.page.goto(`${WEB}/listing/${listing.slug}`, { waitUntil: "networkidle" });
      await h.page.getByRole("button", { name: /hold this item/i }).first().click();
      await h.page.waitForTimeout(2500);
      t.check(true, `held "${listing.title}" from its listing page`);

      /* ---- the cart offers a real checkout ---- */
      await h.page.goto(`${WEB}/cart`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2000);
      const cartText = await h.page.locator("main").innerText();
      t.check(!/isn['’]t built yet/i.test(cartText), "the cart no longer says checkout isn't built");
      const checkoutBtn = h.page.getByRole("button", { name: /proceed to checkout/i });
      t.check(await checkoutBtn.isVisible(), "checkout button is visible");
      await h.shot("1-cart");

      /* ---- the payment page ---- */
      await checkoutBtn.click();
      await h.page.waitForURL(/\/checkout\//, { timeout: 25000 });
      await h.page.waitForTimeout(2000);
      const orderId = new URL(h.page.url()).pathname.split("/").pop()!;
      t.check(true, `landed on /checkout/${orderId}`);

      const co = await h.page.locator("main").innerText();
      t.check(/sandbox payment/i.test(co), "sandbox notice shown (testMode honoured)");
      t.check(co.includes(listing.title), "the held item is listed on the payment page");
      t.check(/RS2-/.test(co), "order reference displayed");
      t.check(await h.page.locator("#cardNumber").isVisible(), "card number field present");
      t.check(await brokenImages(h.page) === 0, "every image on the payment page loaded");
      await h.shot("2-payment");

      /* ---- a decline ---- */
      await h.page.getByRole("button", { name: /^declined$/i }).click();
      const typed = await h.page.inputValue("#cardNumber");
      t.check(typed.replace(/\s/g, "") === "4000000000000002",
        "the test-card button filled the field", typed);
      await h.page.getByRole("button", { name: /^pay \$/i }).click();
      await h.page.waitForTimeout(6000);

      const declined = await h.page.locator("main").innerText();
      t.check(/declin/i.test(declined), "the decline is surfaced to the buyer");
      t.check(!h.page.url().includes("/orders/"), "a decline did NOT navigate to a receipt");
      // Both of these were real bugs found by reading this screenshot.
      const mentions = (declined.match(/card was declined/gi) ?? []).length;
      t.check(mentions === 1, "the decline reason is stated once, not twice", `${mentions} times`);
      t.check(!/items are held for you/i.test(declined),
        "a failed order stops claiming the items are still held");
      await h.shot("3-declined");

      /* ---- pay properly (a decline is terminal, so a new order) ---- */
      await h.page.goto(`${WEB}/listing/${listing.slug}`, { waitUntil: "networkidle" });
      await h.page.getByRole("button", { name: /hold this item/i }).first().click();
      await h.page.waitForTimeout(2500);
      await h.page.goto(`${WEB}/cart`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(1500);
      await h.page.getByRole("button", { name: /proceed to checkout/i }).click();
      await h.page.waitForURL(/\/checkout\//, { timeout: 25000 });
      await h.page.waitForTimeout(1800);

      await h.page.getByRole("button", { name: /^succeeds$/i }).click();
      await h.page.getByRole("button", { name: /^pay \$/i }).click();
      await h.page.waitForURL(/\/orders\//, { timeout: 30000 });
      await h.page.waitForTimeout(2000);
      t.check(true, "a successful payment redirected to the receipt");

      const receipt = await h.page.locator("main").innerText();
      t.check(/thank you/i.test(receipt), "the receipt says thank you");
      t.check(/\bPaid\b/.test(receipt), "shows Paid status");
      t.check(receipt.includes(listing.title), "lists what was bought");
      t.check(/sandbox order/i.test(receipt), "is honest that no money moved");
      t.check(/write a review/i.test(receipt), "offers to review the purchase");
      await h.shot("4-receipt");

      /* ---- order history ---- */
      await h.page.goto(`${WEB}/account/orders`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2200);
      const history = await h.page.locator("main").innerText();
      t.check(!/isn['’]t built yet|Nothing here yet/i.test(history),
        "order history is no longer a placeholder");
      t.check(/RS2-/.test(history), "lists an order reference");
      t.check(/\bPaid\b/.test(history), "shows the paid order");
      await h.shot("5-history");

      /* ---- a paid order cannot be paid again from the UI ---- */
      const paidId = await prisma.order
        .findFirstOrThrow({
          where: { status: "PAID", buyer: { email } },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        })
        .then((o) => o.id);
      await h.page.goto(`${WEB}/checkout/${paidId}`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2500);
      t.check(h.page.url().includes(`/orders/${paidId}`),
        "opening checkout for a paid order redirects to the receipt", h.page.url());

      /* ---- nothing broke along the way ---- */
      const failures = realFailures(h.badResponses);
      t.check(failures.length === 0, "no failed requests after signing in",
        failures.slice(0, 4).join(" | "));
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
