import { WEB, prisma, requireCatalog, requireServices } from "../lib/db";
import { catalog } from "../lib/api";
import { Scope } from "../lib/fixtures";
import { brokenImages, login, navBadge, openBrowser } from "../lib/browser";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * The wishlist heart, in a browser.
 *
 * Before this existed, the heart on every product tile was a plain link to
 * /wishlist that looked like a save button and saved nothing. The assertions
 * below are mostly about it being real: state that survives a reload, a nav
 * count that moves, and a signed-out click that does not pretend.
 */

const scope = new Scope("uiwishlist");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "wishlist (browser)",
  async (t) => {
    await requireServices({ api: true, web: true });
    await requireCatalog();

    const email = await scope.register("buyer");
    const target = await scope.claimListing();
    t.note(`target: "${target.title}"`);

    const h = await openBrowser("wishlist");
    try {
      /* ---- signed out: the heart must not lie ---- */
      h.phase("pre-login");
      await h.page.goto(`${WEB}/listing/${target.slug}`, { waitUntil: "networkidle" });
      const anonSave = h.page.getByRole("button", { name: /save .* for later/i }).first();
      t.check(await anonSave.isVisible(), "save button is shown to visitors");
      await anonSave.click();
      await h.page.waitForURL(/\/login/, { timeout: 15000 });
      t.check(true, "clicking it while signed out goes to log in, not a fake save");

      await login(h.page, email);
      h.phase("shopping");
      t.check(await navBadge(h.page, "/wishlist") === "",
        "nav shows no count when nothing is saved");

      /* ---- save from a catalog tile ---- */
      await h.page.goto(`${WEB}/search`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(1500);
      const heart = h.page.getByRole("button", { name: /^save .* for later$/i }).first();
      await heart.waitFor({ timeout: 15000 });
      const label = (await heart.getAttribute("aria-label")) ?? "";
      const savedTitle = label.replace(/^Save /, "").replace(/ for later$/, "");
      t.check(await heart.getAttribute("aria-pressed") === "false", "heart starts unpressed");
      await heart.click();
      await h.page.waitForTimeout(1800);

      const escaped = savedTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pressed = h.page
        .getByRole("button", { name: new RegExp(`remove ${escaped} from`, "i") })
        .first();
      t.check(await pressed.isVisible(), `heart on "${savedTitle}" flipped to saved`);
      t.check(await pressed.getAttribute("aria-pressed") === "true",
        "aria-pressed reflects the state");
      t.check(await navBadge(h.page, "/wishlist") === "1", "nav badge shows 1 immediately",
        await navBadge(h.page, "/wishlist"));
      await h.shot("1-tile-saved");

      /* ---- it persisted, not just local state ---- */
      await h.page.reload({ waitUntil: "networkidle" });
      await h.page.waitForTimeout(1800);
      t.check(
        await h.page
          .getByRole("button", { name: new RegExp(`remove ${escaped} from`, "i") })
          .first()
          .isVisible(),
        "still saved after a full reload"
      );

      const savedRow = await prisma.wishlistItem.findFirstOrThrow({
        where: { user: { email } },
        select: { listing: { select: { slug: true, id: true } } },
      });
      await scope.trackListing(savedRow.listing.id);
      t.check(
        await prisma.wishlistItem.count({ where: { user: { email } } }) === 1,
        "exactly one row in the database"
      );

      /* ---- saving must not remove it from the shop ---- */
      const stillThere = await catalog<{ total: number }>("/catalog/listings?limit=1");
      t.check(stillThere.total > 0, "the catalog is unaffected by saving", stillThere.total);

      /* ---- the wishlist page ---- */
      await h.page.goto(`${WEB}/wishlist`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(1800);
      const wish = await h.page.locator("main").innerText();
      t.check(!/Planned|isn['’]t built/i.test(wish), "the page is no longer a placeholder");
      t.check(wish.includes(savedTitle), "the saved item is listed");
      t.check(/1 saved/i.test(wish), "shows a count");
      t.check(/doesn['’]t hold/i.test(wish), "explains that saving doesn't reserve the item");
      t.check(await brokenImages(h.page) === 0, "images on the wishlist loaded");
      await h.shot("2-wishlist");

      /* ---- the listing page agrees ---- */
      await h.page.goto(`${WEB}/listing/${savedRow.listing.slug}`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(1500);
      const detail = await h.page.locator("main").innerText();
      t.check(/saved for later/i.test(detail), "listing page shows it as saved");
      t.check(/doesn['’]t hold it/i.test(detail), "and explains saving isn't holding");

      /* ---- a sold item stays, marked ---- */
      await prisma.listing.update({
        where: { id: savedRow.listing.id },
        data: { status: "SOLD", quantity: 0 },
      });
      await h.page.goto(`${WEB}/wishlist`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(1800);
      const sold = await h.page.locator("main").innerText();
      t.check(sold.includes(savedTitle), "a sold item is still shown, not quietly dropped");
      t.check(/sold/i.test(sold), "and says it sold");
      t.check(/no longer available/i.test(sold), "the header counts it as unavailable");
      await h.shot("3-sold");

      // Put it back so the remove step below tests removal, not the sold state.
      const snapshot = await prisma.listing.findUniqueOrThrow({
        where: { id: savedRow.listing.id },
        select: { id: true },
      });
      await prisma.listing.update({
        where: { id: snapshot.id },
        data: { status: "ACTIVE", quantity: 1 },
      });

      /* ---- removing ---- */
      await h.page.goto(`${WEB}/wishlist`, { waitUntil: "networkidle" });
      await h.page.waitForTimeout(1800);
      await h.page.getByRole("button", { name: /^remove$/i }).first().click();
      await h.page.waitForTimeout(1800);
      const emptied = await h.page.locator("main").innerText();
      t.check(/nothing saved yet/i.test(emptied), "removing empties the list");
      t.check(await navBadge(h.page, "/wishlist") === "", "nav badge disappeared with it");
      t.check(await prisma.wishlistItem.count({ where: { user: { email } } }) === 0,
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
