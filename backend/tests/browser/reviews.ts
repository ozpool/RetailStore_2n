import { WEB, prisma, requireCatalog, requireServices } from "../lib/db";
import { Scope } from "../lib/fixtures";
import { brokenImages, login, openBrowser, pickStars } from "../lib/browser";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * Writing a review, in a browser.
 *
 * Includes a keyboard check, because the star picker is built from real radio
 * inputs specifically so it works without a mouse — and a claim like that in a
 * code comment is worth nothing unless something exercises it.
 */

const scope = new Scope("uireviews");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "reviews (browser)",
  async (t) => {
    await requireServices({ api: true, web: true });
    await requireCatalog();

    const email = await scope.register("buyer");
    const target = await scope.claimListing();
    t.note(`target: "${target.title}"`);

    const h = await openBrowser("reviews");
    try {
      /* ---- signed out ---- */
      h.phase("pre-login");
      await h.page.goto(`${WEB}/listing/${target.slug}#reviews`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2000);
      const anon = await h.page.locator("#reviews").innerText();
      t.check(/reviews/i.test(anon), "review section renders for visitors");
      t.check(/log in/i.test(anon), "and invites them to log in");
      t.check(await h.page.locator("#review-body").count() === 0, "no write form when signed out");

      await login(h.page, email);
      h.phase("shopping");

      /* ---- logged in, hasn't bought ---- */
      await h.page.goto(`${WEB}/listing/${target.slug}#reviews`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2500);
      const notBought = await h.page.locator("#reviews").innerText();
      t.check(/once you['’]ve bought/i.test(notBought), "explains reviews come from buyers");
      t.check(await h.page.getByRole("button", { name: /write a review/i }).count() === 0,
        "no write button before buying");
      await h.shot("1-not-purchased");

      /* ---- buy it ---- */
      await h.page.getByRole("button", { name: /hold this item/i }).first().click();
      await h.page.waitForTimeout(2500);
      await h.page.goto(`${WEB}/cart`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(1500);
      await h.page.getByRole("button", { name: /proceed to checkout/i }).click();
      await h.page.waitForURL(/\/checkout\//, { timeout: 25000 });
      await h.page.waitForTimeout(2000);
      await h.page.getByRole("button", { name: /^succeeds$/i }).click();
      await h.page.getByRole("button", { name: /^pay \$/i }).click();
      await h.page.waitForURL(/\/orders\//, { timeout: 30000 });
      await h.page.waitForTimeout(2000);
      t.check(true, "bought it");

      /* ---- the receipt routes to the review ---- */
      const receipt = await h.page.locator("main").innerText();
      t.check(/write a review/i.test(receipt), "the paid receipt offers to review it");
      await h.page.getByRole("link", { name: /write a review/i }).first().click();
      await h.page.waitForURL(/\/listing\//, { timeout: 20000 });
      await h.page.waitForTimeout(2500);
      t.check(h.page.url().includes("#reviews"), "and links straight to the review section",
        h.page.url());

      /* ---- write one ---- */
      const writeBtn = h.page.getByRole("button", { name: /write a review/i });
      t.check(await writeBtn.isVisible(), "the write button appears now that it's bought");
      await writeBtn.click();
      await h.page.waitForTimeout(800);

      /* ---- keyboard: the radio-group claim, verified ---- */
      await h.page.locator('input[name="rating"][value="4"]').focus();
      t.check(
        await h.page.evaluate(() => document.activeElement?.getAttribute("name") === "rating"),
        "the star picker can hold keyboard focus"
      );
      await h.page.keyboard.press("ArrowRight");
      await h.page.waitForTimeout(400);
      const afterArrow = await h.page.evaluate(
        () => (document.querySelector('input[name="rating"]:checked') as HTMLInputElement)?.value
      );
      t.check(afterArrow === "5", "arrow keys change the rating — a real radio group",
        `value=${afterArrow}`);

      await pickStars(h.page, 4);
      await h.page.fill("#review-body", "Arrived quickly and matched the description.");
      await h.page.waitForTimeout(400);
      t.check(/\/2000/.test(await h.page.locator("#reviews").innerText()),
        "character counter is shown");
      await h.shot("2-writing");

      await h.page.getByRole("button", { name: /^post review$/i }).click();
      await h.page.waitForTimeout(3000);

      const posted = await h.page.locator("#reviews").innerText();
      t.check(/matched the description/i.test(posted), "the review appears immediately");
      t.check(/\bYou\b/.test(posted), "and is labelled as yours");
      t.check(/verified purchase/i.test(posted), "with a verified-purchase badge");
      t.check(/5 star/.test(posted) && /4 star/.test(posted), "the rating breakdown renders");
      t.check(await brokenImages(h.page) === 0, "no broken images");
      await h.shot("3-posted");

      /* ---- it persisted ---- */
      await h.page.reload({ waitUntil: "networkidle" });
      await h.page.waitForTimeout(2500);
      const reloaded = await h.page.locator("#reviews").innerText();
      t.check(/matched the description/i.test(reloaded), "still there after a reload");
      t.check(/edit your review/i.test(reloaded), "the button now offers editing");

      /* ---- edit ---- */
      await h.page.getByRole("button", { name: /edit your review/i }).click();
      await h.page.waitForTimeout(800);
      t.check(/matched the description/i.test(await h.page.inputValue("#review-body")),
        "the form is prefilled with what you wrote");
      await h.page.fill("#review-body", "Edited: the zip sticks a little, still good value.");
      await pickStars(h.page, 3);
      await h.page.getByRole("button", { name: /save changes/i }).click();
      await h.page.waitForTimeout(3000);
      t.check(/zip sticks/i.test(await h.page.locator("#reviews").innerText()), "the edit shows");
      t.check(await prisma.review.count({ where: { author: { email } } }) === 1,
        "still exactly one review row, not two");

      /* ---- the account page ---- */
      await h.page.goto(`${WEB}/account/reviews`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2500);
      const account = await h.page.locator("main").innerText();
      t.check(/zip sticks/i.test(account), "it appears in My reviews");
      t.check(/edit on the listing/i.test(account), "with a link back to the listing");
      await h.shot("4-account");

      /* ---- delete ---- */
      await h.page.getByRole("button", { name: /^delete$/i }).first().click();
      await h.page.waitForTimeout(2500);
      t.check(/haven['’]t reviewed anything/i.test(await h.page.locator("main").innerText()),
        "deleting empties the list");
      t.check(await prisma.review.count({ where: { author: { email } } }) === 0,
        "and the row is gone from the database");

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
