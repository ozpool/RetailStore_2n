import { web, catalog } from "../lib/api";
import { prisma, requireCatalog, requireServices } from "../lib/db";
import { Scope, buyOne } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * Reviews.
 *
 * The rule under test: a review requires a PAID order for that listing. An open
 * review box on a marketplace is a reputation weapon — competitors bury each
 * other, sellers inflate themselves, and the stars that gate every buying
 * decision stop meaning anything.
 */

const scope = new Scope("reviews");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "reviews",
  async (t) => {
    await requireServices({ api: true, web: true });
    await requireCatalog();

    const buyer = await scope.buyer("buyer");
    const stranger = await scope.buyer("stranger");
    const target = await scope.claimListing();
    t.note(`target: "${target.title}"`);

    /* ---------------------------------------------------------- */
    t.section("signed out");
    t.check(
      (await web().post("/api/reviews", { listingId: target.id, rating: 5 })).status === 401,
      "cannot review"
    );

    /* ---------------------------------------------------------- *
     * The gate.
     * ---------------------------------------------------------- */
    t.section("has not bought it");
    const before = await buyer.get(`/api/reviews/for/${target.id}`);
    t.check(before.status === 200, "eligibility endpoint works");
    t.check(before.json.canReview === false, "cannot review something not bought",
      before.json.canReview);
    t.check(before.json.code === "NOT_PURCHASED", "with a specific code", before.json.code);
    t.check(/bought/i.test(before.json.reason ?? ""), "and a reason a person can act on",
      before.json.reason);

    const blocked = await buyer.post("/api/reviews", {
      listingId: target.id,
      rating: 5,
      body: "Great!",
    });
    t.check(blocked.status === 403 && blocked.json.code === "NOT_PURCHASED",
      "posting anyway is refused, not merely hidden in the UI",
      `${blocked.status} ${blocked.json?.code}`);
    const noRow = await prisma.review.count({
      where: { author: { email: scope.emailFor("buyer") } },
    });
    t.check(noRow === 0, "and no review row was created", noRow);

    /* ---------------------------------------------------------- */
    t.section("after buying");
    const { paid } = await buyOne(buyer, target.id);
    t.check(paid.json.outcome === "succeeded", "bought the item", paid.json?.outcome);

    const now = await buyer.get(`/api/reviews/for/${target.id}`);
    t.check(now.json.canReview === true, "buying unlocks reviewing", now.json.canReview);
    t.check(now.json.mine === null, "nothing written yet");

    const written = await buyer.post("/api/reviews", {
      listingId: target.id,
      rating: 4,
      body: "Solid, exactly as described.",
    });
    t.check(written.status === 201, "review posted", `${written.status} ${written.text.slice(0, 120)}`);
    t.check(written.json.review.rating === 4, "rating stored", written.json.review?.rating);
    const reviewId: string = written.json.review.id;

    /* ---------------------------------------------------------- */
    t.section("on the listing");
    const detail = await catalog<any>(`/catalog/listings/${target.slug}`);
    t.check(detail.listing.reviews.some((r: any) => r.id === reviewId), "appears on the listing");
    t.check(detail.listing.rating.count >= 1, "counted in the rating", detail.listing.rating.count);
    t.check(!!detail.listing.ratingBreakdown, "breakdown present", detail.listing.ratingBreakdown);

    const bd: Record<string, number> = detail.listing.ratingBreakdown;
    const sum = Object.values(bd).reduce((a, b) => a + b, 0);
    t.check(sum === detail.listing.rating.count, "breakdown sums to the review count",
      `${sum} vs ${detail.listing.rating.count}`);
    t.check(bd["4"] >= 1, "the 4-star bucket includes it", bd);
    t.check(detail.listing.reviews[0].authorId !== undefined, "authorId sent so 'You' can be marked");

    /* ---------------------------------------------------------- *
     * The badge has to be earned. Seeded reviews have no order behind
     * them, and printing "Verified purchase" on those would make the
     * badge meaningless on every listing.
     * ---------------------------------------------------------- */
    t.section("the verified badge is computed, not assumed");
    const mine = detail.listing.reviews.find((r: any) => r.id === reviewId);
    t.check(mine?.verified === true, "a real purchase is marked verified", mine?.verified);

    const others = detail.listing.reviews.filter((r: any) => r.id !== reviewId);
    if (others.length === 0) {
      t.note("no seeded reviews on this listing to compare against — skipped");
    } else {
      t.check(others.every((r: any) => r.verified === false),
        "seeded reviews are NOT marked verified — nobody paid for them",
        others.map((r: any) => r.verified));
    }

    /* ---------------------------------------------------------- */
    t.section("one review per person");
    const again = await buyer.post("/api/reviews", {
      listingId: target.id,
      rating: 2,
      body: "Changed my mind, the handle is loose.",
    });
    t.check(again.status === 201, "writing again succeeds", again.status);
    t.check(again.json.review.id === reviewId, "same review, edited — not a second one",
      `${again.json.review?.id} vs ${reviewId}`);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        buyer.post("/api/reviews", { listingId: target.id, rating: 5, body: "burst" })
      )
    );
    const rowCount = await prisma.review.count({
      where: { listingId: target.id, author: { email: scope.emailFor("buyer") } },
    });
    t.check(rowCount === 1, "five simultaneous posts still produce one review", rowCount);

    /* ---------------------------------------------------------- */
    t.section("validation");
    for (const bad of [0, 6, 3.5]) {
      const r = await buyer.post("/api/reviews", { listingId: target.id, rating: bad });
      t.check(r.status === 400, `rating ${bad} is rejected`, r.status);
    }
    t.check(
      (await buyer.post("/api/reviews", {
        listingId: target.id,
        rating: 5,
        body: "x".repeat(2001),
      })).status === 400,
      "an over-long body is rejected"
    );

    /* ---------------------------------------------------------- */
    t.section("only the author");
    t.check((await stranger.patch(`/api/reviews/${reviewId}`, { rating: 1 })).status === 404,
      "a stranger editing gets 404, not 403");
    t.check((await stranger.delete(`/api/reviews/${reviewId}`)).status === 404,
      "a stranger deleting gets 404");
    const survived = await prisma.review.findUnique({
      where: { id: reviewId },
      select: { rating: true },
    });
    t.check(survived !== null && survived.rating !== 1, "and the review is untouched",
      survived?.rating);

    const edited = await buyer.patch(`/api/reviews/${reviewId}`, {
      rating: 5,
      body: "Seller sorted it out. Happy after all.",
    });
    t.check(edited.status === 200 && edited.json.review.rating === 5, "the author can edit",
      `${edited.status} ${edited.json.review?.rating}`);
    t.check(edited.json.review.edited === true, "and it's marked as edited");

    /* ---------------------------------------------------------- *
     * Ownership is checked BEFORE purchase, so a seller is told they
     * own it rather than being sent off to buy their own item.
     * ---------------------------------------------------------- */
    t.section("a seller cannot review their own listing");
    const seller = await scope.seller("seller");
    const category = await prisma.category.findFirstOrThrow({ select: { id: true } });
    const created = await seller.post("/api/seller/listings", {
      title: "Own listing review test",
      description: "Used to check that a seller cannot review themselves.",
      categoryId: category.id,
      condition: "GOOD",
      priceCents: 1234,
      quantity: 1,
    });
    t.check(created.status === 201, "seller created a listing",
      `${created.status} ${created.text.slice(0, 140)}`);

    const ownId = created.json?.listing?.id;
    if (ownId) {
      const elig = await seller.get(`/api/reviews/for/${ownId}`);
      t.check(elig.json.canReview === false, "a seller cannot review their own listing",
        elig.json.canReview);
      t.check(elig.json.code === "OWN_LISTING", "and is told why, not sent off to buy it",
        elig.json.code);

      const post = await seller.post("/api/reviews", { listingId: ownId, rating: 5 });
      t.check(post.status === 403 && post.json.code === "OWN_LISTING",
        "posting on their own listing is refused", `${post.status} ${post.json?.code}`);
      t.check(await prisma.review.count({ where: { listingId: ownId } }) === 0,
        "no self-review row was created");
    }

    t.check(
      (await buyer.get("/api/reviews/for/00000000-0000-4000-8000-000000000000")).json.code === "GONE",
      "an unknown listing reports GONE"
    );

    /* ---------------------------------------------------------- */
    t.section("deleting");
    t.check((await buyer.delete(`/api/reviews/${reviewId}`)).status === 204,
      "the author can delete");
    t.check(await prisma.review.count({ where: { id: reviewId } }) === 0, "the row is gone");
    const eligAfter = await buyer.get(`/api/reviews/for/${target.id}`);
    t.check(eligAfter.json.mine === null, "eligibility reflects the deletion");
    t.check(eligAfter.json.canReview === true, "and they can write a new one");
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
