import { WEB, prisma, requireCatalog, requireServices } from "../lib/db";
import { Scope } from "../lib/fixtures";
import { login, navBadge, openBrowser } from "../lib/browser";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * The cart count in the nav.
 *
 * Two cases here are the whole reason the count is not simply "held
 * reservations": checkout converts holds, so a naive badge empties the moment
 * you reach the payment page; and holds expire on a timer nothing tells the
 * browser about, so a naive badge sits there lying for fifteen minutes.
 */

const scope = new Scope("cartbadge");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "cart badge (browser)",
  async (t) => {
    await requireServices({ api: true, web: true });
    await requireCatalog();

    const email = await scope.register("buyer");
    const first = await scope.claimListing();
    const second = await scope.claimListing();
    const third = await scope.claimListing();
    const fourth = await scope.claimListing();

    const h = await openBrowser("cart-badge");
    try {
      h.phase("pre-login");
      await login(h.page, email);
      h.phase("shopping");
      t.check(await navBadge(h.page, "/cart") === "", "no badge when the cart is empty",
        await navBadge(h.page, "/cart"));

      const hold = async (slug: string) => {
        await h.page.goto(`${WEB}/listing/${slug}`, { waitUntil: "networkidle" });
        await h.page.getByRole("button", { name: /hold this item/i }).first().click();
        await h.page.waitForTimeout(2500);
      };

      await hold(first.slug);
      t.check(await navBadge(h.page, "/cart") === "1",
        "badge shows 1 right after holding, with no reload", await navBadge(h.page, "/cart"));

      await hold(second.slug);
      t.check(await navBadge(h.page, "/cart") === "2", "badge shows 2",
        await navBadge(h.page, "/cart"));

      await h.page.reload({ waitUntil: "networkidle" });
      await h.page.waitForTimeout(2000);
      t.check(await navBadge(h.page, "/cart") === "2", "still 2 after a full reload — it persisted",
        await navBadge(h.page, "/cart"));
      await h.shot("1-two-items");

      /* ---- releasing drops it ---- */
      await h.page.goto(`${WEB}/cart`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2000);
      await h.page.getByRole("button", { name: /^release$/i }).first().click();
      await h.page.waitForTimeout(2500);
      t.check(await navBadge(h.page, "/cart") === "1", "releasing one drops the badge to 1",
        await navBadge(h.page, "/cart"));

      /* ---- the case a holds-only count gets wrong ---- */
      await h.page.getByRole("button", { name: /proceed to checkout/i }).click();
      await h.page.waitForURL(/\/checkout\//, { timeout: 25000 });
      await h.page.waitForTimeout(2500);
      t.check(await navBadge(h.page, "/cart") === "1",
        "badge still 1 on the payment page, not 0 — an unpaid order still holds the item",
        await navBadge(h.page, "/cart"));
      await h.shot("2-during-checkout");

      await h.page.getByRole("button", { name: /^succeeds$/i }).click();
      await h.page.getByRole("button", { name: /^pay \$/i }).click();
      await h.page.waitForURL(/\/orders\//, { timeout: 30000 });
      await h.page.waitForTimeout(2500);
      t.check(await navBadge(h.page, "/cart") === "", "badge clears once the order is paid",
        await navBadge(h.page, "/cart"));

      /* ---- cancelling clears it too ---- */
      await hold(third.slug);
      await h.page.goto(`${WEB}/cart`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(1800);
      await h.page.getByRole("button", { name: /proceed to checkout/i }).click();
      await h.page.waitForURL(/\/checkout\//, { timeout: 25000 });
      await h.page.waitForTimeout(2000);
      await h.page.getByRole("button", { name: /cancel this order/i }).click();
      await h.page.waitForURL(/\/cart/, { timeout: 25000 });
      await h.page.waitForTimeout(2500);
      t.check(await navBadge(h.page, "/cart") === "", "badge clears when the order is cancelled",
        await navBadge(h.page, "/cart"));

      /* ---- an expired hold must drop off with no reload ---- *
       * Backdating the expiry to ~6 seconds out exercises the timer the
       * client arms from the server's nextExpiresAt.               */
      await hold(fourth.slug);
      t.check(await navBadge(h.page, "/cart") === "1", "held a fourth item",
        await navBadge(h.page, "/cart"));

      await prisma.$executeRaw`
        UPDATE "reservations" SET "expiresAt" = NOW() + INTERVAL '6 seconds'
        WHERE status = 'HELD'
          AND "userId" = (SELECT id FROM users WHERE email = ${email})
      `;
      // Re-read so the client picks up the imminent expiry and re-arms.
      await h.page.goto(`${WEB}/`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(2000);
      t.check(await navBadge(h.page, "/cart") === "1", "still 1 just before expiry",
        await navBadge(h.page, "/cart"));

      t.note("waiting for the hold to lapse — no reload, no navigation…");
      let cleared = false;
      for (let i = 0; i < 14; i++) {
        await h.page.waitForTimeout(2000);
        if ((await navBadge(h.page, "/cart")) === "") {
          cleared = true;
          break;
        }
      }
      t.check(cleared, "badge cleared itself when the hold expired, with no reload",
        `still "${await navBadge(h.page, "/cart")}" after 28s`);

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
