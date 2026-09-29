import { API, prisma, requireCatalog, requireServices } from "./lib/db";
import { CARDS, Scope } from "./lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "./lib/harness";
import type { Client } from "./lib/api";
import type { Suite } from "./lib/harness";

/**
 * Payment safety, end to end against a running server.
 *
 * WHY THIS EXISTS
 * The double-charge race it covers was a live bug: five simultaneous pay
 * requests produced five successful charges. A status check before the provider
 * call is not enough, because the check and the charge are two separate steps.
 * Each case below maps to a specific way that can go wrong.
 *
 * Runs against the Express API directly rather than through the BFF. The point
 * of most of these cases is that concurrent requests serialise, and an extra
 * proxy hop in front of each one spreads them out in time — which makes the
 * race less likely to occur and the test correspondingly weaker.
 *
 * Slow on purpose: [9] waits for the reconciliation sweeper, whose interval is
 * 60 seconds.
 *
 *   npm run test:payments
 */

const scope = new Scope("pay");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

/**
 * Hold then checkout, returning the stock the listing had beforehand.
 *
 * The catalog does not have uniform stock, so every assertion about quantity
 * has to compare against what this particular listing actually had. Comparing
 * against a hardcoded 1 silently corrupted a seeded set-of-three once.
 */
async function orderFor(
  client: Client,
  minQuantity = 1,
  opts: { exactQuantity?: number } = {}
) {
  const listing = await scope.claimListing({ minQuantity, ...opts });

  const held = await client.post("/reservations", { listingId: listing.id, quantity: 1 });
  if (held.status !== 200 && held.status !== 201) {
    throw new Error(`could not hold ${listing.id}: ${held.status} ${held.text.slice(0, 140)}`);
  }
  const created = await client.post("/orders");
  if (created.status !== 201) {
    throw new Error(`checkout failed: ${created.status} ${created.text.slice(0, 140)}`);
  }

  return {
    listing,
    quantityBefore: listing.stockBefore as number,
    order: created.json.order,
    payment: created.json.payment,
  };
}

function pay(client: Client, orderId: string, card: string) {
  return client.post(`/orders/${orderId}/pay`, { cardNumber: card });
}

/** Carried from [6] to [9]: an order deliberately left mid-payment. */
type InFlight = { orderId: string; listingId: string; quantityBefore: number };

void main(
  "payment safety",
  async (t: Suite) => {
    await requireServices({ api: true });
    await requireCatalog();

    const buyer = await scope.apiBuyer("main");
    let inFlight: InFlight | null = null;

    /* ============================================================ *
     * 1. The bug this was built for: N simultaneous pay requests.
     * ============================================================ */
    t.section("1 - five simultaneous pay requests for one order");
    {
      const { order } = await orderFor(buyer);
      const N = 5;
      const results = await Promise.all(
        Array.from({ length: N }, () => pay(buyer, order.id, CARDS.succeeds))
      );

      const ok = results.filter((r) => r.status === 200 && r.json?.outcome === "succeeded");
      const refused = results.filter((r) => r.status === 409);
      const codes = refused.map((r) => r.json?.code);

      t.note(`statuses: ${JSON.stringify(results.map((r) => r.status))}`);
      t.note(`outcomes: ${JSON.stringify(results.map((r) => r.json?.outcome ?? r.json?.code))}`);

      t.check(ok.length === 1, "exactly one request charged", `got ${ok.length}`);
      t.check(refused.length === N - 1, `the other ${N - 1} were refused`, `got ${refused.length}`);
      t.check(
        codes.every((c) => c === "PAYMENT_IN_PROGRESS" || c === "ALREADY_PAID"),
        "refusals used a payment-specific code",
        JSON.stringify(codes)
      );

      const row = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true, paidAt: true },
      });
      t.check(row.status === "PAID", "order ended PAID", row.status);
      t.check(row.paidAt !== null, "paidAt recorded");
    }

    /* ============================================================ *
     * 2. Sequential retry after success.
     * ============================================================ */
    t.section("2 - paying an already-paid order");
    {
      /**
       * EXACTLY one in stock, not merely one or more. This section asserts the
       * listing sells OUT — `SOLD`, quantity 0 — which is only true of a
       * single-stock listing. Borrowing "any listing with at least one" passed
       * for as long as the catalogue was entirely quantity-1 and then began
       * failing about one run in six once `seed:scale` introduced multi-stock
       * listings, on a listing that was correctly left ACTIVE. Section 2b is
       * where the multi-stock case belongs.
       */
      const { listing, order } = await orderFor(buyer, 1, { exactQuantity: 1 });
      const first = await pay(buyer, order.id, CARDS.succeeds);
      t.check(first.json?.outcome === "succeeded", "first payment succeeded");

      const again = await pay(buyer, order.id, CARDS.succeeds);
      t.check(again.status === 409 && again.json?.code === "ALREADY_PAID",
        "second refused as ALREADY_PAID", `${again.status} ${again.json?.code}`);

      // The listing id comes from the claim rather than by walking
      // order -> item -> listing. The old version did that walk inline, on one
      // line, and was unreadable.
      const row = await prisma.listing.findUniqueOrThrow({
        where: { id: listing.id },
        select: { status: true, quantity: true },
      });
      t.check(row.status === "SOLD" && row.quantity === 0, "listing marked SOLD once",
        `${row.status} q=${row.quantity}`);
    }

    /* ============================================================ *
     * 2b. Buying ONE of several identical pieces.
     *
     * A regression test for a destructive bug: payment forced
     * `status: SOLD, quantity: 0` on every line, so buying one of three
     * skillets deleted the other two from the shop. It survived every earlier
     * test because they all happened to pick quantity-1 listings — the bug was
     * only found in a real order placed by the site's owner.
     * ============================================================ */
    t.section("2b - buying one of several identical pieces");
    {
      const { listing, order, quantityBefore } = await orderFor(buyer, 2);
      t.note(`"${listing.title}" had ${quantityBefore} in stock`);
      t.check(quantityBefore >= 2, "picked a multi-quantity listing", String(quantityBefore));

      const paid = await pay(buyer, order.id, CARDS.succeeds);
      t.check(paid.json?.outcome === "succeeded", "payment succeeded");

      const row = await prisma.listing.findUniqueOrThrow({
        where: { id: listing.id },
        select: { status: true, quantity: true },
      });
      t.check(row.quantity === quantityBefore - 1, "exactly one was taken out of stock",
        `q=${row.quantity}, expected ${quantityBefore - 1}`);
      t.check(row.status === "ACTIVE", "the listing is still for sale", row.status);

      const page = await fetch(`${API}/catalog/listings?limit=40`).then((r) => r.json());
      t.check(page.listings.some((x: { id: string }) => x.id === listing.id),
        "and still visible in the catalog");
    }

    /* ============================================================ *
     * 3. A malformed card must not strand the order in PROCESSING.
     *    This is why validation runs before the claim.
     * ============================================================ */
    t.section("3 - a typo must not lock the order");
    {
      const { order } = await orderFor(buyer);
      const bad = await pay(buyer, order.id, "4242");
      t.check(bad.status === 400, "malformed number rejected with 400", String(bad.status));

      const row = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true },
      });
      t.check(row.status === "PENDING_PAYMENT", "order still PENDING_PAYMENT, not stuck", row.status);

      const retry = await pay(buyer, order.id, CARDS.succeeds);
      t.check(retry.json?.outcome === "succeeded", "buyer can still pay after the typo");
    }

    /* ============================================================ *
     * 4. A decline is definitive: stock returns, no money moved.
     * ============================================================ */
    t.section("4 - declined card");
    {
      const { listing, order, quantityBefore } = await orderFor(buyer);
      const declined = await pay(buyer, order.id, CARDS.declined);
      t.check(declined.json?.outcome === "failed", "reported as failed",
        JSON.stringify(declined.json?.outcome));
      t.check(/declin/i.test(declined.json?.reason ?? ""), "reason mentions the decline",
        declined.json?.reason);

      const row = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true, paidAt: true },
      });
      t.check(row.status === "FAILED", "order FAILED", row.status);
      t.check(row.paidAt === null, "paidAt left null");

      const l = await prisma.listing.findUniqueOrThrow({
        where: { id: listing.id },
        select: { status: true, quantity: true },
      });
      t.check(l.status === "ACTIVE" && l.quantity === quantityBefore,
        "stock returned to the catalog",
        `${l.status} q=${l.quantity}, expected ${quantityBefore}`);
    }

    /* ============================================================ *
     * 5. Concurrent declines: the claim must serialise these too.
     * ============================================================ */
    t.section("5 - five simultaneous declines");
    {
      const { order } = await orderFor(buyer);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => pay(buyer, order.id, CARDS.declined))
      );
      const attempted = results.filter((r) => r.status === 200);
      t.check(attempted.length === 1, "only one attempt reached the provider",
        `got ${attempted.length}`);

      const row = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true },
      });
      t.check(row.status === "FAILED", "order settled as FAILED", row.status);
    }

    /* ============================================================ *
     * 6. 3-D Secure: pending is not failure, and stock stays committed.
     * ============================================================ */
    t.section("6 - card needing authentication stays in flight");
    {
      const { listing, order, quantityBefore } = await orderFor(buyer);
      const pending = await pay(buyer, order.id, CARDS.needsAuth);
      t.check(pending.json?.outcome === "pending", "reported as pending, not failed",
        JSON.stringify(pending.json?.outcome));

      const row = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true },
      });
      t.check(row.status === "PROCESSING", "order held in PROCESSING", row.status);

      const l = await prisma.listing.findUniqueOrThrow({
        where: { id: listing.id },
        select: { quantity: true },
      });
      t.check(l.quantity === quantityBefore - 1, "stock still committed while in flight",
        `q=${l.quantity}, expected ${quantityBefore - 1}`);

      const cancel = await buyer.post(`/orders/${order.id}/cancel`);
      t.check(cancel.status === 409 && cancel.json?.code === "PAYMENT_IN_PROGRESS",
        "cannot cancel while a charge may be in flight",
        `${cancel.status} ${cancel.json?.code}`);

      const retry = await pay(buyer, order.id, CARDS.succeeds);
      t.check(retry.status === 409 && retry.json?.code === "PAYMENT_IN_PROGRESS",
        "cannot start a second payment either", `${retry.status} ${retry.json?.code}`);

      // Left in flight on purpose: [9] proves reconciliation settles it. Passed
      // in a local rather than on globalThis, which the old version used and
      // which hid the dependency between the two sections entirely.
      inFlight = { orderId: order.id, listingId: listing.id, quantityBefore };
    }

    /* ============================================================ *
     * 7. Ownership: another buyer cannot pay or see it.
     * ============================================================ */
    t.section("7 - cross-buyer isolation");
    {
      const { order } = await orderFor(buyer);
      const stranger = await scope.apiBuyer("stranger");

      const peek = await stranger.get(`/orders/${order.id}`);
      t.check(peek.status === 404, "stranger gets 404, not 403", String(peek.status));

      const attempt = await pay(stranger, order.id, CARDS.succeeds);
      t.check(attempt.status === 404, "stranger cannot pay it", String(attempt.status));

      const row = await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true },
      });
      t.check(row.status === "PENDING_PAYMENT", "the claim was never taken by the stranger",
        row.status);

      await buyer.post(`/orders/${order.id}/cancel`);
    }

    /* ============================================================ *
     * 8. A forged webhook must not mark anything paid.
     * ============================================================ */
    t.section("8 - unsigned webhook");
    {
      const forged = await fetch(`${API}/webhooks/stripe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment_intent.succeeded",
          data: { object: { id: "pi_stub_forged" } },
        }),
      });
      t.check(forged.status === 400, "rejected without a valid signature", String(forged.status));

      const body = await forged.json().catch(() => ({}));
      t.check(!/secret|sk_/i.test(JSON.stringify(body)), "no secret leaked in the error");
    }

    /* ============================================================ *
     * 9. Reconciliation settles an order left mid-payment.
     * ============================================================ */
    t.section("9 - reconciliation of an in-flight payment");
    if (!inFlight) {
      t.check(false, "section 6 left an order in flight to reconcile");
    } else {
      const { orderId, listingId, quantityBefore } = inFlight;

      // Backdate past both windows: the 2-minute reconcile TTL and the
      // 30-minute abandonment window, so the sweeper treats it as a dead
      // 3-D Secure prompt. "id" is a text column, so no uuid cast.
      await prisma.$executeRaw`
        UPDATE "orders"
        SET "updatedAt" = NOW() - INTERVAL '40 minutes',
            "createdAt" = NOW() - INTERVAL '40 minutes'
        WHERE "id" = ${orderId}
      `;
      t.note("waiting for the sweeper (interval is 60s)...");

      let settled: string | null = null;
      const deadline = Date.now() + 100_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5_000));
        const row = await prisma.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { status: true },
        });
        if (row.status !== "PROCESSING") {
          settled = row.status;
          break;
        }
      }

      t.check(settled !== null, "sweeper settled the stuck order",
        settled ?? "still PROCESSING after 100s");
      // The stub left this intent in requires_action — pending, never
      // succeeded. Inventing a payment here would be the worst outcome of all.
      t.check(settled !== "PAID", "did not invent a payment that never completed",
        String(settled));
      t.check(settled === "CANCELLED", "settled as CANCELLED", String(settled));

      const l = await prisma.listing.findUniqueOrThrow({
        where: { id: listingId },
        select: { status: true, quantity: true },
      });
      t.check(l.quantity === quantityBefore && l.status === "ACTIVE",
        "stock came back out of the deadlock",
        `${l.status} q=${l.quantity}, expected ${quantityBefore}`);

      // The intent must be dead, or a late 3-D Secure completion would pay for
      // stock that is already back on sale.
      const retry = await pay(buyer, orderId, CARDS.succeeds);
      t.check(retry.status === 409, "the cancelled order is not payable again",
        String(retry.status));
    }

    /* ============================================================ *
     * 10. No card data anywhere in the database.
     * ============================================================ */
    t.section("10 - card data is never persisted");
    {
      const orders = await prisma.order.findMany({
        select: {
          id: true,
          paymentIntentId: true,
          failureReason: true,
          paymentProvider: true,
        },
      });
      const items = await prisma.orderItem.findMany();
      const blob = JSON.stringify({ orders, items });

      for (const n of [CARDS.succeeds, CARDS.declined, CARDS.needsAuth, "4242", "0002"]) {
        t.check(!blob.includes(n), `no trace of ${n}`);
      }
      t.check(
        orders.every((o) => !o.paymentIntentId || o.paymentIntentId.startsWith("pi_")),
        "only provider references stored"
      );
    }

    await scope.cleanup();
    await scope.verifyClean(t);
  },
  () => scope.cleanup()
);
