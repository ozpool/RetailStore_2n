import { WEB, prisma, requireCatalog, requireServices } from "../lib/db";
import { DEFAULT_ADDRESS, Scope } from "../lib/fixtures";
import { brokenImages, login, openBrowser, realFailures } from "../lib/browser";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * The whole Phase 1 arc, driven through the UI:
 * no address → add one → buy → seller sees it → seller ships → buyer confirms.
 *
 * The two assertions that matter most are negative ones. A buyer with no
 * address must be taken to the form rather than shown an error, and a seller
 * must not be able to see a sale before the money has moved.
 */

const scope = new Scope("fulfil");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "addresses and fulfilment (browser)",
  async (t) => {
    await requireServices({ api: true, web: true });
    await requireCatalog();

    // A seller with their own listing, so the sale traces back to them.
    const sellerEmail = await scope.register("seller", { seller: true });
    const category = await prisma.category.findFirstOrThrow({ select: { id: true } });
    const profile = await prisma.sellerProfile.findFirstOrThrow({
      where: { user: { email: sellerEmail } },
      select: { id: true },
    });
    const listing = await prisma.listing.create({
      data: {
        slug: `fulfil-test-${Date.now()}`,
        title: "Fulfilment test kettle",
        description: "Listed by the test seller so a sale can be traced back.",
        sellerId: profile.id,
        categoryId: category.id,
        condition: "GOOD",
        conditionNote: "Minor wear",
        priceCents: 3400,
        currency: "USD",
        quantity: 1,
        status: "ACTIVE",
        images: { create: { url: "https://images.unsplash.com/photo-1465385076216-9288f6f0584b", position: 0 } },
      },
      select: { id: true, slug: true, title: true },
    });

    // The buyer must start with NO address — the redirect is the point.
    const buyerEmail = await scope.register("buyer", { withAddress: false });

    const h = await openBrowser("fulfilment");
    try {
      /* ============================================================ */
      t.section("a buyer with no address is guided, not blocked");
      h.phase("pre-login");
      await login(h.page, buyerEmail);
      h.phase("shopping");

      await h.page.goto(`${WEB}/listing/${listing.slug}`, { waitUntil: "networkidle" });
      await h.page.getByRole("button", { name: /hold this item/i }).first().click();
      await h.page.waitForTimeout(2500);

      await h.page.goto(`${WEB}/cart`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(1800);

      // This checkout MUST be refused — there is no address yet. Tagged so the
      // response check below doesn't count the intentional 400 as a bug.
      h.phase("expected-no-address");
      await h.page.getByRole("button", { name: /proceed to checkout/i }).click();
      await h.page.waitForURL(/\/account\/addresses/, { timeout: 20000 });
      h.phase("shopping");
      t.check(h.page.url().includes("next=/cart"),
        "checkout with no address sends them to the address form, not an error",
        h.page.url());

      // The address page loads its list before rendering the prompt.
      await h.page.locator("#line1").waitFor({ timeout: 15000 });
      const prompt = await h.page.locator("main").innerText();
      t.check(/add a delivery address to finish/i.test(prompt),
        "and says why they're there", prompt.slice(0, 120).replace(/\n/g, " | "));
      t.check(await h.page.locator("#line1").isVisible(),
        "with the form already open, rather than behind a button");
      await h.shot("1-address-prompt");

      /* ---- fill it in ---- */
      await h.page.fill("#fullName", DEFAULT_ADDRESS.fullName);
      await h.page.fill("#line1", DEFAULT_ADDRESS.line1);
      await h.page.fill("#city", DEFAULT_ADDRESS.city);
      await h.page.fill("#postcode", DEFAULT_ADDRESS.postcode);
      await h.page.selectOption("#country", "GB");
      await h.page.getByRole("button", { name: /^save address$/i }).click();

      // ?next means saving should take them straight back to the cart.
      await h.page.waitForURL(/\/cart/, { timeout: 20000 });
      t.check(true, "saving returns them to the cart they came from");

      /* ============================================================ */
      t.section("checkout shows where it's going");
      await h.page.waitForTimeout(1800);
      await h.page.getByRole("button", { name: /proceed to checkout/i }).click();
      await h.page.waitForURL(/\/checkout\//, { timeout: 25000 });
      await h.page.waitForTimeout(2200);

      const checkout = await h.page.locator("main").innerText();
      t.check(/delivering to/i.test(checkout), "the payment page shows the delivery address");
      t.check(checkout.includes(DEFAULT_ADDRESS.line1), "with the right street",
        DEFAULT_ADDRESS.line1);
      t.check(/United Kingdom/.test(checkout), "and the country by name, not a code");
      t.check(await brokenImages(h.page) === 0, "no broken images");
      await h.shot("2-checkout-address");

      const orderId = new URL(h.page.url()).pathname.split("/").pop()!;

      /* ============================================================ */
      t.section("the seller sees nothing until it's paid");
      const sellerBrowser = await openBrowser("fulfilment-seller");
      try {
        sellerBrowser.phase("pre-login");
        await login(sellerBrowser.page, sellerEmail);
        sellerBrowser.phase("selling");

        await sellerBrowser.page.goto(`${WEB}/seller/sales`, { waitUntil: "networkidle" });
        await sellerBrowser.page.waitForTimeout(2200);
        const beforePaid = await sellerBrowser.page.locator("main").innerText();
        t.check(/nothing waiting to be sent/i.test(beforePaid),
          "an unpaid order does not appear in the seller's sales",
          beforePaid.slice(0, 140).replace(/\n/g, " | "));
        t.check(!beforePaid.includes(DEFAULT_ADDRESS.line1),
          "and the buyer's address is NOT shown before payment");
        await sellerBrowser.shot("3-no-sales-yet");

        /* ---- pay ---- */
        await h.page.getByRole("button", { name: /^succeeds$/i }).click();
        await h.page.getByRole("button", { name: /^pay \$/i }).click();
        await h.page.waitForURL(/\/orders\//, { timeout: 30000 });
        await h.page.waitForTimeout(2200);

        const receipt = await h.page.locator("main").innerText();
        t.check(/delivered to/i.test(receipt), "the receipt shows the delivery address");
        t.check(/awaiting dispatch/i.test(receipt),
          "and the item as awaiting dispatch", receipt.slice(0, 200).replace(/\n/g, " | "));
        await h.shot("4-receipt");

        /* ============================================================ */
        t.section("now the seller sees it");
        await sellerBrowser.page.reload({ waitUntil: "networkidle" });
        await sellerBrowser.page.waitForTimeout(2500);
        const sales = await sellerBrowser.page.locator("main").innerText();
        t.check(sales.includes(listing.title), "the sale appears", listing.title);
        t.check(/needs sending/i.test(sales), "flagged as needing sending");
        t.check(sales.includes(DEFAULT_ADDRESS.line1),
          "with the buyer's address, now that they've paid");
        t.check(sales.includes(DEFAULT_ADDRESS.postcode), "including the postcode");
        t.check(/before fees|no payouts yet/i.test(sales),
          "and the gross figure is labelled honestly, not as earnings");
        await sellerBrowser.shot("5-sales");

        /* ---- ship it ---- */
        await sellerBrowser.page.getByRole("button", { name: /^mark as sent$/i }).first().click();
        await sellerBrowser.page.waitForTimeout(700);
        await sellerBrowser.page.fill('input[id^="carrier-"]', "Royal Mail");
        await sellerBrowser.page.fill('input[id^="tracking-"]', "RM99887766GB");
        await sellerBrowser.page
          .getByRole("button", { name: /^mark as sent$/i })
          .last()
          .click();
        await sellerBrowser.page.waitForTimeout(2500);

        const shipped = await sellerBrowser.page.locator("main").innerText();
        t.check(/nothing waiting to be sent/i.test(shipped),
          "it leaves the needs-sending tab once sent");
        await sellerBrowser.page.getByRole("button", { name: /^sent$/i }).click();
        await sellerBrowser.page.waitForTimeout(2200);
        const sentTab = await sellerBrowser.page.locator("main").innerText();
        t.check(sentTab.includes("RM99887766GB"), "the tracking number is recorded");
        await sellerBrowser.shot("6-shipped");

        /* ============================================================ */
        t.section("the buyer sees it and confirms");
        await h.page.goto(`${WEB}/orders/${orderId}`, { waitUntil: "networkidle" });
        await h.page.waitForTimeout(2200);
        const onItsWay = await h.page.locator("main").innerText();
        t.check(/on its way/i.test(onItsWay), "the buyer sees it as on its way");
        t.check(onItsWay.includes("RM99887766GB"), "with the tracking number");
        t.check(/Royal Mail/.test(onItsWay), "and the carrier");
        await h.shot("7-on-its-way");

        await h.page.getByRole("button", { name: /it arrived/i }).click();
        await h.page.waitForTimeout(2500);
        const delivered = await h.page.locator("main").innerText();
        t.check(/delivered/i.test(delivered), "confirming marks it delivered");
        t.check(!/it arrived/i.test(delivered), "and the button goes away");
        await h.shot("8-delivered");

        const row = await prisma.orderItem.findFirstOrThrow({
          where: { order: { id: orderId } },
          select: { fulfilment: true, deliveredAt: true },
        });
        t.check(row.fulfilment === "DELIVERED", "recorded in the database",
          row.fulfilment);
        t.check(row.deliveredAt !== null, "with a timestamp");

        /* ---- the seller's dashboard moved with it ---- */
        await sellerBrowser.page.goto(`${WEB}/seller/sales`, { waitUntil: "networkidle" });
        await sellerBrowser.page.waitForTimeout(2200);
        t.check(/Delivered/.test(await sellerBrowser.page.locator("main").innerText()),
          "and the seller's summary reflects the delivery");

        t.check(sellerBrowser.jsErrors.length === 0, "no JavaScript errors for the seller",
          sellerBrowser.jsErrors.slice(0, 2).join(" | "));
      } finally {
        await sellerBrowser.close();
      }

      const failures = realFailures(h.badResponses);
      t.check(failures.length === 0, "no failed requests after signing in",
        failures.slice(0, 4).join(" | "));
      t.check(h.jsErrors.length === 0, "no JavaScript errors for the buyer",
        h.jsErrors.slice(0, 2).join(" | "));
    } finally {
      await h.close();
    }
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
