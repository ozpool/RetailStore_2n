import { randomUUID } from "crypto";
import { prisma, requireServices } from "../lib/db";
import { main, wireInterrupt, cleanupOnInterrupt } from "../lib/harness";
import {
  approveReturn,
  eligibility,
  escalateReturn,
  openReturn,
  refuseReturn,
  returnWindowDays,
  returnsForBuyer,
  returnsForSeller,
  withdrawReturn,
} from "../../src/lib/returns";
import {
  FulfilmentStatus,
  OrderStatus,
  RefundStatus,
  RefundTrigger,
  ReturnStatus,
} from "../../src/generated/prisma/enums";

/**
 * A buyer asking for their money back.
 *
 * WHAT THIS SUITE IS FOR
 * Until this existed a buyer had no route to a refund at all, while the footer
 * of every page promised them one. The eligibility rules are where that promise
 * either becomes true or becomes a way to take money out of the platform, and
 * every one of them fails expensively in a different direction:
 *
 *   1. Returning something that was never paid for — money nobody handed over.
 *   2. Returning something the seller never delivered.
 *   3. Returning something already refunded, which pays for it twice.
 *   4. Two requests on one line, answered separately.
 *   5. Two people answering one request, both winning.
 *
 * THE FIXTURE IS HAND-CHECKED. Every line is created for one purpose and named
 * for it, so a failure says which condition moved rather than that two numbers
 * disagree. See docs/adr/0031-buyer-initiated-returns.md
 */

const TAG = `rs2.returns.${Date.now()}`;
const DAY = 24 * 3600_000;

let buyerId = "";
let otherBuyerId = "";
let sellerUserId = "";
let sellerId = "";
const orderIds: string[] = [];

async function makeOrder(status: OrderStatus, subtotalCents: number, buyer = buyerId) {
  const o = await prisma.order.create({
    data: {
      reference: `${TAG}-${orderIds.length + 1}`,
      buyerId: buyer,
      status,
      subtotalCents,
      paidAt: status === OrderStatus.PAID ? new Date(Date.now() - 30 * DAY) : null,
    },
    select: { id: true },
  });
  orderIds.push(o.id);
  return o.id;
}

async function addItem(
  orderId: string,
  opts: {
    cents: number;
    fulfilment: FulfilmentStatus;
    deliveredAt?: Date | null;
    title?: string;
  }
) {
  const item = await prisma.orderItem.create({
    data: {
      orderId,
      sellerId,
      title: opts.title ?? "A returned plate",
      unitPriceCents: opts.cents,
      quantity: 1,
      sellerName: "Returns Shop",
      fulfilment: opts.fulfilment,
      deliveredAt: opts.deliveredAt ?? null,
    },
    select: { id: true },
  });
  return item.id;
}

/** Delivered just now, so comfortably inside any window. */
const justDelivered = () => new Date(Date.now() - 1 * 3600_000);

void main(
  "buyer returns",

  async (t) => {
    await requireServices({ api: false, db: true });

    const seller = await prisma.user.create({
      data: {
        email: `${TAG}.seller@retailstore-2n.test`,
        name: "Returns Seller",
        passwordHash: "not-a-real-hash",
        emailVerified: true,
        isSeller: true,
      },
      select: { id: true },
    });
    sellerUserId = seller.id;

    const buyer = await prisma.user.create({
      data: {
        email: `${TAG}.buyer@retailstore-2n.test`,
        name: "Returns Buyer",
        passwordHash: "not-a-real-hash",
        emailVerified: true,
      },
      select: { id: true },
    });
    buyerId = buyer.id;

    const other = await prisma.user.create({
      data: {
        email: `${TAG}.other@retailstore-2n.test`,
        name: "Someone Else",
        passwordHash: "not-a-real-hash",
        emailVerified: true,
      },
      select: { id: true },
    });
    otherBuyerId = other.id;

    const profile = await prisma.sellerProfile.create({
      data: { userId: sellerUserId, shopName: "Returns Shop" },
      select: { id: true },
    });
    sellerId = profile.id;

    /* ============================================================ *
     * 1. The window derives from the payout hold.
     * ============================================================ */
    t.section("1. the window is the payout hold unless told otherwise");

    const windowBefore = process.env.RETURN_WINDOW_DAYS;
    const holdBefore = process.env.PAYOUT_HOLD_DAYS;
    try {
      delete process.env.RETURN_WINDOW_DAYS;
      process.env.PAYOUT_HOLD_DAYS = "9";
      t.check(returnWindowDays() === 9,
        "with no window set, it IS the hold — so a return can never land on money already sent",
        returnWindowDays());

      process.env.RETURN_WINDOW_DAYS = "14";
      t.check(returnWindowDays() === 14, "an explicit window overrides it",
        returnWindowDays());

      process.env.RETURN_WINDOW_DAYS = "not a number";
      t.check(returnWindowDays() === 9, "nonsense falls back to the hold rather than to zero",
        returnWindowDays());

      // Read per call, not captured at import — the bug this codebase has hit
      // four times over.
      process.env.RETURN_WINDOW_DAYS = "3";
      t.check(returnWindowDays() === 3, "and it is read per call, not frozen at import",
        returnWindowDays());
    } finally {
      if (windowBefore === undefined) delete process.env.RETURN_WINDOW_DAYS;
      else process.env.RETURN_WINDOW_DAYS = windowBefore;
      if (holdBefore === undefined) delete process.env.PAYOUT_HOLD_DAYS;
      else process.env.PAYOUT_HOLD_DAYS = holdBefore;
    }

    /* ============================================================ *
     * 2. The five conditions, each on its own.
     * ============================================================ */
    t.section("2. what makes a line returnable");

    // The one that matters most: everything else about this line passes.
    const unpaidOrder = await makeOrder(OrderStatus.PENDING_PAYMENT, 9_900);
    const unpaidLine = await addItem(unpaidOrder, {
      cents: 9_900,
      fulfilment: FulfilmentStatus.DELIVERED,
      deliveredAt: justDelivered(),
      title: "Delivered on an order nobody paid",
    });
    const unpaid = await eligibility(buyerId, unpaidLine);
    t.check(!unpaid.eligible && unpaid.reason === "order-not-paid",
      "an unpaid order is refused even though the line is delivered and in window",
      unpaid.eligible ? "eligible" : unpaid.reason);

    const paidOrder = await makeOrder(OrderStatus.PAID, 20_000);

    const shippedLine = await addItem(paidOrder, {
      cents: 4_000,
      fulfilment: FulfilmentStatus.SHIPPED,
      title: "Shipped, not delivered",
    });
    const shipped = await eligibility(buyerId, shippedLine);
    t.check(!shipped.eligible && shipped.reason === "not-delivered",
      "a line the seller only says they posted is not returnable",
      shipped.eligible ? "eligible" : shipped.reason);

    const staleLine = await addItem(paidOrder, {
      cents: 5_000,
      fulfilment: FulfilmentStatus.DELIVERED,
      deliveredAt: new Date(Date.now() - 400 * DAY),
      title: "Delivered over a year ago",
    });
    const stale = await eligibility(buyerId, staleLine);
    t.check(!stale.eligible && stale.reason === "window-closed",
      "past the window it is refused, with the date it closed",
      stale.eligible ? "eligible" : `${stale.reason} ${stale.deadline?.toISOString()}`);
    t.check(!stale.eligible && stale.deadline instanceof Date,
      "and the deadline is returned so the buyer can be told when it was");

    const goodLine = await addItem(paidOrder, {
      cents: 8_000,
      fulfilment: FulfilmentStatus.DELIVERED,
      deliveredAt: justDelivered(),
      title: "Delivered yesterday and returnable",
    });
    const good = await eligibility(buyerId, goodLine);
    t.check(good.eligible === true, "a paid, delivered, in-window line is returnable",
      good.eligible ? "yes" : good.reason);
    t.check(good.eligible && good.amountCents === 8_000, "at the line's own price",
      good.eligible ? good.amountCents : null);

    /* ---- somebody else's order is not visible, let alone returnable ---- */
    const notTheirs = await eligibility(otherBuyerId, goodLine);
    t.check(!notTheirs.eligible && notTheirs.reason === "not-your-order",
      "another buyer cannot return it",
      notTheirs.eligible ? "eligible" : notTheirs.reason);

    const missing = await eligibility(buyerId, randomUUID());
    t.check(!missing.eligible && missing.reason === "no-such-item",
      "and an id that does not exist is not an error",
      missing.eligible ? "eligible" : missing.reason);

    /* ---- already refunded ---- */
    const refundedLine = await addItem(paidOrder, {
      cents: 3_000,
      fulfilment: FulfilmentStatus.DELIVERED,
      deliveredAt: justDelivered(),
      title: "Delivered then refunded",
    });
    await prisma.refund.create({
      data: {
        orderId: paidOrder,
        orderItemId: refundedLine,
        amountCents: 3_000,
        status: RefundStatus.SUCCEEDED,
        trigger: RefundTrigger.ADMIN,
        reason: "already given back",
      },
    });
    const already = await eligibility(buyerId, refundedLine);
    t.check(!already.eligible && already.reason === "already-refunded",
      "a line already refunded cannot be returned for a second refund",
      already.eligible ? "eligible" : already.reason);

    /**
     * A PENDING refund counts too. The money may not have left the provider
     * yet, but a refund in flight is not a reason to allow a second request.
     */
    const inFlightLine = await addItem(paidOrder, {
      cents: 2_500,
      fulfilment: FulfilmentStatus.DELIVERED,
      deliveredAt: justDelivered(),
      title: "Refund still in flight",
    });
    await prisma.refund.create({
      data: {
        orderId: paidOrder,
        orderItemId: inFlightLine,
        amountCents: 2_500,
        status: RefundStatus.PENDING,
        trigger: RefundTrigger.ADMIN,
        reason: "in flight",
      },
    });
    const inFlight = await eligibility(buyerId, inFlightLine);
    t.check(!inFlight.eligible && inFlight.reason === "already-refunded",
      "and a refund still in flight blocks it too",
      inFlight.eligible ? "eligible" : inFlight.reason);

    /* ============================================================ *
     * 3. Opening one. The insert is the claim.
     * ============================================================ */
    t.section("3. opening a request");

    const opened = await openReturn({
      buyerId,
      orderItemId: goodLine,
      reason: "The glaze is cracked right through and the photos didn't show it.",
      notAsDescribed: true,
    });
    t.check(opened.opened === true, "the request opens",
      opened.opened ? opened.id : opened.reason);
    const requestId = opened.opened ? opened.id : "";

    const twice = await openReturn({
      buyerId,
      orderItemId: goodLine,
      reason: "asking again",
      notAsDescribed: false,
    });
    t.check(!twice.opened && twice.reason === "already-requested",
      "asking twice is refused",
      twice.opened ? "opened" : twice.reason);

    t.check((await prisma.returnRequest.count({ where: { orderItemId: goodLine } })) === 1,
      "and exactly one request exists for the line");

    /**
     * THE RACE. Both attempts read the same eligible line and both try to
     * insert; `return_requests.orderItemId @unique` is what makes the second
     * lose rather than opening a rival request that gets answered separately.
     */
    const raceLine = await addItem(paidOrder, {
      cents: 1_800,
      fulfilment: FulfilmentStatus.DELIVERED,
      deliveredAt: justDelivered(),
      title: "Two taps on Start a return",
    });
    const raced = await Promise.all(
      Array.from({ length: 6 }, () =>
        openReturn({
          buyerId,
          orderItemId: raceLine,
          reason: "double tapped the button",
          notAsDescribed: false,
        })
      )
    );
    const won = raced.filter((r) => r.opened).length;
    t.check(won === 1, "six simultaneous attempts open exactly one request", won);
    t.check((await prisma.returnRequest.count({ where: { orderItemId: raceLine } })) === 1,
      "and the database holds one row for that line");

    /* ============================================================ *
     * 4. The buyer's own moves.
     * ============================================================ */
    t.section("4. withdrawing and escalating");

    const notYours = await withdrawReturn(otherBuyerId, requestId);
    t.check(!notYours.done && notYours.reason === "not-yours",
      "another buyer cannot withdraw it",
      notYours.done ? "done" : notYours.reason);

    const raceRequest = await prisma.returnRequest.findFirstOrThrow({
      where: { orderItemId: raceLine },
      select: { id: true },
    });
    const withdrawn = await withdrawReturn(buyerId, raceRequest.id);
    t.check(withdrawn.done && withdrawn.status === ReturnStatus.WITHDRAWN,
      "the buyer can withdraw one nobody has answered",
      withdrawn.done ? withdrawn.status : withdrawn.reason);

    const withdrawTwice = await withdrawReturn(buyerId, raceRequest.id);
    t.check(!withdrawTwice.done && withdrawTwice.reason === "wrong-state",
      "and withdrawing twice does nothing",
      withdrawTwice.done ? "done" : withdrawTwice.reason);

    const cannotEscalateOpen = await escalateReturn(buyerId, requestId);
    t.check(!cannotEscalateOpen.done && cannotEscalateOpen.reason === "wrong-state",
      "escalating before the seller has answered is refused — this is not a way past them",
      cannotEscalateOpen.done ? "done" : cannotEscalateOpen.reason);

    /* ============================================================ *
     * 5. Refusing needs a reason.
     * ============================================================ */
    t.section("5. answering no");

    const silent = await refuseReturn({ id: requestId, decidedById: sellerUserId, note: "  " });
    t.check(!silent.done && silent.reason === "note-required",
      "a refusal with no stated reason is rejected — the buyer needs it to decide whether to escalate",
      silent.done ? "done" : silent.reason);

    const refused = await refuseReturn({
      id: requestId,
      decidedById: sellerUserId,
      note: "Photos showed the crack; it was described as repaired.",
    });
    t.check(refused.done && refused.status === ReturnStatus.REFUSED, "the seller can refuse",
      refused.done ? refused.status : refused.reason);

    const escalated = await escalateReturn(buyerId, requestId);
    t.check(escalated.done && escalated.status === ReturnStatus.ESCALATED,
      "and a refusal can then be escalated",
      escalated.done ? escalated.status : escalated.reason);

    /**
     * The seller cannot answer an escalated request — it is with a moderator
     * now. `allowEscalated` is the admin path's flag, and the seller path does
     * not set it.
     */
    const sellerReachingIn = await approveReturn({
      id: requestId,
      decidedById: sellerUserId,
    });
    t.check(!sellerReachingIn.done && sellerReachingIn.reason === "wrong-state",
      "the seller cannot approve one that has gone to a moderator",
      sellerReachingIn.done ? "done" : sellerReachingIn.reason);

    /* ============================================================ *
     * 6. Two people answering at once.
     * ============================================================ */
    t.section("6. one answer wins");

    const raceAnswerLine = await addItem(paidOrder, {
      cents: 1_200,
      fulfilment: FulfilmentStatus.DELIVERED,
      deliveredAt: justDelivered(),
      title: "Answered by two people at once",
    });
    const contested = await openReturn({
      buyerId,
      orderItemId: raceAnswerLine,
      reason: "arrived chipped",
      notAsDescribed: true,
    });
    const contestedId = contested.opened ? contested.id : "";

    /**
     * Six refusals at once. Each is a conditional UPDATE filtered on OPEN, so
     * the first moves the row and the rest match zero rows. A plain
     * `update({ where: { id } })` would let all six write, and the last note to
     * land would be the one the buyer saw — a different person's words than the
     * decision that was actually recorded first.
     */
    const answers = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        refuseReturn({
          id: contestedId,
          decidedById: sellerUserId,
          note: `refusal number ${i} of six`,
        })
      )
    );
    const accepted = answers.filter((a) => a.done).length;
    t.check(accepted === 1, "six simultaneous refusals produce exactly one answer", accepted);

    const settled = await prisma.returnRequest.findUniqueOrThrow({
      where: { id: contestedId },
      select: { status: true, decisionNote: true },
    });
    t.check(settled.status === ReturnStatus.REFUSED, "and the request is refused once",
      settled.status);
    t.check(/refusal number \d of six/.test(settled.decisionNote ?? ""),
      "with exactly one of the six notes on it", settled.decisionNote);

    /* ============================================================ *
     * 7. An approval whose refund fails must not stay approved.
     * ============================================================ */
    t.section("7. a failed refund reverts the approval");

    /**
     * WHY THIS IS THE MOST IMPORTANT SECTION HERE.
     *
     * Approval is two steps that can fail between: claim the request, then move
     * the money. If the claim survives a failed refund, the request reads
     * APPROVED with no refund attached — the buyer is told their money is
     * coming and nothing is owed to anyone. That is the worst outcome
     * available, and worse than the request simply staying open.
     *
     * Forced here by approving against an order that has no payment intent, so
     * `issueRefund` throws before anything moves. A real deployment reaches the
     * same state when the provider refuses or times out.
     */
    const brokenOrder = await makeOrder(OrderStatus.PAID, 6_000);
    await prisma.order.update({
      where: { id: brokenOrder },
      data: { paymentIntentId: null },
    });
    const brokenLine = await addItem(brokenOrder, {
      cents: 6_000,
      fulfilment: FulfilmentStatus.DELIVERED,
      deliveredAt: justDelivered(),
      title: "On an order with no payment attached",
    });
    const brokenReq = await openReturn({
      buyerId,
      orderItemId: brokenLine,
      reason: "the handle snapped off in the post",
      notAsDescribed: true,
    });
    const brokenId = brokenReq.opened ? brokenReq.id : "";
    t.check(brokenReq.opened === true, "a request opens against it",
      brokenReq.opened ? "yes" : brokenReq.reason);

    const failed = await approveReturn({ id: brokenId, decidedById: sellerUserId });
    t.check(!failed.done && failed.reason === "refund-failed",
      "approving it reports the refund failure rather than claiming success",
      failed.done ? "done" : failed.reason);

    const reverted = await prisma.returnRequest.findUniqueOrThrow({
      where: { id: brokenId },
      select: { status: true, refundId: true, decidedById: true, decidedAt: true },
    });
    t.check(reverted.status === ReturnStatus.OPEN,
      "and the request is back to OPEN, not left APPROVED with no money behind it",
      reverted.status);
    t.check(reverted.refundId === null, "with no refund attached", reverted.refundId);
    t.check(reverted.decidedById === null && reverted.decidedAt === null,
      "and no decision recorded, so it is genuinely answerable again",
      `${reverted.decidedById} / ${reverted.decidedAt}`);

    t.check((await prisma.refund.count({ where: { orderId: brokenOrder } })) === 0,
      "no refund row was left behind either");

    /* ---- and it can be answered afterwards ---- */
    const answeredAfter = await refuseReturn({
      id: brokenId,
      decidedById: sellerUserId,
      note: "Sending a replacement instead.",
    });
    t.check(answeredAfter.done === true, "a reverted request can still be answered",
      answeredAfter.done ? answeredAfter.status : answeredAfter.reason);

    /* ============================================================ *
     * 8. The queues.
     * ============================================================ */
    t.section("8. reading them back");

    const mine = await returnsForBuyer(buyerId);
    t.check(mine.length >= 4, "the buyer sees their own requests", mine.length);
    t.check(mine.every((r) => typeof r.title === "string" && r.title.length > 0),
      "each carrying the item's name, so a list is readable without a join");
    t.check(mine.every((r) => r.orderReference !== null),
      "and the order reference they would quote in an email");

    const theirs = await returnsForBuyer(otherBuyerId);
    t.check(theirs.length === 0, "another buyer sees none of them", theirs.length);

    const queue = await returnsForSeller(sellerId);
    t.check(queue.length >= 4, "the seller sees requests against their own lines",
      queue.length);
    const openQueue = await returnsForSeller(sellerId, true);
    t.check(openQueue.every((r) => r.status === ReturnStatus.OPEN),
      "and can ask for only the ones still needing an answer",
      openQueue.map((r) => r.status).join(","));
  },

  async () => {
    if (orderIds.length > 0) {
      await prisma.returnRequest.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    for (const id of [sellerUserId, buyerId, otherBuyerId].filter(Boolean)) {
      await prisma.user.deleteMany({ where: { id } });
    }
  }
);

wireInterrupt();
cleanupOnInterrupt(async () => {
  if (orderIds.length > 0) {
    await prisma.returnRequest.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  for (const id of [sellerUserId, buyerId, otherBuyerId].filter(Boolean)) {
    await prisma.user.deleteMany({ where: { id } });
  }
});
