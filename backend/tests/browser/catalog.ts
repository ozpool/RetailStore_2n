import { WEB, prisma, requireCatalog, requireServices } from "../lib/db";
import { catalog } from "../lib/api";
import { brokenImages, openBrowser } from "../lib/browser";
import { main, wireInterrupt } from "../lib/harness";

/**
 * The catalog at whatever size it currently is.
 *
 * Two things it protects. First, pagination: with 900+ listings a page that
 * silently repeats items or drops the tail is easy to ship and hard to notice.
 * Second, photo variety — the seeded catalog reused 28 images across 900
 * products until the pool was widened, which looked obviously fake.
 *
 * Read-only. It creates no accounts and touches no listings, so it needs no
 * cleanup.
 */

wireInterrupt();

void main("catalog (browser)", async (t) => {
  await requireServices({ api: true, web: true });
  const total = await requireCatalog();
  t.note(`${total} active listings`);

  const PER_PAGE = 24;

  /* ---------------------------------------------------------- */
  t.section("the API agrees with the database");
  const api = await catalog<any>(`/catalog/listings?limit=${PER_PAGE}`);
  t.check(api.total === total, "reported total matches the database", `${api.total} vs ${total}`);
  t.check(api.pageCount === Math.ceil(total / PER_PAGE), "page count is right",
    `${api.pageCount} pages of ${PER_PAGE}`);

  const cats = await catalog<any>("/catalog/categories");
  const sum = cats.categories.reduce((a: number, c: any) => a + c.listingCount, 0);
  t.check(sum === total, "category counts sum to the total", `${sum} vs ${total}`);
  t.note(cats.categories.map((c: any) => `${c.slug}=${c.listingCount}`).join("  "));

  /* ---------------------------------------------------------- */
  t.section("pagination");
  const p1 = await catalog<any>(`/catalog/listings?limit=${PER_PAGE}&page=1`);
  const p2 = await catalog<any>(`/catalog/listings?limit=${PER_PAGE}&page=2`);
  const overlap = p1.listings.filter((a: any) => p2.listings.some((b: any) => b.id === a.id)).length;
  t.check(overlap === 0, "page 1 and page 2 share no items", `${overlap} overlapping`);
  t.check(p2.listings.length === PER_PAGE, "page 2 is full", p2.listings.length);

  const last = await catalog<any>(`/catalog/listings?limit=${PER_PAGE}&page=${api.pageCount}`);
  t.check(last.listings.length > 0, "the last page has items", last.listings.length);

  /* ---------------------------------------------------------- */
  t.section("photo variety");
  const images = await prisma.listingImage.count();
  const distinct = await prisma.listingImage
    .findMany({ select: { url: true }, distinct: ["url"] })
    .then((r) => r.length);
  t.note(`${images} images, ${distinct} distinct photos`);
  t.check(distinct >= 100, "at least 100 distinct photos in the catalog", distinct);

  const grouped = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT count(*) AS c FROM listing_images GROUP BY url ORDER BY c DESC LIMIT 1
  `;
  const worst = Number(grouped[0]?.c ?? 0);
  t.check(worst <= 15, "no single photo is wildly over-used",
    `worst repeats ${worst} times, average ${(images / distinct).toFixed(1)}`);

  /* ---------------------------------------------------------- */
  const h = await openBrowser("catalog");
  try {
    t.section("pages render");
    await h.page.goto(`${WEB}/`, { waitUntil: "networkidle" });
    t.check(await brokenImages(h.page, "body") === 0, "no broken images on the homepage");
    await h.shot("1-home");

    await h.page.goto(`${WEB}/search`, { waitUntil: "networkidle" });
    await h.page.waitForTimeout(2500);
    const text = await h.page.locator("main").innerText();
    t.check(new RegExp(`${total}\\s+listings`).test(text), "the browse page shows the full count",
      (text.match(/[\d,]+ listings/) ?? ["?"])[0]);
    t.check(await h.page.locator("main a[href^='/listing/']").count() > 10,
      "renders a page of cards");
    t.check(await brokenImages(h.page) === 0, "every product image loaded from Unsplash");

    const variety = await h.page.evaluate(() => {
      const ids = [...document.querySelectorAll("main img")]
        .map((i) => (i as HTMLImageElement).src.match(/photo-([0-9]+-[0-9a-f]+)/)?.[1])
        .filter(Boolean);
      return { total: ids.length, distinct: new Set(ids).size };
    });
    t.check(variety.distinct >= variety.total * 0.75,
      "at least three quarters of the images on one page differ",
      `${variety.distinct}/${variety.total}`);
    await h.shot("2-browse");

    /* ---- a deep page ---- */
    const deepPage = Math.min(15, api.pageCount);
    await h.page.goto(`${WEB}/search?page=${deepPage}`, { waitUntil: "networkidle" });
    await h.page.waitForTimeout(2500);
    t.check(await h.page.locator("main a[href^='/listing/']").count() > 5,
      `page ${deepPage} renders too`);
    t.check(await brokenImages(h.page) === 0, "and its images load");
    await h.shot("3-deep-page");

    /* ---- a listing opens ---- */
    const sample = api.listings[0];
    await h.page.goto(`${WEB}/listing/${sample.slug}`, { waitUntil: "networkidle" });
    await h.page.waitForTimeout(1500);
    t.check((await h.page.locator("main").innerText()).includes(sample.title),
      "a listing page opens", sample.title);
    t.check(await brokenImages(h.page) === 0, "its photo loads");

    t.check(h.jsErrors.length === 0, "no JavaScript errors", h.jsErrors.slice(0, 2).join(" | "));
  } finally {
    await h.close();
  }
});
