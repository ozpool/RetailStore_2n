import { catalog } from "../lib/api";
import { prisma, requireCatalog, requireServices } from "../lib/db";
import { CARDS, Scope, checkoutOne } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * Checkout through the Next.js BFF — the path a browser actually takes.
 *
 * Distinct from the payment-safety suite, which hits the Express API directly.
 * This one exists because the proxy layer has broken things the API tests could
 * never see: it once corrupted multipart uploads by reading bodies as text, and
 * it has to replay bodies on a refresh-and-retry.
 */

const scope = new Scope("bff");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "checkout through the BFF",
  async (t) => {
    await requireServices({ api: true, web: true });
    await requireCatalog();

    const buyer = await scope.buyer("buyer");
    const listing = await scope.claimListing();
    t.note(`using "${listing.title}"`);

    /* ---------------------------------------------------------- */
    t.section("creating an order");
    const order = await checkoutOne(buyer, listing.id);
    t.check(!!order.id, "order has an id");
    t.check(!!order.reference, "order has a reference", order.reference);
    t.check(order.testMode === true, "testMode flag present and true", order.testMode);
    t.check(typeof order.subtotalCents === "number", "subtotal is a number");
    t.check(Array.isArray(order.items) && order.items.length === 1, "one line item");
    t.check(!!order.items[0].sellerName, "line item carries the seller snapshot");
    t.note(`provider: ${order.paymentProvider}`);

    /* ---------------------------------------------------------- */
    t.section("reading it back");
    const fetched = await buyer.get(`/api/orders/${order.id}`);
    t.check(fetched.status === 200, "GET /api/orders/:id", fetched.status);
    t.check(fetched.json.order.reference === order.reference, "same order returned");

    const list = await buyer.get("/api/orders");
    t.check(list.status === 200 && Array.isArray(list.json.orders), "GET /api/orders lists orders");
    t.check(list.json.orders.some((o: any) => o.id === order.id), "the new order appears");

    /* ---------------------------------------------------------- */
    t.section("paying");
    const declined = await buyer.post(`/api/orders/${order.id}/pay`, {
      // Spaced deliberately: the browser formats card numbers in groups of four.
      cardNumber: "4000 0000 0000 0002",
    });
    t.check(declined.status === 200 && declined.json.outcome === "failed",
      "a spaced decline card is refused correctly",
      `${declined.status} ${declined.json?.outcome}`);

    const stockBack = await prisma.listing.findUniqueOrThrow({
      where: { id: listing.id },
      select: { quantity: true },
    });
    t.check(stockBack.quantity === listing.stockBefore, "a decline returned the stock",
      `${stockBack.quantity} vs ${listing.stockBefore}`);

    const order2 = await checkoutOne(buyer, listing.id);
    const paid = await buyer.post(`/api/orders/${order2.id}/pay`, {
      cardNumber: `${CARDS.succeeds.slice(0, 4)} ${CARDS.succeeds.slice(4, 8)} ${CARDS.succeeds.slice(8, 12)} ${CARDS.succeeds.slice(12)}`,
    });
    t.check(paid.status === 200 && paid.json.outcome === "succeeded", "payment succeeded via the BFF",
      `${paid.status} ${paid.json?.outcome}`);
    t.check(paid.json.order.status === "PAID", "order is PAID", paid.json.order?.status);
    t.check(!!paid.json.order.paidAt, "paidAt set");

    const again = await buyer.post(`/api/orders/${order2.id}/pay`, {
      cardNumber: CARDS.succeeds,
    });
    t.check(again.status === 409 && again.json.code === "ALREADY_PAID",
      "a second payment is refused through the BFF too",
      `${again.status} ${again.json?.code}`);

    /* ---------------------------------------------------------- */
    t.section("the catalog reflects it");
    const after = await catalog<{ listings: any[] }>("/catalog/listings?limit=40");
    const stillListed = after.listings.find((l) => l.id === listing.id);
    if (listing.stockBefore === 1) {
      t.check(!stillListed, "a sold-out one-of-a-kind leaves the catalog");
    } else {
      t.check(!!stillListed, "a multi-quantity listing stays in the catalog");
      t.check(stillListed.quantity === listing.stockBefore - 1,
        "with exactly one fewer in stock",
        `${stillListed?.quantity} vs ${listing.stockBefore - 1}`);
    }
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
