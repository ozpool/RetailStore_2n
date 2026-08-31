import { prisma, requireCatalog, requireServices } from "../lib/db";
import { awaitNotifications, buyOne, checkoutOne, PASSWORD, Scope } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";
import { currentCode, freshCode } from "../lib/totp";
import {
  hasWebhookSecret,
  refundObject,
  send,
  sendForged,
  sendUnsigned,
} from "../lib/stripeWebhook";

/**
 * Refunds.
 *
 * WHY THIS EXISTS
 * A seller could mark a line "can't send it" and the buyer's money simply
 * stayed taken — the code recorded that a refund was owed and had no mechanism
 * to settle it. That is the bug these assertions exist to keep fixed.
 *
 * THE ASSERTIONS THAT MATTER MOST ARE THE ARITHMETIC ONES
 * Anyone can call a provider's refund endpoint. The hard part is never sending
 * back more than came in, and never sending the same money back twice, when
 * requests arrive together. Those are sections 3 and 4, and they are the reason
 * refunds go through one atomic claim rather than a read-then-write check.
 */

const scope = new Scope("refund");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

/** The seller profile that owns a paid line, so the seller path can be driven. */
async function lineOf(orderId: string) {
  return prisma.orderItem.findFirstOrThrow({
    where: { orderId },
    select: { id: true, sellerId: true, title: true, unitPriceCents: true, quantity: true },
  });
}

void main(
  "refunds",
  async (t) => {
    await requireServices({ api: true, web: true });
    await requireCatalog();

    const buyer = await scope.buyer("buyer");

    /* ============================================================ *
     * 1. The bug: a seller who cannot send must refund the buyer.
     * ============================================================ */
    t.section("1 - can't send it, so the money goes back");

    /**
     * A listing this suite OWNS, so the seller can be driven through the API.
     *
     * The earlier version borrowed a seeded listing and called markUnfulfillable
     * by importing it — which runs the refund in the TEST process while the
     * payment was taken by the SERVER. Against a containerised API that fails
     * outright: the stub provider holds intents in an in-process Map, so the
     * refund looks for the payment in an empty one.
     */
    const { seller, listing: owned } = await scope.ownListing("seller", {
      priceCents: 10853,
    });
    const { order, paid } = await buyOne(buyer, owned.id);
    t.check(paid.json.outcome === "succeeded", "the item was bought and paid for",
      paid.json?.outcome);

    const line = await lineOf(order.id);
    const paidForLine = line.unitPriceCents * line.quantity;

    const sales = await seller.get("/api/seller/sales");
    const sale = sales.json.sales.find((x: { id: string }) => x.id === line.id);
    t.check(!!sale, "the seller sees the sale", `${sales.status} ${sales.json?.sales?.length}`);

    const cannotSend = await seller.post(`/api/seller/sales/${line.id}/cannot-send`, {
      reason: "Cracked while I was packing it.",
    });
    t.check(cannotSend.status === 200, "the seller can mark it unsendable",
      `${cannotSend.status} ${cannotSend.text.slice(0, 120)}`);

    const result = cannotSend.json;
    t.check(result.refunded === true, "the refund is issued in the same operation",
      JSON.stringify(result));
    t.check(result.refundCents === paidForLine,
      "for exactly what was paid for that line, not the whole order",
      `${result.refundCents} vs ${paidForLine}`);
    t.check(result.refundError === null, "with no provider error", result.refundError);

    const refundRow = await prisma.refund.findFirstOrThrow({
      where: { orderItemId: line.id },
      select: {
        amountCents: true, status: true, trigger: true, reason: true,
        providerRefundId: true, completedAt: true, initiatedById: true,
      },
    });
    t.check(refundRow.status === "SUCCEEDED", "the refund row settled", refundRow.status);
    t.check(refundRow.trigger === "SELLER_UNFULFILLABLE",
      "recorded as the seller's doing, not a moderator's", refundRow.trigger);
    t.check(/cracked while/i.test(refundRow.reason),
      "carrying the seller's own words", refundRow.reason);
    t.check(refundRow.initiatedById === null,
      "with no moderator attributed to an automatic refund");
    t.check(!!refundRow.providerRefundId, "and a provider reference",
      refundRow.providerRefundId);
    t.check(
      !refundRow.providerRefundId?.includes("4242"),
      "which is a reference, not card data"
    );

    /* ---- a single-line order refunded in full flips status ---- */
    const afterFull = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true, refundedCents: true, subtotalCents: true },
    });
    t.check(afterFull.refundedCents === afterFull.subtotalCents,
      "the whole order is accounted for",
      `${afterFull.refundedCents}/${afterFull.subtotalCents}`);
    t.check(afterFull.status === "REFUNDED",
      "so the order reads REFUNDED", afterFull.status);

    /* ---- the buyer is told, and told honestly ---- */
    // Waited for: notify() is fire-and-forget, so the rows land just after the
    // call returns. See awaitNotifications in lib/fixtures.ts.
    const notes = await awaitNotifications(scope.emailFor("buyer"), [
      "REFUND_ISSUED",
      "ORDER_UNFULFILLABLE",
    ]);
    const refundNote = notes.find((n) => n.type === "REFUND_ISSUED");
    t.check(!!refundNote, "the buyer gets a refund notification",
      notes.map((n) => n.type).join(", "));
    t.check(/few days/i.test(refundNote?.body ?? ""),
      "which mentions the bank delay rather than implying it is instant",
      refundNote?.body);

    const unfulfillableNote = notes.find((n) => n.type === "ORDER_UNFULFILLABLE");
    t.check(/refunded/i.test(unfulfillableNote?.body ?? ""),
      "and the can't-send message says the money went back",
      unfulfillableNote?.body);
    t.check(!/aren't automated|settling with the seller/i.test(unfulfillableNote?.body ?? ""),
      "no longer telling them to chase the seller themselves");

    /* ============================================================ *
     * 2. Doing it twice must not pay twice.
     * ============================================================ */
    t.section("2 - the same line cannot be refunded twice");

    const again = await seller.post(`/api/seller/sales/${line.id}/cannot-send`, {
      reason: "Saying it again.",
    });
    t.check(again.status === 409 && again.json.code === "ALREADY_UNFULFILLABLE",
      "a second attempt is refused, and says why rather than 'not found'",
      `${again.status} ${again.json?.code}`);

    const rowCount = await prisma.refund.count({ where: { orderItemId: line.id } });
    t.check(rowCount === 1, "and leaves exactly one refund row", rowCount);

    const unchanged = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { refundedCents: true, subtotalCents: true },
    });
    t.check(unchanged.refundedCents === unchanged.subtotalCents,
      "with the total untouched", `${unchanged.refundedCents}/${unchanged.subtotalCents}`);

    /* ---- the seller can still see it ---- *
     *
     * A fully refunded order becomes REFUNDED, and every seller query used to
     * filter on PAID alone — which made the sale vanish from their list, their
     * summary, and their totals as though it never happened.
     */
    const after = await seller.get("/api/seller/sales");
    t.check(after.json.sales.some((x: { id: string }) => x.id === line.id),
      "a refunded sale is still visible to the seller, not vanished",
      `${after.json?.sales?.length} sale(s) listed`);
    t.check(after.json.summary.refunded >= 1,
      "counted as refunded in their summary", after.json?.summary?.refunded);

    /**
     * AND THE LINE ITSELF SAYS SO.
     *
     * The summary count alone is not enough, which is how this shipped wrong:
     * the totals excluded refunded lines (correctly) while every row rendered
     * at full price with nothing distinguishing it. The rows added up to more
     * than the figure above them and the page gave no reason why, so the
     * arithmetic looked broken rather than the money looking returned.
     *
     * A seller with several sales also has to know WHICH one came back, and a
     * count cannot tell them.
     */
    const refundedLine = after.json.sales.find((x: { id: string }) => x.id === line.id);
    t.check(refundedLine?.refunded === true,
      "and the line itself is marked refunded, not just counted",
      `refunded=${refundedLine?.refunded}`);

    const others = after.json.sales.filter((x: { id: string }) => x.id !== line.id);
    t.check(others.every((x: { refunded: boolean }) => x.refunded === false),
      "while sales that were not refunded are not marked",
      `${others.filter((x: { refunded: boolean }) => x.refunded).length} wrongly marked of ${others.length}`);

    /**
     * The single-sale read has to agree with the list.
     *
     * It calls the same `serialize`, whose `refunded` argument defaults to
     * false — so a caller that forgets to pass it gets a confident lie rather
     * than a missing field. Asserted rather than skipped-if-unavailable: a
     * conditional assertion that never runs is indistinguishable from one that
     * passes.
     */
    const one = await seller.get(`/api/seller/sales/${line.id}`);
    t.check(one.status === 200, "the single-sale view serves a refunded line", one.status);
    t.check(one.json?.sale?.refunded === true,
      "and marks it refunded there too, not just in the list",
      `refunded=${one.json?.sale?.refunded}`);

    /* ============================================================ *
     * 3. Never more than came in.
     *
     * From here the refunds are issued by a MODERATOR through the admin API,
     * which is both the real path for a dispute and the only way to reach the
     * server's own payment provider. Calling issueRefund() in-process refunds
     * against this process's stub map rather than the server's.
     *
     * It also gives /api/admin/orders/:id/refund its first coverage.
     * ============================================================ */
    t.section("3 - a refund cannot exceed what was paid");

    const admin = await scope.buyer("moderator");
    await prisma.user.update({
      where: { email: scope.emailFor("moderator") },
      data: { role: "ADMIN" },
    });
    const enrol = await admin.post("/api/admin/totp/setup", { password: PASSWORD });
    await admin.post("/api/admin/totp/confirm", { code: currentCode(enrol.json.secret) });
    // A fresh period: confirming spent the code above, and codes are single-use.
    const opened = await admin.post("/api/admin/session", {
      password: PASSWORD,
      code: await freshCode(enrol.json.secret),
    });
    t.check(opened.status === 200, "a moderator opens an admin session", opened.status);

    /** Issues a refund the way a moderator actually would. */
    const adminRefund = (orderId: string, amountCents: number, reason: string) =>
      admin.post(`/api/admin/orders/${orderId}/refund`, { amountCents, reason });

    const second = await scope.claimListing();
    const { order: o2 } = await buyOne(buyer, second.id);
    const o2Row = await prisma.order.findUniqueOrThrow({
      where: { id: o2.id },
      select: { subtotalCents: true },
    });

    // Read-only, so safe to call in-process: it queries the database and never
    // touches the payment provider.
    const { refundableCents } = await import("../../src/lib/refunds");

    t.check(await refundableCents(o2.id) === o2Row.subtotalCents,
      "the whole subtotal is refundable to begin with");

    const tooMuch = await adminRefund(
      o2.id,
      o2Row.subtotalCents + 1,
      "One cent more than was ever paid."
    );
    t.check(tooMuch.json.code === "EXCEEDS_ORDER_TOTAL",
      "refunding a penny more than the order is refused",
      `${tooMuch.status} ${tooMuch.json?.code}`);

    const notTouched = await prisma.order.findUniqueOrThrow({
      where: { id: o2.id },
      select: { refundedCents: true },
    });
    t.check(notTouched.refundedCents === 0,
      "and nothing was recorded against the order", notTouched.refundedCents);

    /* ---- a partial refund leaves the order PAID ---- */
    const half = Math.floor(o2Row.subtotalCents / 2);
    const partial = await adminRefund(o2.id, half, "Arrived scuffed, partial refund agreed.");
    t.check(partial.status === 200 && partial.json.refund.status === "SUCCEEDED",
      "a partial refund succeeds", `${partial.status} ${JSON.stringify(partial.json)}`);

    const partlyRefunded = await prisma.order.findUniqueOrThrow({
      where: { id: o2.id },
      select: { status: true, refundedCents: true },
    });
    t.check(partlyRefunded.status === "PAID",
      "a part-refunded order stays PAID, not REFUNDED", partlyRefunded.status);
    t.check(partlyRefunded.refundedCents === half,
      "with the amount recorded", partlyRefunded.refundedCents);
    t.check(await refundableCents(o2.id) === o2Row.subtotalCents - half,
      "and the remainder still refundable");

    /* ============================================================ *
     * 4. Concurrency. The reason this uses one atomic claim.
     *
     * Five simultaneous refunds of half the order against an order that has
     * already had half returned. At most one can be legitimate; a second would
     * send back more than came in.
     * ============================================================ */
    t.section("4 - five simultaneous refunds cannot overdraw the order");

    // Five real, simultaneous HTTP requests — a stronger test than five
    // in-process calls, because the server has to serialise genuinely
    // concurrent connections rather than interleaved promises.
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => adminRefund(o2.id, half, "Concurrent attempt."))
    );
    const succeeded = attempts.filter((r) => r.status === 200).length;
    t.check(succeeded <= 1, "at most one of five got through",
      `${succeeded} succeeded; statuses ${JSON.stringify(attempts.map((r) => r.status))}`);

    const final = await prisma.order.findUniqueOrThrow({
      where: { id: o2.id },
      select: { refundedCents: true, subtotalCents: true, status: true },
    });
    t.check(final.refundedCents <= final.subtotalCents,
      "the books never show more refunded than was paid",
      `${final.refundedCents}/${final.subtotalCents}`);

    const settledRows = await prisma.refund.findMany({
      where: { orderId: o2.id, status: { in: ["SUCCEEDED", "PENDING"] } },
      select: { amountCents: true },
    });
    const sum = settledRows.reduce((n, r) => n + r.amountCents, 0);
    t.check(sum === final.refundedCents,
      "and the refund rows add up to exactly that figure",
      `rows ${sum} vs order ${final.refundedCents}`);

    /* ============================================================ *
     * 5. Nothing to refund is refused, not silently allowed.
     * ============================================================ */
    t.section("5 - an unpaid order has nothing to give back");

    const third = await scope.claimListing();
    const unpaid = await checkoutOne(buyer, third.id);

    const onUnpaid = await adminRefund(unpaid.id, 100, "Should not be possible.");
    t.check(onUnpaid.json.code === "NOT_REFUNDABLE",
      "refunding an unpaid order is refused",
      `${onUnpaid.status} ${onUnpaid.json?.code}`);
    t.check(await refundableCents(unpaid.id) === 0,
      "and it reports nothing refundable");

    await buyer.post(`/api/orders/${unpaid.id}/cancel`);

    /* ---- a reason is not optional ---- */
    const noReason = await adminRefund(o2.id, 1, "  ");
    t.check(noReason.status === 400,
      "a refund with no stated reason is refused — the buyer is shown it",
      `${noReason.status} ${noReason.json?.code}`);

    /* ============================================================ *
     * 6. What the buyer can see.
     * ============================================================ */
    t.section("6 - the buyer can see their refunds");

    const mine = await buyer.get("/api/orders/refunds");
    t.check(mine.status === 200, "the refunds list loads", mine.status);
    t.check(mine.json.refunds.length >= 2, "and holds this suite's refunds",
      mine.json.refunds?.length);

    const withTitle = mine.json.refunds.find((r: { itemTitle: string | null }) => r.itemTitle);
    t.check(!!withTitle, "a line-level refund names the item it was for");
    t.check(typeof mine.json.refunds[0].orderReference === "string",
      "and carries the order reference support would ask for");

    const detail = await buyer.get(`/api/orders/${order.id}`);
    t.check(detail.status === 200, "the order detail loads", detail.status);
    t.check(Array.isArray(detail.json.order.refunds) && detail.json.order.refunds.length === 1,
      "with its refund attached", detail.json.order?.refunds?.length);
    t.check(/cracked while/i.test(detail.json.order.refunds[0]?.reason ?? ""),
      "and the reason the buyer is owed");

    /* ---- somebody else's refunds are not visible ---- */
    const stranger = await scope.buyer("stranger");
    const theirs = await stranger.get("/api/orders/refunds");
    t.check(theirs.status === 200 && theirs.json.refunds.length === 0,
      "a different buyer sees none of them", theirs.json?.refunds?.length);
    t.check((await stranger.get(`/api/orders/${order.id}`)).status === 404,
      "and cannot open the order either");

    /* ============================================================ *
     * 7. A refund the provider decides later.
     *
     * Stripe settles refunds synchronously in test mode, so a PENDING row is
     * seeded directly. That is the only way to reach this path — and the path
     * exists whether or not a test can provoke it naturally, which is exactly
     * why it needs covering. Without the webhook such a row would stay PENDING
     * for ever: the buyer told their money was coming, the headroom held, and
     * nothing anywhere to move it on.
     * ============================================================ */
    t.section("7 - a refund settled later, by webhook");

    if (!hasWebhookSecret()) {
      t.note("STRIPE_WEBHOOK_SECRET is not set — skipping the webhook section");
    } else {
      /** Seeds a paid order with one PENDING refund already claimed against it. */
      async function pendingRefund(tag: string) {
        const listing = await scope.claimListing();
        const { order: o } = await buyOne(buyer, listing.id);
        const row = await prisma.order.findUniqueOrThrow({
          where: { id: o.id },
          select: { subtotalCents: true },
        });

        const providerRefundId = `re_test_${tag}_${Date.now()}`;
        // Claim the headroom the way issueRefund would, so the unwind on
        // failure has something real to give back.
        await prisma.order.update({
          where: { id: o.id },
          data: { refundedCents: row.subtotalCents, status: "REFUNDED" },
        });
        const refund = await prisma.refund.create({
          data: {
            orderId: o.id,
            amountCents: row.subtotalCents,
            currency: "USD",
            status: "PENDING",
            trigger: "ADMIN",
            reason: `Awaiting the provider (${tag}).`,
            provider: "stripe",
            providerRefundId,
          },
          select: { id: true },
        });
        return { orderId: o.id, refundId: refund.id, providerRefundId, amount: row.subtotalCents };
      }

      /* ---- it succeeds ---- */
      const good = await pendingRefund("ok");
      const settled = await send(
        "refund.updated",
        refundObject(good.providerRefundId, "succeeded")
      );
      t.check(settled.status === 200, "a signed refund event is accepted", settled.status);
      t.check(settled.json.status === "SUCCEEDED", "and settles the row",
        JSON.stringify(settled.json));

      const goodRow = await prisma.refund.findUniqueOrThrow({
        where: { id: good.refundId },
        select: { status: true, completedAt: true },
      });
      t.check(goodRow.status === "SUCCEEDED", "the refund reads SUCCEEDED", goodRow.status);
      t.check(goodRow.completedAt !== null, "with a completion time");

      /* ---- delivered twice ---- */
      const twice = await send(
        "refund.updated",
        refundObject(good.providerRefundId, "succeeded")
      );
      t.check(twice.status === 200 && twice.json.ignored === "ALREADY_SETTLED",
        "a redelivery is ignored rather than applied again",
        JSON.stringify(twice.json));

      /* ---- it fails: the headroom must come back ---- */
      const bad = await pendingRefund("fail");
      const refused = await send(
        "refund.failed",
        refundObject(bad.providerRefundId, "failed", { failure_reason: "insufficient_funds" })
      );
      t.check(refused.status === 200 && refused.json.status === "FAILED",
        "a failed refund is applied", JSON.stringify(refused.json));

      const badRow = await prisma.refund.findUniqueOrThrow({
        where: { id: bad.refundId },
        select: { status: true, failureReason: true },
      });
      t.check(badRow.status === "FAILED", "the row reads FAILED", badRow.status);
      t.check(/insufficient_funds/.test(badRow.failureReason ?? ""),
        "with the provider's reason", badRow.failureReason);

      const unwound = await prisma.order.findUniqueOrThrow({
        where: { id: bad.orderId },
        select: { refundedCents: true, status: true },
      });
      t.check(unwound.refundedCents === 0,
        "the reserved headroom was given back, so a retry is possible",
        unwound.refundedCents);
      t.check(unwound.status === "PAID",
        "and the order is PAID again, not falsely REFUNDED", unwound.status);

      /* ---- still in flight ---- */
      const flight = await pendingRefund("pending");
      const pending = await send(
        "refund.updated",
        refundObject(flight.providerRefundId, "pending")
      );
      t.check(pending.status === 200 && pending.json.ignored === "STILL_PENDING",
        "a pending event decides nothing", JSON.stringify(pending.json));
      t.check(
        (await prisma.refund.findUniqueOrThrow({
          where: { id: flight.refundId },
          select: { status: true },
        })).status === "PENDING",
        "and leaves the row alone"
      );

      /* ---- a refund we have never heard of ---- */
      const alien = await send("refund.updated", refundObject("re_not_ours_at_all", "succeeded"));
      t.check(alien.status === 200 && alien.json.ignored === "NOT_FOUND",
        "an unknown refund is acknowledged, not retried forever",
        `${alien.status} ${JSON.stringify(alien.json)}`);

      /* ---- and the lock is still on the door ---- */
      const unsigned = await sendUnsigned(
        "refund.updated",
        refundObject(flight.providerRefundId, "succeeded")
      );
      t.check(unsigned.status === 400, "an unsigned refund event is refused", unsigned.status);

      const forged = await sendForged(
        "refund.updated",
        refundObject(flight.providerRefundId, "succeeded")
      );
      t.check(forged.status === 400, "and so is a forged signature", forged.status);
      t.check(
        (await prisma.refund.findUniqueOrThrow({
          where: { id: flight.refundId },
          select: { status: true },
        })).status === "PENDING",
        "neither of which moved anything"
      );
    }
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
