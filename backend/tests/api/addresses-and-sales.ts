import { prisma, requireCatalog, requireServices } from "../lib/db";
import { DEFAULT_ADDRESS, Scope, buyOne, checkoutOne } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * Addresses, and the seller sales view they unlock.
 *
 * Two properties matter most here, and both are easy to get wrong in ways
 * nothing notices for months:
 *
 *   1. The order's address is a SNAPSHOT. Editing the address book afterwards
 *      must not rewrite where a past parcel was sent.
 *   2. A seller sees only their own lines, and only once the money has moved.
 */

const scope = new Scope("sales");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "addresses and seller sales",
  async (t) => {
    await requireServices({ api: true, web: true });
    await requireCatalog();

    /* ============================================================ */
    t.section("address book");

    const buyer = await scope.buyer("buyer");
    const listed = await buyer.get("/api/addresses");
    t.check(listed.status === 200, "addresses load", listed.status);
    t.check(listed.json.addresses.length === 1, "the fixture address is there",
      listed.json.addresses.length);
    t.check(listed.json.addresses[0].isDefault === true,
      "the first address saved is the default, without being asked");

    const second = await buyer.post("/api/addresses", {
      ...DEFAULT_ADDRESS,
      fullName: "Work Address",
      line1: "1 Harbour Road",
      city: "Bath",
    });
    t.check(second.status === 201, "a second address saves", second.status);
    t.check(second.json.address.isDefault === false, "and does not steal the default");

    const promoted = await buyer.post(`/api/addresses/${second.json.address.id}/default`);
    t.check(promoted.status === 200, "can promote it to default");
    const defaults = promoted.json.addresses.filter((a: any) => a.isDefault);
    t.check(defaults.length === 1, "exactly one default at a time", defaults.length);
    t.check(defaults[0].id === second.json.address.id, "and it is the promoted one");

    const country = await buyer.post("/api/addresses", { ...DEFAULT_ADDRESS, country: "UNITED KINGDOM" });
    t.check(country.status === 400, "a non ISO-2 country is rejected", country.status);
    const blank = await buyer.post("/api/addresses", { ...DEFAULT_ADDRESS, line1: "  " });
    t.check(blank.status === 400 && blank.json.field === "line1",
      "a blank street address is rejected, naming the field",
      `${blank.status} ${blank.json?.field}`);

    /* ---- another buyer cannot see or touch it ---- */
    const stranger = await scope.buyer("stranger");
    t.check((await stranger.get(`/api/addresses/${second.json.address.id}`)).status === 404,
      "a stranger gets 404, not 403");
    t.check((await stranger.patch(`/api/addresses/${second.json.address.id}`, DEFAULT_ADDRESS)).status === 404,
      "and cannot edit it");
    t.check((await stranger.delete(`/api/addresses/${second.json.address.id}`)).status === 404,
      "and cannot delete it");

    /* ---- deleting hands the default on ---- */
    const removed = await buyer.delete(`/api/addresses/${second.json.address.id}`);
    t.check(removed.status === 204, "deleting works", removed.status);
    const afterDelete = await buyer.get("/api/addresses");
    t.check(afterDelete.json.addresses.length === 1, "it is gone from the book");
    t.check(afterDelete.json.addresses[0].isDefault === true,
      "and the remaining one became the default rather than leaving none");

    /* ============================================================ */
    t.section("checkout requires an address");

    const noAddress = await scope.buyer("noaddress");
    const all = await noAddress.get("/api/addresses");
    for (const a of all.json.addresses) await noAddress.delete(`/api/addresses/${a.id}`);
    const listing = await scope.claimListing();

    await noAddress.post("/api/reservations", { listingId: listing.id, quantity: 1 });
    const refused = await noAddress.post("/api/orders");
    t.check(refused.status === 400 && refused.json.code === "NO_ADDRESS",
      "checking out with no address is refused",
      `${refused.status} ${refused.json?.code}`);
    t.check(/add a delivery address/i.test(refused.json.error ?? ""),
      "and says what to do about it", refused.json?.error);

    /* ============================================================ *
     * The snapshot. This is the one that quietly breaks if the order
     * points at the address by foreign key.
     * ============================================================ */
    t.section("the order keeps a copy, not a link");

    const order = await checkoutOne(buyer, (await scope.claimListing()).id);
    t.check(!!order.shipTo, "the order carries a delivery address");
    t.check(order.shipTo.line1 === DEFAULT_ADDRESS.line1, "with the right street",
      order.shipTo?.line1);
    t.check(order.shipTo.country === "GB", "and an ISO country code", order.shipTo?.country);

    const bookAddressId = afterDelete.json.addresses[0].id;
    await buyer.patch(`/api/addresses/${bookAddressId}`, {
      ...DEFAULT_ADDRESS,
      line1: "99 Somewhere Else",
      city: "Glasgow",
    });

    const reread = await buyer.get(`/api/orders/${order.id}`);
    t.check(reread.json.order.shipTo.line1 === DEFAULT_ADDRESS.line1,
      "editing the address book does NOT rewrite the past order",
      reread.json.order.shipTo?.line1);
    t.check(reread.json.order.shipTo.city === DEFAULT_ADDRESS.city,
      "the whole snapshot is intact", reread.json.order.shipTo?.city);

    /* ---- and deleting it doesn't orphan the order ---- */
    await buyer.delete(`/api/addresses/${bookAddressId}`);
    const afterAddressGone = await buyer.get(`/api/orders/${order.id}`);
    t.check(afterAddressGone.json.order.shipTo?.line1 === DEFAULT_ADDRESS.line1,
      "deleting the address leaves the order intact",
      afterAddressGone.json.order.shipTo?.line1);
    await buyer.post("/api/addresses", DEFAULT_ADDRESS); // restore for later steps

    /* ============================================================ */
    t.section("a seller can finally see their sales");

    const seller = await scope.seller("seller");
    const emptySales = await seller.get("/api/seller/sales");
    t.check(emptySales.status === 200, "the sales endpoint exists", emptySales.status);
    t.check(emptySales.json.sales.length === 0, "a new seller has none",
      emptySales.json.sales.length);
    t.check(emptySales.json.summary.toSend === 0, "and a zero summary");

    // Give the seller something to sell, then buy it.
    const category = await prisma.category.findFirstOrThrow({ select: { id: true } });
    const made = await seller.post("/api/seller/listings", {
      title: "Sales view test piece",
      description: "Listed so a purchase can be traced back to its seller.",
      categoryId: category.id,
      condition: "GOOD",
      priceCents: 4200,
      quantity: 1,
    });
    t.check(made.status === 201, "seller created a listing", made.status);
    const listingId = made.json.listing.id;
    await seller.post(`/api/seller/listings/${listingId}/publish`).catch(() => null);
    await prisma.listing.update({ where: { id: listingId }, data: { status: "ACTIVE" } });

    /* ---- before payment, the seller sees nothing ---- */
    await checkoutOne(buyer, listingId);
    const beforePaid = await seller.get("/api/seller/sales");
    t.check(beforePaid.json.sales.length === 0,
      "an unpaid order is NOT shown — sellers shouldn't pack parcels for abandoned carts",
      beforePaid.json.sales.length);

    /* ---- pay ---- */
    const pending = await prisma.order.findFirstOrThrow({
      where: { buyer: { email: scope.emailFor("buyer") }, status: "PENDING_PAYMENT" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const paid = await buyer.post(`/api/orders/${pending.id}/pay`, {
      cardNumber: "4242424242424242",
    });
    t.check(paid.json.outcome === "succeeded", "buyer paid", paid.json?.outcome);

    const sales = await seller.get("/api/seller/sales");
    t.check(sales.json.sales.length === 1, "the sale now appears", sales.json.sales.length);
    const sale = sales.json.sales[0];
    t.check(sale.title === "Sales view test piece", "with the right item", sale.title);
    t.check(sale.order.reference?.startsWith("RS2-"), "and the order reference",
      sale.order?.reference);
    t.check(sale.fulfilment === "UNFULFILLED", "starting unfulfilled", sale.fulfilment);
    t.check(sales.json.summary.toSend === 1, "the summary counts it as needing sending",
      sales.json.summary.toSend);
    t.check(sales.json.summary.grossCents === 4200, "gross is the sale price",
      sales.json.summary.grossCents);

    /* ---- the address is released, but only now ---- */
    t.check(!!sale.shipTo, "the seller can see where to send it");
    t.check(sale.shipTo.line1 === DEFAULT_ADDRESS.line1, "the buyer's street", sale.shipTo?.line1);
    t.check(sale.shipTo.postcode === DEFAULT_ADDRESS.postcode, "and postcode");

    /* ---- another seller sees none of it ---- */
    const otherSeller = await scope.seller("otherseller");
    const theirs = await otherSeller.get("/api/seller/sales");
    t.check(theirs.json.sales.length === 0, "another seller sees nothing of it",
      theirs.json.sales.length);
    t.check((await otherSeller.post(`/api/seller/sales/${sale.id}/ship`, {})).status === 404,
      "and cannot ship it — 404, not 403");

    /* ============================================================ */
    t.section("shipping");

    const shipped = await seller.post(`/api/seller/sales/${sale.id}/ship`, {
      carrier: "Royal Mail",
      trackingNumber: "RM123456789GB",
    });
    t.check(shipped.status === 200, "seller marks it sent", shipped.status);
    t.check(shipped.json.sale.fulfilment === "SHIPPED", "fulfilment is SHIPPED",
      shipped.json.sale?.fulfilment);
    t.check(!!shipped.json.sale.shippedAt, "shippedAt recorded");
    t.check(shipped.json.sale.trackingNumber === "RM123456789GB", "tracking stored");

    const reship = await seller.post(`/api/seller/sales/${sale.id}/ship`, {
      carrier: "Royal Mail",
      trackingNumber: "CORRECTED999GB",
    });
    t.check(reship.status === 200, "shipping twice is not an error");
    t.check(reship.json.sale.trackingNumber === "CORRECTED999GB",
      "it corrects the tracking number instead", reship.json.sale?.trackingNumber);

    /* ---- the buyer sees it ---- */
    const buyerView = await buyer.get(`/api/orders/${pending.id}`);
    const line = buyerView.json.order.items[0];
    t.check(line.fulfilment === "SHIPPED", "the buyer sees it as sent", line.fulfilment);
    t.check(line.trackingNumber === "CORRECTED999GB", "with the tracking number");
    t.check(line.carrier === "Royal Mail", "and the carrier");

    /* ============================================================ */
    t.section("delivery is the buyer's word, not the seller's");

    t.check((await seller.post(`/api/orders/items/${sale.id}/delivered`)).status === 404,
      "the seller cannot mark their own parcel delivered");

    const confirmed = await buyer.post(`/api/orders/items/${sale.id}/delivered`);
    t.check(confirmed.status === 200, "the buyer can confirm delivery", confirmed.status);
    const delivered = await prisma.orderItem.findUniqueOrThrow({
      where: { id: sale.id },
      select: { fulfilment: true, deliveredAt: true },
    });
    t.check(delivered.fulfilment === "DELIVERED", "recorded as DELIVERED", delivered.fulfilment);
    t.check(delivered.deliveredAt !== null, "with a timestamp");
    t.check((await buyer.post(`/api/orders/items/${sale.id}/delivered`)).status === 200,
      "confirming twice is idempotent");

    const finalSummary = (await seller.get("/api/seller/sales")).json.summary;
    t.check(finalSummary.toSend === 0 && finalSummary.delivered === 1,
      "the seller's summary moved with it", JSON.stringify(finalSummary));

    /* ============================================================ */
    t.section("cannot send — and says the refund is owed");

    /**
     * A listing this scope OWNS, so the seller side goes through the API.
     *
     * Borrowing a seeded listing meant importing markUnfulfillable and running
     * it in the TEST process — which refunds against this process's stub payment
     * map while the payment was taken by the server's. Fine when both are the
     * same process; broken the moment the API runs in a container.
     */
    const { seller: owner, listing: mine } = await scope.ownListing("owner");
    const { order: o2, paid: p2 } = await buyOne(buyer, mine.id);
    t.check(p2.json.outcome === "succeeded", "bought a second item");

    const sellerOfSecond = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: o2.id },
      select: { id: true, sellerId: true },
    });

    const cannotSend = await owner.post(
      `/api/seller/sales/${sellerOfSecond.id}/cannot-send`,
      { reason: "Broke while I was packing it, sorry." }
    );
    t.check(cannotSend.status === 200, "the seller marks it unsendable",
      `${cannotSend.status} ${cannotSend.text.slice(0, 120)}`);

    // Refunds are now issued in the same operation. This used to assert a
    // `refundOwed` flag, which was all the code could honestly offer at the
    // time. The refund path itself is covered in depth by api/refunds.ts.
    t.check(cannotSend.json.refunded === true,
      "marking it unfulfillable refunds the buyer, rather than quietly keeping the money",
      JSON.stringify(cannotSend.json));
    t.check(cannotSend.json.refundCents > 0, "for a non-zero amount",
      cannotSend.json?.refundCents);

    const buyerSees = await buyer.get(`/api/orders/${o2.id}`);
    t.check(buyerSees.json.order.items[0].fulfilment === "UNFULFILLABLE",
      "the buyer sees it cannot be sent", buyerSees.json.order.items[0]?.fulfilment);
    t.check(/broke while/i.test(buyerSees.json.order.items[0].fulfilmentNote ?? ""),
      "with the seller's reason", buyerSees.json.order.items[0]?.fulfilmentNote);
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
