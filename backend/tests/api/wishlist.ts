import { web, catalog } from "../lib/api";
import { prisma, requireCatalog, requireServices } from "../lib/db";
import { Scope } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * Wishlist.
 *
 * The property worth protecting: saving something is INERT. It must not
 * reserve, hide, or otherwise change what anyone else sees — two people can
 * save the same one-of-a-kind chair and neither has claimed anything. Half the
 * assertions below are about that not being true by accident.
 */

const scope = new Scope("wishlist");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

// Not awaited: tsx compiles this project as CJS, where top-level await is a
// transform error. main() exits the process itself.
void main(
  "wishlist",
  async (t) => {
    await requireServices({ api: true, web: true });
    await requireCatalog();

    const buyer = await scope.buyer("owner");
    const a = await scope.claimListing();
    const b = await scope.claimListing();
    t.note(`using "${a.title}" and "${b.title}"`);

    /* ---------------------------------------------------------- */
    t.section("signed out");
    const anon = web();
    t.check((await anon.get("/api/wishlist")).status === 401, "cannot read a wishlist");
    t.check((await anon.put(`/api/wishlist/${a.id}`)).status === 401, "cannot save");

    /* ---------------------------------------------------------- */
    t.section("saving");
    const empty = await buyer.get("/api/wishlist");
    t.check(empty.status === 200 && empty.json.items.length === 0, "starts empty", empty.json);

    const saved = await buyer.put(`/api/wishlist/${a.id}`);
    t.check(saved.status === 200 && saved.json.saved === true, "save returns saved:true");
    t.check(saved.json.count === 1, "count is 1", saved.json.count);

    const after = await buyer.get("/api/wishlist");
    t.check(after.json.items.length === 1, "listed once");
    t.check(after.json.items[0].listing.id === a.id, "the right listing");
    t.check(after.json.items[0].listing.available === true, "marked available");
    t.check(!!after.json.items[0].listing.sellerName, "carries the seller name");

    /* ---------------------------------------------------------- *
     * The whole design, asserted directly.
     * ---------------------------------------------------------- */
    t.section("saving must not touch availability");
    const row = await prisma.listing.findUniqueOrThrow({
      where: { id: a.id },
      select: { status: true, quantity: true },
    });
    t.check(row.status === a.statusBefore, "listing status unchanged", row.status);
    t.check(row.quantity === a.stockBefore, "stock unchanged", `${row.quantity} vs ${a.stockBefore}`);
    const visible = await catalog<{ listings: any[] }>("/catalog/listings?limit=40");
    t.check(visible.listings.some((l) => l.id === a.id), "still visible in the catalog");

    /* ---------------------------------------------------------- */
    t.section("idempotency");
    const twice = await buyer.put(`/api/wishlist/${a.id}`);
    t.check(twice.status === 200 && twice.json.count === 1, "saving again is a no-op, not an error",
      `${twice.status} count=${twice.json?.count}`);

    const burst = await Promise.all(
      Array.from({ length: 6 }, () => buyer.put(`/api/wishlist/${b.id}`))
    );
    const rows = await prisma.wishlistItem.count({
      where: { listingId: b.id, user: { email: scope.emailFor("owner") } },
    });
    t.check(rows === 1, "six simultaneous saves produced exactly one row", `${rows} rows`);
    t.check(burst.every((r) => r.status === 200), "none of the concurrent saves errored",
      burst.map((r) => r.status));

    /* ---------------------------------------------------------- */
    t.section("reading and removing");
    const ids = await buyer.get("/api/wishlist/ids");
    t.check(ids.status === 200 && ids.json.listingIds.length === 2, "ids endpoint returns both", ids.json);
    t.check(
      ids.json.listingIds.includes(a.id) && ids.json.listingIds.includes(b.id),
      "ids are correct"
    );

    const removed = await buyer.delete(`/api/wishlist/${b.id}`);
    t.check(removed.status === 200 && removed.json.saved === false, "remove returns saved:false");
    t.check(removed.json.count === 1, "count back to 1", removed.json.count);
    t.check((await buyer.delete(`/api/wishlist/${b.id}`)).status === 200,
      "removing something not saved is fine, not a 404");

    /* ---------------------------------------------------------- */
    t.section("two people, one object");
    const other = await scope.buyer("other");
    const otherList = await other.get("/api/wishlist");
    t.check(otherList.json.items.length === 0, "another user's wishlist is separate",
      otherList.json.items.length);

    t.check((await other.put(`/api/wishlist/${a.id}`)).status === 200,
      "two people can save the same one-of-a-kind item");
    const both = await prisma.wishlistItem.count({ where: { listingId: a.id } });
    t.check(both === 2, "both rows exist independently", `${both} rows`);
    const stillActive = await prisma.listing.findUniqueOrThrow({
      where: { id: a.id },
      select: { status: true },
    });
    t.check(stillActive.status === a.statusBefore, "and the item is unchanged for everyone",
      stillActive.status);

    /* ---------------------------------------------------------- */
    t.section("bad input");
    t.check(
      (await buyer.put("/api/wishlist/00000000-0000-4000-8000-000000000000")).status === 404,
      "unknown listing is a 404"
    );
    t.check((await buyer.put("/api/wishlist/not-a-uuid")).status === 400, "malformed id is a 400");

    /* ---------------------------------------------------------- */
    t.section("a sold item stays on the list");
    await prisma.listing.update({ where: { id: a.id }, data: { status: "SOLD", quantity: 0 } });
    const withSold = await buyer.get("/api/wishlist");
    const soldEntry = withSold.json.items.find((i: any) => i.listing.id === a.id);
    t.check(!!soldEntry, "a sold item is NOT silently dropped");
    t.check(soldEntry?.listing.sold === true, "flagged as sold", soldEntry?.listing.sold);
    t.check(soldEntry?.listing.available === false, "and not available");
  },
  async (t) => {
    await scope.cleanup();
    const leftover = await prisma.wishlistItem.count({
      where: { user: { email: { in: [scope.emailFor("owner"), scope.emailFor("other")] } } },
    });
    t.check(leftover === 0, "wishlist rows cascaded with the users", leftover);
    await scope.verifyClean(t);
  }
);
