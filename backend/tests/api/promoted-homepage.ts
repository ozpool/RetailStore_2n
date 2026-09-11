import { prisma, requireServices } from "../lib/db";
import { main, wireInterrupt, cleanupOnInterrupt } from "../lib/harness";
import { acceptAsOffered, activate, endPlacement, requestPlacement } from "../../src/lib/placement";
import { Condition, ListingStatus, PlacementSlot } from "../../src/generated/prisma/enums";

/**
 * The homepage, reading live placements — and labelling them.
 *
 * WHAT THIS SUITE IS FOR
 * The label is the one part of this feature that is a legal requirement rather
 * than a product preference, and it is also the easiest thing in the whole
 * feature to lose silently: the flag travels from the placement table through
 * an endpoint, a fetch, a page, a shelf and a card, and any one of those
 * dropping it leaves a paid placement rendered as an editorial pick. Nothing
 * fails, no test goes red, and the page is deceptive.
 *
 * So this asserts against the SERVER-RENDERED HTML rather than against the
 * endpoint: the endpoint saying `promoted: true` proves nothing about what a
 * viewer sees.
 *
 * See docs/adr/0034-paid-homepage-placement.md
 */

const TAG = `rs2.promo.${Date.now()}`;
const WEB = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const API = process.env.API_ORIGIN ?? "http://localhost:4000";

let sellerId = "";

let adminId = "";
const listingIds: string[] = [];

/**
 * Rendered labels, counted PER SURFACE.
 *
 * Two earlier versions of this were too weak to notice a real regression, and
 * both failures are worth recording because they are the same mistake twice:
 *
 *   1. `/Promoted/` matched the word inside React's serialized props in the
 *      flight payload, so the count was non-zero with nothing promoted.
 *   2. `>Promoted<` counted the promoted ROW'S EYEBROW as well as the two
 *      labels, so "at least two" was satisfied by the hero plus the eyebrow —
 *      and the suite passed with the card's label deliberately disabled.
 *
 * So each occurrence is classified by the markup around it. Verified by
 * disabling the card label and watching `card` go to zero.
 */
function labels(html: string): { hero: number; card: number; eyebrow: number } {
  const counts = { hero: 0, card: 0, eyebrow: 0 };
  const needle = ">Promoted<";
  let at = html.indexOf(needle);
  while (at !== -1) {
    const context = html.slice(Math.max(0, at - 220), at);
    if (context.includes("section-eyebrow")) counts.eyebrow++;
    else if (context.includes("border-paper")) counts.hero++;
    else if (context.includes("bg-ink")) counts.card++;
    at = html.indexOf(needle, at + needle.length);
  }
  return counts;
}

async function homepage(): Promise<string> {
  const res = await fetch(`${WEB}/`, {
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`homepage returned ${res.status}`);
  return res.text();
}

void main(
  "promoted homepage",

  async (t) => {
    await requireServices({ api: true, web: true, db: true });

    const category = await prisma.category.findFirstOrThrow({ select: { id: true } });

    const sellerUser = await prisma.user.create({
      data: {
        email: `${TAG}.seller@retailstore-2n.test`,
        name: "Promo Seller",
        passwordHash: "not-a-real-hash",
        emailVerified: true,
        isSeller: true,
      },
      select: { id: true },
    });
    const profile = await prisma.sellerProfile.create({
      data: { userId: sellerUser.id, shopName: "Promoted Wares" },
      select: { id: true },
    });
    sellerId = profile.id;

    const admin = await prisma.user.create({
      data: {
        email: `${TAG}.admin@retailstore-2n.test`,
        name: "Promo Moderator",
        passwordHash: "not-a-real-hash",
        emailVerified: true,
        role: "ADMIN",
      },
      select: { id: true },
    });
    adminId = admin.id;

    /** Distinctive enough that finding it in 150KB of HTML means something. */
    const HERO_TITLE = `Gilded repair cabinet ${TAG.slice(-6)}`;
    const SHELF_TITLE = `Mended stoneware jug ${TAG.slice(-6)}`;

    async function listing(title: string): Promise<string> {
      const row = await prisma.listing.create({
        data: {
          slug: `${TAG}-${listingIds.length + 1}`,
          title,
          description: "Repaired with gold, and photographed so you can see exactly where.",
          sellerId,
          categoryId: category.id,
          condition: Condition.WELL_LOVED,
          priceCents: 18_500,
          quantity: 1,
          status: ListingStatus.ACTIVE,
        },
        select: { id: true },
      });
      listingIds.push(row.id);
      return row.id;
    }

    const heroListing = await listing(HERO_TITLE);
    const shelfListing = await listing(SHELF_TITLE);

    /* ---- 1. nothing promoted yet ---- */

    t.section("1. before anything is booked");

    const before = await homepage();

    /**
     * NOT "the listing is absent from the page". It is the newest listing in
     * the database, so the hero's fallback (`discounted[0] ?? everything[0]`)
     * legitimately shows it — unpromoted and unlabelled. Asserting absence
     * failed here and the assertion was wrong, not the code.
     *
     * What matters is the LABEL, so the baseline is a label count.
     */
    const before0 = labels(before);
    t.check(
      before0.hero === 0 && before0.card === 0 && before0.eyebrow === 0,
      "nothing on the page is labelled Promoted yet",
      JSON.stringify(before0)
    );

    const emptyFeed = await fetch(`${API}/catalog/promoted`).then((r) => r.json());
    t.check(
      emptyFeed.hero === null || emptyFeed.hero?.title !== HERO_TITLE,
      "and the promoted feed does not carry it",
      JSON.stringify(emptyFeed.hero)
    );

    /* ---- 2. book and activate both slots ---- */

    t.section("2. a hero and a shelf placement, agreed and activated");

    const heroReq = await requestPlacement({
      sellerId,
      listingId: heroListing,
      slot: PlacementSlot.HERO,
      offeredCents: 6000,
      note: "For the hero banner, because it is the best thing I have.",
    });
    if (!heroReq.requested) throw new Error(`hero request failed: ${heroReq.reason}`);
    await acceptAsOffered({ id: heroReq.id, adminUserId: adminId });
    const heroLive = await activate(heroReq.id);
    t.check(
      heroLive.activated,
      "the hero placement goes live",
      JSON.stringify(heroLive)
    );

    const shelfReq = await requestPlacement({
      sellerId,
      listingId: shelfListing,
      slot: PlacementSlot.PICKED_SHELF,
      position: 0,
      offeredCents: 1500,
      note: "And this one for the shelf, if there is room.",
    });
    if (!shelfReq.requested) throw new Error(`shelf request failed: ${shelfReq.reason}`);
    await acceptAsOffered({ id: shelfReq.id, adminUserId: adminId });
    t.check((await activate(shelfReq.id)).activated, "and so does the shelf placement");

    const feed = await fetch(`${API}/catalog/promoted`).then((r) => r.json());
    t.check(feed.hero?.title === HERO_TITLE, "the feed serves the hero", feed.hero?.title);
    t.check(feed.hero?.promoted === true, "flagged promoted by the API, not by the page");
    t.check(
      feed.shelf.some((x: { title: string }) => x.title === SHELF_TITLE),
      "and the shelf placement",
      JSON.stringify(feed.shelf.map((x: { title: string }) => x.title))
    );

    /* ---- 3. what a viewer actually sees ---- */

    t.section("3. the rendered page, which is the only thing that counts");

    const html = await homepage();

    t.check(html.includes(HERO_TITLE), "the hero listing is on the page");
    t.check(html.includes(SHELF_TITLE), "so is the shelf listing");

    t.check(
      html.includes("Promoted"),
      "and the page says “Promoted”",
      "the label is absent from the rendered HTML"
    );


    /**
     * Twice: once in the hero banner and once on the card. Counting them is
     * what distinguishes "the label rendered" from "one of the two surfaces
     * forgot it" — which is the failure this suite exists to catch.
     */
    const shown = labels(html);
    t.check(shown.hero === 1, "the BANNER carries the label", JSON.stringify(shown));
    t.check(shown.card >= 1, "and so does the CARD, separately", JSON.stringify(shown));
    t.check(
      shown.eyebrow === 1,
      "and the row itself is headed Promoted, so the shelf is disclosed too",
      JSON.stringify(shown)
    );

    /** The hero label must sit near the hero title, not merely somewhere on the page. */
    const heroAt = html.indexOf(HERO_TITLE);
    const labelBeforeHero = html.lastIndexOf(">Promoted<", heroAt);
    t.check(
      heroAt > 0 && labelBeforeHero > 0 && heroAt - labelBeforeHero < 1200,
      "the banner's label is in the banner, not elsewhere on the page",
      `title at ${heroAt}, nearest label at ${labelBeforeHero}`
    );

    /* ---- 4. a promoted listing that sells ---- */

    t.section("4. selling it takes it off the homepage immediately");

    await prisma.listing.update({
      where: { id: heroListing },
      data: { status: ListingStatus.SOLD },
    });

    const afterSold = await homepage();
    t.check(
      !afterSold.includes(HERO_TITLE),
      "the sold listing is gone from the page",
      "it is still being rendered"
    );
    t.check(
      afterSold.includes(SHELF_TITLE),
      "while the other placement is unaffected"
    );

    const soldFeed = await fetch(`${API}/catalog/promoted`).then((r) => r.json());
    t.check(
      soldFeed.hero === null,
      "and the feed stops serving it",
      JSON.stringify(soldFeed.hero)
    );

    const stillLive = await prisma.placementRequest.findUniqueOrThrow({
      where: { id: heroReq.id },
      select: { status: true },
    });
    t.check(
      stillLive.status === "LIVE",
      "though the agreement itself is still LIVE — no money was taken, so nothing is owed back",
      stillLive.status
    );

    /* ---- 5. ending it ---- */

    t.section("5. ending the shelf placement removes the row");

    t.check(await endPlacement(shelfReq.id), "the shelf placement is ended");
    const afterEnd = await homepage();

    /**
     * NOT "the title is gone". That listing is still ACTIVE and still one of
     * the newest in the catalogue, so it legitimately keeps appearing in the
     * derived shelves — unlabelled, which is the correct outcome. Asserting its
     * absence failed here, and the assertion was wrong rather than the code.
     */
    const ended = labels(afterEnd);
    t.check(
      ended.hero === 0 && ended.card === 0 && ended.eyebrow === 0,
      "and every promoted label is gone from the page",
      JSON.stringify(ended)
    );
    t.check(
      afterEnd.includes(SHELF_TITLE),
      "while the listing itself is still on sale, just no longer promoted"
    );
  },

  async () => {
    await prisma.placementRequest.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.messageThread.deleteMany({ where: { sellerId } });
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  }
);

wireInterrupt();
cleanupOnInterrupt(async () => {
  await prisma.placementRequest.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
});
