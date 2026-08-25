import { prisma, requireCatalog, requireServices } from "../lib/db";
import { awaitNotifications, buyOne, checkoutOne, Scope } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * Notifications.
 *
 * The important property is not that rows appear — it's that they appear as a
 * side effect of something real, and that failing to create one can never undo
 * the thing it was about. Every emit is deliberately best-effort.
 *
 * Also asserted: notifications go to the RIGHT person. A seller hearing about
 * their own purchase, or a buyer hearing about someone else's sale, is a
 * privacy leak dressed up as a feature.
 */

const scope = new Scope("notifs");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "notifications",
  async (t) => {
    await requireServices({ api: true, web: true });
    await requireCatalog();

    const seller = await scope.seller("seller");
    const buyer = await scope.buyer("buyer");
    const stranger = await scope.buyer("stranger");

    const sellerProfile = await prisma.sellerProfile.findFirstOrThrow({
      where: { user: { email: scope.emailFor("seller") } },
      select: { id: true },
    });
    const category = await prisma.category.findFirstOrThrow({ select: { id: true } });
    const listing = await prisma.listing.create({
      data: {
        slug: `notif-test-${Date.now()}`,
        title: "Notification test lamp",
        description: "Listed so a sale can raise a notification.",
        sellerId: sellerProfile.id,
        categoryId: category.id,
        condition: "GOOD",
        priceCents: 2500,
        quantity: 1,
        status: "ACTIVE",
      },
      select: { id: true, slug: true, title: true },
    });

    /* ---------------------------------------------------------- */
    t.section("starts empty");
    const empty = await buyer.get("/api/notifications");
    t.check(empty.status === 200, "notifications load", empty.status);
    t.check(empty.json.notifications.length === 0, "buyer has none",
      empty.json.notifications.length);
    t.check(empty.json.unread === 0, "unread is zero");
    t.check((await seller.get("/api/notifications/count")).json.unread === 0,
      "and so does the seller");

    /* ---------------------------------------------------------- *
     * An unpaid order tells nobody anything. The seller has nothing
     * to act on until money has moved.
     * ---------------------------------------------------------- */
    t.section("an unpaid order notifies nobody");
    await checkoutOne(buyer, listing.id);
    t.check((await seller.get("/api/notifications/count")).json.unread === 0,
      "seller is not told about an unpaid checkout");

    const pending = await prisma.order.findFirstOrThrow({
      where: { buyer: { email: scope.emailFor("buyer") }, status: "PENDING_PAYMENT" },
      orderBy: { createdAt: "desc" },
      select: { id: true, reference: true },
    });

    /* ---------------------------------------------------------- */
    t.section("paying tells the seller");
    const paid = await buyer.post(`/api/orders/${pending.id}/pay`, {
      cardNumber: "4242424242424242",
    });
    t.check(paid.json.outcome === "succeeded", "payment went through", paid.json?.outcome);

    const afterSale = await seller.get("/api/notifications");
    t.check(afterSale.json.unread === 1, "seller has one unread", afterSale.json.unread);
    const sale = afterSale.json.notifications[0];
    t.check(sale?.type === "SALE_MADE", "of the right type", sale?.type);
    t.check(sale?.title.includes(listing.title), "naming the item", sale?.title);
    t.check(sale?.body?.includes(pending.reference), "and the order reference", sale?.body);
    t.check(sale?.link === "/seller/sales", "linking somewhere useful", sale?.link);
    t.check(sale?.read === false, "unread");

    t.check((await buyer.get("/api/notifications/count")).json.unread === 0,
      "the BUYER is not told about their own purchase");
    t.check((await stranger.get("/api/notifications/count")).json.unread === 0,
      "and a stranger hears nothing at all");

    /**
     * Webhooks are delivered at least once, so markOrderPaid runs again for
     * orders already paid. A second "your item sold" is indistinguishable from
     * a second sale, so it must not happen.
     */
    const { markOrderPaid } = await import("../../src/lib/orders");
    await markOrderPaid(pending.id);
    t.check((await seller.get("/api/notifications/count")).json.unread === 1,
      "a redelivered payment does NOT notify the seller twice",
      (await seller.get("/api/notifications/count")).json.unread);

    /* ---------------------------------------------------------- */
    t.section("shipping tells the buyer");
    const saleRow = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: pending.id },
      select: { id: true },
    });
    await seller.post(`/api/seller/sales/${saleRow.id}/ship`, {
      carrier: "Royal Mail",
      trackingNumber: "RM555GB",
    });

    // Waited for. The route responds before notify() has committed — that is
    // the point of fire-and-forget — so reading the inbox on the next line is a
    // race. It passed on the host and failed against a containerised API, where
    // the HTTP round trip changes the timing.
    await awaitNotifications(scope.emailFor("buyer"), ["ORDER_SHIPPED"]);

    const shipped = await buyer.get("/api/notifications");
    t.check(shipped.json.unread === 1, "buyer has one unread", shipped.json.unread);
    const ship = shipped.json.notifications[0];
    t.check(ship?.type === "ORDER_SHIPPED", "of the right type", ship?.type);
    t.check(ship?.body?.includes("RM555GB"), "carrying the tracking number", ship?.body);
    t.check(ship?.link === `/orders/${pending.id}`, "linking to the order", ship?.link);

    /* ---------------------------------------------------------- */
    t.section("delivery tells the seller");
    await buyer.post(`/api/orders/items/${saleRow.id}/delivered`);
    await awaitNotifications(scope.emailFor("seller"), ["ORDER_DELIVERED"]);
    const delivered = await seller.get("/api/notifications");
    t.check(delivered.json.unread === 2, "seller now has two unread", delivered.json.unread);
    t.check(delivered.json.notifications[0]?.type === "ORDER_DELIVERED",
      "newest first, and it's the delivery", delivered.json.notifications[0]?.type);

    /* ---------------------------------------------------------- */
    t.section("a review tells the seller — once");
    const review = await buyer.post("/api/reviews", {
      listingId: listing.id,
      rating: 5,
      body: "Lovely lamp.",
    });
    t.check(review.status === 201, "review posted", review.status);

    await awaitNotifications(scope.emailFor("seller"), ["REVIEW_RECEIVED"]);
    const afterReview = await seller.get("/api/notifications");
    t.check(afterReview.json.unread === 3, "seller told about the review",
      afterReview.json.unread);
    t.check(afterReview.json.notifications[0]?.type === "REVIEW_RECEIVED",
      "of the right type", afterReview.json.notifications[0]?.type);
    t.check(/5-star/.test(afterReview.json.notifications[0]?.title ?? ""),
      "with the rating in the title", afterReview.json.notifications[0]?.title);

    // Editing your own wording is not news. Notifying on every edit is how a
    // bell becomes noise nobody reads.
    await buyer.post("/api/reviews", {
      listingId: listing.id,
      rating: 4,
      body: "Edited: still lovely, slight scuff.",
    });
    t.check((await seller.get("/api/notifications/count")).json.unread === 3,
      "editing a review does NOT notify again");

    /* ---------------------------------------------------------- */
    t.section("reading");
    const first = afterReview.json.notifications[0].id;
    const read = await seller.post(`/api/notifications/${first}/read`);
    t.check(read.status === 200 && read.json.unread === 2, "marking one read drops the count",
      read.json?.unread);
    t.check((await seller.post(`/api/notifications/${first}/read`)).json.unread === 2,
      "marking it again is a no-op, not an error");

    const unreadOnly = await seller.get("/api/notifications?unread=true");
    t.check(unreadOnly.json.notifications.length === 2, "unread filter works",
      unreadOnly.json.notifications.length);
    t.check(!unreadOnly.json.notifications.some((n: any) => n.id === first),
      "and excludes the one just read");

    const all = await seller.post("/api/notifications/read-all");
    t.check(all.json.marked === 2 && all.json.unread === 0, "read-all clears the rest",
      JSON.stringify(all.json));

    /* ---------------------------------------------------------- */
    t.section("nobody touches anyone else's");
    const sellerNotif = (await seller.get("/api/notifications")).json.notifications[0];
    t.check((await stranger.post(`/api/notifications/${sellerNotif.id}/read`)).json.unread === 0,
      "a stranger marking it read changes nothing for them");
    const stillThere = await prisma.notification.findUnique({
      where: { id: sellerNotif.id },
      select: { id: true },
    });
    t.check(stillThere !== null, "and the notification still exists");

    const strangerDelete = await stranger.delete(`/api/notifications/${sellerNotif.id}`);
    t.check(strangerDelete.status === 204, "delete responds 204 either way");
    t.check(await prisma.notification.count({ where: { id: sellerNotif.id } }) === 1,
      "but a stranger's delete does NOT remove it");

    t.check((await prisma.notification.findFirst({ where: { id: sellerNotif.id } })) !== null,
      "confirmed still present");
    const ownDelete = await seller.delete(`/api/notifications/${sellerNotif.id}`);
    t.check(ownDelete.status === 204, "the owner can delete it");
    t.check(await prisma.notification.count({ where: { id: sellerNotif.id } }) === 0,
      "and it is gone");

    /* ---------------------------------------------------------- */
    t.section("signed out");
    const { web } = await import("../lib/api");
    t.check((await web().get("/api/notifications")).status === 401,
      "cannot read notifications signed out");

    /* ---------------------------------------------------------- */
    t.section("cannot-send tells the buyer, and states the refund position");
    // Owned rather than borrowed, so the seller can be driven through the API —
    // see the note in api/refunds.ts. Calling the library in-process refunds
    // against the wrong payment provider state once the API is a container.
    const { seller: owner, listing: mine } = await scope.ownListing("owner");
    const { order: o2 } = await buyOne(buyer, mine.id);
    const line2 = await prisma.orderItem.findFirstOrThrow({
      where: { orderId: o2.id },
      select: { id: true, sellerId: true },
    });
    await owner.post(`/api/seller/sales/${line2.id}/cannot-send`, {
      reason: "It broke while I was packing it.",
    });

    /**
     * Waited for, and found by type rather than by index.
     *
     * One seller action now raises TWO notifications — "can't be sent" and
     * "refunded" — both fire-and-forget, so neither the ordering nor the timing
     * is guaranteed. Reading the inbox on the next line passed when run alone
     * and failed inside a full run, which is the worst of both.
     */
    const inbox = await awaitNotifications(scope.emailFor("buyer"), [
      "ORDER_UNFULFILLABLE",
      "REFUND_ISSUED",
    ]);
    const top = inbox.find((n) => n.type === "ORDER_UNFULFILLABLE");
    t.check(!!top, "buyer told it can't be sent", inbox.map((n) => n.type).join(", "));
    t.check(/broke while/i.test(top?.body ?? ""), "with the seller's reason", top?.body);
    /**
     * This used to assert the opposite — that the message admitted refunds were
     * not automated. That was the honest thing to say when they were not, and
     * asserting it now would be a test defending the worse behaviour.
     */
    t.check(/refunded/i.test(top?.body ?? ""),
      "and says the money has gone back", top?.body);
    t.check(!/aren't automated|settling with the seller/i.test(top?.body ?? ""),
      "rather than telling them to chase the seller themselves", top?.body);

    // The refund notification is a separate event, so it arrives separately.
    t.check(inbox.some((n) => n.type === "REFUND_ISSUED"),
      "and a refund notification arrives alongside it",
      inbox.map((n) => n.type).join(", "));
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
