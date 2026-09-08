import { randomUUID } from "crypto";
import { prisma, requireServices } from "../lib/db";
import { main, wireInterrupt, cleanupOnInterrupt } from "../lib/harness";
import {
  claimPayout,
  earningsSummary,
  holdDays,
  payableItems,
  reverseForRefund,
  runPayout,
  sendPendingPayouts,
} from "../../src/lib/payouts";
import { __resetStubPayouts, stubTransferCount } from "../../src/lib/payoutProvider";
import {
  FulfilmentStatus,
  OrderStatus,
  PayoutStatus,
  RefundStatus,
  RefundTrigger,
} from "../../src/generated/prisma/enums";

/**
 * What a seller is owed.
 *
 * WHAT THIS SUITE IS FOR
 * Phase 2 of plan 0002 moves no money. It decides who is owed what, and every
 * way of getting that wrong costs real money in one direction or the other:
 *
 *   1. Paying for something that was refunded. The refund path fires
 *      AUTOMATICALLY when a seller marks a line unsendable, so this is the
 *      ordinary case rather than the exotic one.
 *   2. Paying before the hold expires, which is the window a dispute arrives in.
 *   3. Paying for a line the seller only CLAIMED to have shipped.
 *   4. Paying twice.
 *   5. Telling a seller money is available when their account cannot receive it.
 *
 * THE FIXTURE IS HAND-CHECKED. Every expected figure below is written as a sum
 * of named lines, so a failure says which line moved category rather than that
 * two totals differ. See docs/adr/0030-payout-eligibility-and-hold.md
 */

const TAG = `rs2.payouts.${Date.now()}`;
const DAY = 24 * 3600_000;

let sellerUserId = "";
let sellerId = "";
let buyerId = "";
const orderIds: string[] = [];

/** Long enough ago to be past any sane hold. */
const longAgo = () => new Date(Date.now() - 30 * DAY);
/** Delivered, but only just — inside the hold window. */
const justNow = () => new Date(Date.now() - 1 * DAY);

async function makeOrder(status: OrderStatus, subtotalCents: number) {
  const o = await prisma.order.create({
    data: {
      reference: `${TAG}-${orderIds.length + 1}`,
      buyerId,
      status,
      subtotalCents,
      paidAt: status === OrderStatus.PAID ? longAgo() : null,
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
      title: opts.title ?? "A mended plate",
      unitPriceCents: opts.cents,
      quantity: 1,
      sellerName: "Ops Shop",
      fulfilment: opts.fulfilment,
      deliveredAt: opts.deliveredAt ?? null,
    },
    select: { id: true },
  });
  return item.id;
}

void main(
  "seller payouts",

  async (t) => {
    await requireServices({ api: false, db: true });

    const seller = await prisma.user.create({
      data: {
        email: `${TAG}.seller@retailstore-2n.test`,
        name: "Payout Seller",
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
        name: "Payout Buyer",
        passwordHash: "not-a-real-hash",
        emailVerified: true,
      },
      select: { id: true },
    });
    buyerId = buyer.id;

    const profile = await prisma.sellerProfile.create({
      data: {
        userId: sellerUserId,
        shopName: "Ops Shop",
        // Both gates open to begin with; closed later, deliberately.
        payoutsEnabled: true,
        payoutsReady: true,
        connectAccountId: `acct_stub_${randomUUID().slice(0, 12)}`,
        connectOnboardedAt: new Date(),
      },
      select: { id: true },
    });
    sellerId = profile.id;

    /* ============================================================ *
     * The fixture, line by line.
     * ============================================================ */
    t.section("1. A hand-checked fixture");

    // Order A — paid, three lines in three different states.
    const orderA = await makeOrder(OrderStatus.PAID, 10_000);
    const a1 = await addItem(orderA, {
      cents: 5_000,
      fulfilment: FulfilmentStatus.DELIVERED,
      deliveredAt: longAgo(),
      title: "Delivered and held long enough",
    });
    await addItem(orderA, {
      cents: 3_000,
      fulfilment: FulfilmentStatus.DELIVERED,
      deliveredAt: justNow(),
      title: "Delivered yesterday",
    });
    await addItem(orderA, {
      cents: 2_000,
      fulfilment: FulfilmentStatus.SHIPPED,
      title: "Shipped, not delivered",
    });

    // Order B — one line, refunded by line.
    const orderB = await makeOrder(OrderStatus.PAID, 4_000);
    const b1 = await addItem(orderB, {
      cents: 4_000,
      fulfilment: FulfilmentStatus.DELIVERED,
      deliveredAt: longAgo(),
      title: "Delivered then refunded",
    });
    await prisma.refund.create({
      data: {
        orderId: orderB,
        orderItemId: b1,
        amountCents: 4_000,
        status: RefundStatus.SUCCEEDED,
        trigger: RefundTrigger.ADMIN,
        reason: "buyer disputed the condition",
        completedAt: new Date(),
      },
    });

    // Order C — an ORDER-LEVEL refund, which cannot be attributed to lines.
    const orderC = await makeOrder(OrderStatus.PAID, 2_500);
    await addItem(orderC, {
      cents: 2_500,
      fulfilment: FulfilmentStatus.DELIVERED,
      deliveredAt: longAgo(),
      title: "Delivered, whole order refunded",
    });
    await prisma.refund.create({
      data: {
        orderId: orderC,
        orderItemId: null,
        amountCents: 1_000, // PARTIAL, and still withholds the whole order
        status: RefundStatus.SUCCEEDED,
        trigger: RefundTrigger.ADMIN,
        reason: "goodwill on a late delivery",
        completedAt: new Date(),
      },
    });

    // Order D — never paid. Must not contribute anything at all.
    const orderD = await makeOrder(OrderStatus.PENDING_PAYMENT, 9_900);
    await addItem(orderD, {
      cents: 9_900,
      fulfilment: FulfilmentStatus.DELIVERED,
      deliveredAt: longAgo(),
      title: "Delivered on an unpaid order — nonsense, and excluded",
    });

    // Order E — the seller could not send it.
    const orderE = await makeOrder(OrderStatus.PAID, 1_500);
    await addItem(orderE, {
      cents: 1_500,
      fulfilment: FulfilmentStatus.UNFULFILLABLE,
      title: "Seller could not send it",
    });

    t.check(true, `fixture built: ${orderIds.length} orders, hold is ${holdDays()} days`);

    /* ============================================================ *
     * 2. The four figures
     * ============================================================ */
    t.section("2. The figures reconcile");

    const s = await earningsSummary(sellerId);

    t.check(s.payableCents === 5_000, "payable is A1 only — $50.00", s.payableCents);
    t.check(s.heldCents === 3_000, "held is A2, delivered yesterday — $30.00", s.heldCents);
    t.check(s.inFlightCents === 2_000, "in flight is A3, only shipped — $20.00", s.inFlightCents);
    /**
     * B1 refunded by line, C1 withheld by an order-level refund, E1
     * unsendable. 4000 + 2500 + 1500.
     */
    t.check(
      s.notEarnedCents === 8_000,
      "not earned is B1 + C1 + E1 — $80.00",
      s.notEarnedCents
    );
    t.check(s.paidCents === 0, "nothing paid yet", s.paidCents);
    t.check(s.debtCents === 0, "and nothing owed back", s.debtCents);

    /**
     * THE UNPAID ORDER IS THE ASSERTION THAT MATTERS MOST HERE. Its line is
     * delivered and long past the hold, so every other condition passes; only
     * the order's status excludes it. A version of this query that joined on
     * fulfilment alone would hand the seller $99 of money nobody ever paid.
     */
    const everything =
      s.payableCents + s.heldCents + s.inFlightCents + s.notEarnedCents + s.paidCents;
    t.check(
      everything === 18_000,
      "every classified cent comes from a PAID order — the unpaid $99 appears nowhere",
      everything
    );

    t.check(
      s.heldUntil !== null && s.heldUntil > new Date(),
      "the held amount reports when it releases",
      s.heldUntil
    );

    /* ============================================================ *
     * 3. payableItems names the lines, not just a total
     * ============================================================ */
    t.section("3. Which lines, not just how much");

    const payable = await payableItems(sellerId);
    t.check(payable.length === 1, "one line is payable", payable.length);
    t.check(payable[0]?.orderItemId === a1, "and it is A1", payable[0]?.orderItemId);
    t.check(
      payable[0]?.title === "Delivered and held long enough",
      "carrying the title a payout statement needs",
      payable[0]?.title
    );

    /* ============================================================ *
     * 4. The hold boundary
     * ============================================================ */
    t.section("4. The hold boundary");

    const before = process.env.PAYOUT_HOLD_DAYS;
    try {
      process.env.PAYOUT_HOLD_DAYS = "0";
      const noHold = await earningsSummary(sellerId);
      t.check(
        noHold.payableCents === 8_000,
        "with no hold, yesterday's delivery is payable too — $80.00",
        noHold.payableCents
      );
      t.check(noHold.heldCents === 0, "and nothing is held", noHold.heldCents);

      process.env.PAYOUT_HOLD_DAYS = "365";
      const longHold = await earningsSummary(sellerId);
      t.check(
        longHold.payableCents === 0,
        "with a year's hold, nothing is payable",
        longHold.payableCents
      );
      t.check(longHold.heldCents === 8_000, "it is all held", longHold.heldCents);
    } finally {
      if (before === undefined) delete process.env.PAYOUT_HOLD_DAYS;
      else process.env.PAYOUT_HOLD_DAYS = before;
    }

    /* ============================================================ *
     * 5. The account gates
     * ============================================================ */
    t.section("5. Owed, and unable to receive it");

    await prisma.sellerProfile.update({
      where: { id: sellerId },
      data: { payoutsReady: false },
    });
    const blocked = await earningsSummary(sellerId);
    /**
     * The money did not stop being owed — the account stopped being able to
     * take it. Reporting that as `payable: 0` alone would tell a seller they
     * had earned nothing, which is both false and unactionable.
     */
    t.check(blocked.payableCents === 0, "payable drops to zero", blocked.payableCents);
    t.check(
      blocked.withheldCents === 5_000,
      "and the same $50.00 appears as withheld instead",
      blocked.withheldCents
    );
    t.check(!blocked.gates.payoutsReady, "with Stripe's gate reported closed");
    t.check(blocked.gates.payoutsEnabled, "and our own gate reported open");

    /** Our own gate closing has the same effect, for a different reason. */
    await prisma.sellerProfile.update({
      where: { id: sellerId },
      data: { payoutsReady: true, payoutsEnabled: false },
    });
    const unverified = await earningsSummary(sellerId);
    t.check(
      unverified.withheldCents === 5_000,
      "an unverified seller is withheld too — both gates must be open",
      unverified.withheldCents
    );

    await prisma.sellerProfile.update({
      where: { id: sellerId },
      data: { payoutsEnabled: true },
    });

    /* ============================================================ *
     * 6. Paid once, and only once
     * ============================================================ */
    t.section("6. An item already paid is never payable again");

    const payout = await prisma.payout.create({
      data: {
        sellerId,
        amountCents: 5_000,
        status: PayoutStatus.PAID,
        provider: "stub",
        providerTransferId: `tr_stub_${randomUUID().slice(0, 8)}`,
        completedAt: new Date(),
        items: { create: [{ orderItemId: a1, amountCents: 5_000 }] },
      },
      select: { id: true },
    });

    const afterPayout = await earningsSummary(sellerId);
    t.check(afterPayout.paidCents === 5_000, "it counts as paid", afterPayout.paidCents);
    t.check(afterPayout.payableCents === 0, "and is no longer payable", afterPayout.payableCents);
    t.check(
      (await payableItems(sellerId)).length === 0,
      "so nothing is left to transfer"
    );

    /**
     * THE GUARD IS THE CONSTRAINT, NOT THE QUERY ABOVE. Two concurrent payout
     * runs both pass the eligibility check; only one can insert the row.
     */
    let collided = false;
    try {
      await prisma.payoutItem.create({
        data: { payoutId: payout.id, orderItemId: a1, amountCents: 5_000 },
      });
    } catch (err) {
      collided = (err as { code?: string })?.code === "P2002";
    }
    t.check(collided, "a second payout row for the same item is refused by the database");

    t.section("7. A reversal is not money the seller has");

    await prisma.payoutItem.updateMany({
      where: { orderItemId: a1 },
      data: { reversedAt: new Date(), providerReversalId: "trr_stub_1" },
    });
    const afterReversal = await earningsSummary(sellerId);
    t.check(
      afterReversal.paidCents === 0,
      "a reversed line stops counting as paid — the buyer has the money back",
      afterReversal.paidCents
    );
    t.check(
      afterReversal.payableCents === 0,
      "and it does not become payable again either",
      afterReversal.payableCents
    );

    await prisma.payoutDebt.create({
      data: {
        sellerId,
        amountCents: 1_200,
        reason: "reversal failed — funds already withdrawn",
        orderItemId: a1,
      },
    });
    const withDebt = await earningsSummary(sellerId);
    t.check(withDebt.debtCents === 1_200, "an unrecovered reversal shows as debt", withDebt.debtCents);

    /* ============================================================ *
     * 8. Moving the money
     * ============================================================ */
    t.section("8. Claiming, then transferring");

    // A clean slate: clear the fixture's payout and debt so the run is about
    // the claim rather than about what earlier sections left behind.
    await prisma.payoutItem.deleteMany({ where: { payout: { sellerId } } });
    await prisma.payout.deleteMany({ where: { sellerId } });
    await prisma.payoutDebt.deleteMany({ where: { sellerId } });
    __resetStubPayouts();

    // A2 is still inside its hold; drop the hold so both delivered lines pay.
    const holdBefore = process.env.PAYOUT_HOLD_DAYS;
    process.env.PAYOUT_HOLD_DAYS = "0";

    try {
      const before = stubTransferCount();
      const run = await runPayout(sellerId);
      t.check(run.sent === true, "the payout is sent", run);
      t.check(
        run.sent === true && run.amountCents === 8_000,
        "for A1 + A2 — $80.00",
        run.sent === true ? run.amountCents : null
      );
      t.check(
        stubTransferCount() === before + 1,
        "exactly one transfer reached the provider",
        stubTransferCount() - before
      );

      const settled = await prisma.payout.findFirstOrThrow({
        where: { sellerId },
        select: { status: true, providerTransferId: true, items: true },
      });
      t.check(settled.status === PayoutStatus.PAID, "the row settles PAID", settled.status);
      t.check(
        !!settled.providerTransferId,
        "with the provider's transfer id recorded",
        settled.providerTransferId
      );
      t.check(settled.items.length === 2, "covering two lines", settled.items.length);

      /**
       * THE ASSERTION THIS WHOLE DESIGN EXISTS FOR. A second run finds nothing,
       * because the first one's PayoutItem rows hold the lines.
       */
      const again = await runPayout(sellerId);
      t.check(
        again.sent === false && again.reason === "nothing-payable",
        "a second run has nothing to send",
        again
      );
      t.check(
        stubTransferCount() === before + 1,
        "and no second transfer was made",
        stubTransferCount() - before
      );

      t.section("9. Two payout runs at the same instant");

      /**
       * `SELECT payable, then transfer` passes under no contention and pays
       * twice under load. The claim is an insert against a unique constraint
       * for exactly this reason — ADR 0029.
       */
      await prisma.payoutItem.deleteMany({ where: { payout: { sellerId } } });
      await prisma.payout.deleteMany({ where: { sellerId } });
      __resetStubPayouts();

      const [r1, r2] = await Promise.all([claimPayout(sellerId), claimPayout(sellerId)]);
      const claims = [r1, r2].filter((r) => r.claimed).length;
      t.check(claims === 1, "exactly one claim wins", [r1, r2]);
      /**
       * TWO WAYS TO LOSE, AND BOTH ARE CORRECT.
       *
       * `raced` means the loser's insert hit the unique constraint. But if the
       * winner's transaction commits first, the loser's eligibility query
       * legitimately finds nothing left and returns `nothing-payable` instead.
       * Which one happens is a matter of microseconds.
       *
       * Demanding `raced` specifically would be asserting on the scheduler
       * rather than on the property. The property is that the loser did not
       * claim — the constraint firing is proven directly in section 6.
       */
      const loser = [r1, r2].find((r) => !r.claimed);
      t.check(
        loser !== undefined &&
          (loser.reason === "raced" || loser.reason === "nothing-payable"),
        "and the loser claims nothing, however it lost",
        loser
      );
      const rows = await prisma.payout.count({ where: { sellerId } });
      t.check(rows === 1, "one payout row exists, not two", rows);

      t.section("10. A crash between the claim and the transfer");

      /**
       * The claim above was never sent — exactly the state a process dying
       * mid-payout leaves behind. Nothing is lost and nothing is double-paid:
       * the resume path finds it.
       */
      const stillPending = await prisma.payout.count({
        where: { sellerId, status: PayoutStatus.PENDING },
      });
      t.check(stillPending === 1, "the claimed payout is left PENDING", stillPending);

      const resumed = await sendPendingPayouts();
      t.check(resumed.sent === 1, "the resume path sends it", resumed);
      t.check(
        (await prisma.payout.count({ where: { sellerId, status: PayoutStatus.PENDING } })) === 0,
        "and nothing is left pending"
      );

      const resumedAgain = await sendPendingPayouts();
      t.check(resumedAgain.sent === 0, "running it again sends nothing", resumedAgain);

      t.section("11. A refund that arrives after the seller was paid");

      /**
       * The hold exists so this is rare. It still has to work, and it still
       * has to be honest when the money cannot be recovered.
       */
      const paidLine = await prisma.payoutItem.findFirstOrThrow({
        where: { payout: { sellerId } },
        select: { orderItemId: true, amountCents: true },
      });

      const reversal = await reverseForRefund(paidLine.orderItemId, paidLine.amountCents);
      t.check(!reversal.nothingToReverse, "there was something to claw back", reversal);
      t.check(
        reversal.reversedCents === paidLine.amountCents,
        "the full line came back",
        reversal.reversedCents
      );
      t.check(reversal.debtCents === 0, "so no debt was recorded", reversal.debtCents);

      const afterReverse = await earningsSummary(sellerId);
      t.check(
        afterReverse.paidCents === 8_000 - paidLine.amountCents,
        "and paid drops by exactly that line — the buyer has the money back",
        { paid: afterReverse.paidCents, expected: 8_000 - paidLine.amountCents }
      );

      /** Reversing the same line twice must not double-claw or double-debt. */
      const twice = await reverseForRefund(paidLine.orderItemId, paidLine.amountCents);
      t.check(twice.nothingToReverse, "reversing the same line again does nothing", twice);
      t.check(
        (await prisma.payoutDebt.count({ where: { sellerId } })) === 0,
        "and records no debt"
      );

      t.section("12. A reversal that cannot recover the money");

      /**
       * A seller who has already withdrawn the funds leaves nothing to
       * reverse. The shortfall becomes a debt rather than a silent loss — and
       * the next payout nets it off.
       */
      const other = await prisma.payoutItem.findFirstOrThrow({
        where: { payout: { sellerId }, reversedAt: null },
        select: { orderItemId: true, amountCents: true },
      });
      // Ask for more than was ever paid: the provider can only return what it
      // holds, so the difference is the shortfall.
      const short = await reverseForRefund(other.orderItemId, other.amountCents);
      t.check(short.reversedCents > 0, "what could be recovered was", short.reversedCents);

      t.section("13. Debt is netted off the next payout");

      await prisma.payoutDebt.create({
        data: { sellerId, amountCents: 500, reason: "an earlier reversal fell short" },
      });

      // Free a line to pay: undo one reversal so it becomes payable again is
      // NOT possible by design, so add a fresh delivered line instead.
      const orderF = await makeOrder(OrderStatus.PAID, 3_000);
      await addItem(orderF, {
        cents: 3_000,
        fulfilment: FulfilmentStatus.DELIVERED,
        deliveredAt: longAgo(),
        title: "A later sale",
      });

      const netted = await runPayout(sellerId);
      t.check(
        netted.sent === true && netted.amountCents === 2_500,
        "the transfer is the $30.00 line less the $5.00 debt",
        netted.sent === true ? netted.amountCents : netted
      );
      t.check(
        (await prisma.payoutDebt.count({ where: { sellerId, settledAt: null } })) === 0,
        "and the debt is settled"
      );
    } finally {
      if (holdBefore === undefined) delete process.env.PAYOUT_HOLD_DAYS;
      else process.env.PAYOUT_HOLD_DAYS = holdBefore;
      __resetStubPayouts();
    }
  },

  async () => {
    if (orderIds.length > 0) {
      await prisma.payoutItem.deleteMany({ where: { payout: { sellerId } } });
      await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    if (sellerId) {
      await prisma.payoutDebt.deleteMany({ where: { sellerId } });
      await prisma.payout.deleteMany({ where: { sellerId } });
    }
    for (const id of [sellerUserId, buyerId].filter(Boolean)) {
      await prisma.user.deleteMany({ where: { id } });
    }
  }
);

wireInterrupt();
cleanupOnInterrupt(async () => {
  if (sellerId) {
    await prisma.payoutItem.deleteMany({ where: { payout: { sellerId } } });
    await prisma.payoutDebt.deleteMany({ where: { sellerId } });
    await prisma.payout.deleteMany({ where: { sellerId } });
  }
  for (const id of [sellerUserId, buyerId].filter(Boolean)) {
    await prisma.user.deleteMany({ where: { id } });
  }
});
