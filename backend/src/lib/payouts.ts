import { prisma } from "./prisma";
import { PayoutError, isStubPayouts, reverseTransfer, transfer } from "./payoutProvider";
import { OrderStatus, PayoutStatus, RefundStatus, FulfilmentStatus } from "../generated/prisma/enums";

/**
 * What a seller is owed, and what they are not.
 *
 * NO MONEY MOVES IN THIS FILE. It is the query that decides eligibility, and it
 * is deliberately separate from lib/payoutProvider.ts: an adapter that both
 * talks to Stripe and decides who gets paid is one where changing provider can
 * quietly change the rules.
 *
 * THE FIVE CONDITIONS, from docs/adr/0030-payout-eligibility-and-hold.md. An
 * order item is payable when ALL of these hold, and each one is here because
 * the others are not sufficient:
 *
 *   1. the order is PAID              — an unpaid order has no money to split
 *   2. the item is DELIVERED          — SHIPPED is the seller's own claim
 *   3. deliveredAt is past the hold   — the window a refund usually arrives in
 *   4. nothing is refunded against it — a refunded item was never earned
 *   5. it has never been paid before  — enforced by a constraint, not by this
 *
 * Condition 5 is checked here as an optimisation and enforced by
 * `payout_items.orderItemId @unique`. This query is the fast path; the
 * constraint is the guarantee. Two concurrent payout runs both pass this check
 * and exactly one survives the insert.
 */

/**
 * How long after delivery an item waits.
 *
 * Read per call rather than captured at module load, so a deployment can change
 * it without a rebuild and so a test can assert both sides of the boundary —
 * the same mistake was made twice already with the SMS daily cap and the lag
 * thresholds.
 */
export function holdDays(): number {
  const n = Number(process.env.PAYOUT_HOLD_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

function holdCutoff(now: Date): Date {
  return new Date(now.getTime() - holdDays() * 24 * 3600_000);
}

export type PayableItem = {
  orderItemId: string;
  orderId: string;
  title: string;
  amountCents: number;
  deliveredAt: Date;
};

type ItemRow = {
  id: string;
  orderId: string;
  title: string;
  unitPriceCents: number;
  quantity: number;
  fulfilment: FulfilmentStatus;
  deliveredAt: Date | null;
};

const lineTotal = (i: ItemRow) => i.unitPriceCents * i.quantity;

/**
 * Every order item this seller has on a paid order, with the facts needed to
 * classify it. One query rather than per-item lookups: a seller page is opened
 * while somebody is waiting.
 */
async function sellerItems(sellerId: string): Promise<ItemRow[]> {
  return prisma.orderItem.findMany({
    where: { sellerId, order: { status: OrderStatus.PAID } },
    select: {
      id: true,
      orderId: true,
      title: true,
      unitPriceCents: true,
      quantity: true,
      fulfilment: true,
      deliveredAt: true,
    },
    orderBy: { deliveredAt: "asc" },
  });
}

/**
 * Which of those items a refund touches.
 *
 * TWO KINDS OF REFUND, AND THE SECOND ONE IS THE AWKWARD CASE.
 *
 * A refund with an `orderItemId` names its line, which is the ordinary path —
 * a seller marks one thing unsendable and that one thing is refunded.
 *
 * A refund with a NULL `orderItemId` is an order-level refund from the admin
 * panel, and it cannot be attributed to lines. Any such refund therefore
 * withholds EVERY line of that order, whatever its amount. That is deliberately
 * blunt: the alternative is apportioning a partial refund across sellers by
 * guesswork, and guessing wrong means paying a seller money the buyer has
 * already had back.
 *
 * FAILED refunds are ignored — the money never left.
 */
async function refundedItemIds(items: ItemRow[]): Promise<Set<string>> {
  if (items.length === 0) return new Set();

  const orderIds = [...new Set(items.map((i) => i.orderId))];
  const refunds = await prisma.refund.findMany({
    where: {
      orderId: { in: orderIds },
      status: { in: [RefundStatus.PENDING, RefundStatus.SUCCEEDED] },
    },
    select: { orderId: true, orderItemId: true },
  });

  const blockedOrders = new Set(
    refunds.filter((r) => r.orderItemId === null).map((r) => r.orderId)
  );
  const blockedItems = new Set(
    refunds.map((r) => r.orderItemId).filter((id): id is string => !!id)
  );

  return new Set(
    items.filter((i) => blockedOrders.has(i.orderId) || blockedItems.has(i.id)).map((i) => i.id)
  );
}

/**
 * Items already in a payout.
 *
 * A PENDING payout counts as spoken for: it means a claim was made and the
 * transfer may be in flight. Treating it as still-payable is how one item ends
 * up in two payouts.
 *
 * A REVERSED item does NOT become payable again. The money came back because
 * the buyer was refunded, so nothing is owed — and condition 4 already excludes
 * it anyway.
 */
async function spokenForItemIds(items: ItemRow[]): Promise<Set<string>> {
  if (items.length === 0) return new Set();
  const rows = await prisma.payoutItem.findMany({
    where: { orderItemId: { in: items.map((i) => i.id) } },
    select: { orderItemId: true },
  });
  return new Set(rows.map((r) => r.orderItemId));
}

/** Both gates: this platform's verification, and Stripe's. */
async function gatesFor(sellerId: string) {
  const profile = await prisma.sellerProfile.findUnique({
    where: { id: sellerId },
    select: { payoutsEnabled: true, payoutsReady: true, connectAccountId: true },
  });
  return {
    payoutsEnabled: profile?.payoutsEnabled ?? false,
    payoutsReady: profile?.payoutsReady ?? false,
    connectAccountId: profile?.connectAccountId ?? null,
  };
}

/**
 * The items that could be transferred right now.
 *
 * Returns them rather than a total, because the caller has to record WHICH
 * lines a payout covered — that is what lets a seller be told what a payment
 * was for, and it is what the unique constraint is applied to.
 *
 * DOES NOT CHECK THE GATES. Eligibility of the money and readiness of the
 * account are different questions with different fixes, and merging them would
 * make "you have nothing owed" and "we cannot send it yet" the same answer.
 * `claimPayout` checks the gates; `earningsSummary` reports them.
 */
export async function payableItems(
  sellerId: string,
  now: Date = new Date()
): Promise<PayableItem[]> {
  const items = await sellerItems(sellerId);
  if (items.length === 0) return [];

  const [refunded, spokenFor] = await Promise.all([
    refundedItemIds(items),
    spokenForItemIds(items),
  ]);
  const cutoff = holdCutoff(now);

  return items
    .filter(
      (i) =>
        i.fulfilment === FulfilmentStatus.DELIVERED &&
        i.deliveredAt !== null &&
        i.deliveredAt <= cutoff &&
        !refunded.has(i.id) &&
        !spokenFor.has(i.id)
    )
    .map((i) => ({
      orderItemId: i.id,
      orderId: i.orderId,
      title: i.title,
      amountCents: lineTotal(i),
      deliveredAt: i.deliveredAt!,
    }));
}

export type EarningsSummary = {
  currency: string;
  /** Transferred and not clawed back. */
  paidCents: number;
  /** Transferable right now. Zero when a gate is closed — see withheldCents. */
  payableCents: number;
  /** Delivered and unrefunded, still inside the hold window. */
  heldCents: number;
  /** When the earliest held item becomes payable. */
  heldUntil: Date | null;
  /**
   * Money that meets every condition on the MONEY and is blocked by the
   * ACCOUNT. Separate from heldCents because the seller can act on this one:
   * finish onboarding, or ask why verification is outstanding.
   */
  withheldCents: number;
  /** Sold but not delivered yet, so not earned yet. */
  inFlightCents: number;
  /** Refunded or unsendable. Shown so the numbers add up rather than vanish. */
  notEarnedCents: number;
  /** Owed back from a reversal that could not be recovered. */
  debtCents: number;
  gates: { payoutsEnabled: boolean; payoutsReady: boolean; onboarded: boolean };
};

/**
 * Every figure a seller's payouts page needs, and they are designed to add up.
 *
 * A page that shows "available: $0" and nothing else generates a support
 * message. One that shows what is held, until when, what is blocked and why,
 * answers the question instead.
 */
export async function earningsSummary(
  sellerId: string,
  now: Date = new Date()
): Promise<EarningsSummary> {
  const [items, gates] = await Promise.all([sellerItems(sellerId), gatesFor(sellerId)]);
  const [refunded, spokenFor] = await Promise.all([
    refundedItemIds(items),
    spokenForItemIds(items),
  ]);

  const cutoff = holdCutoff(now);
  let eligibleCents = 0;
  let heldCents = 0;
  let inFlightCents = 0;
  let notEarnedCents = 0;
  let heldUntil: Date | null = null;

  for (const i of items) {
    const amount = lineTotal(i);

    // Refunded or unsendable: never earned, whatever its fulfilment says.
    if (refunded.has(i.id) || i.fulfilment === FulfilmentStatus.UNFULFILLABLE) {
      notEarnedCents += amount;
      continue;
    }
    // Already in a payout — counted under paidCents below, not here.
    if (spokenFor.has(i.id)) continue;

    if (i.fulfilment !== FulfilmentStatus.DELIVERED || i.deliveredAt === null) {
      inFlightCents += amount;
      continue;
    }

    if (i.deliveredAt <= cutoff) {
      eligibleCents += amount;
    } else {
      heldCents += amount;
      const releases = new Date(i.deliveredAt.getTime() + holdDays() * 24 * 3600_000);
      if (heldUntil === null || releases < heldUntil) heldUntil = releases;
    }
  }

  /**
   * Paid means transferred and not clawed back. A reversed line is money the
   * buyer got back, so counting it as paid would tell a seller they had been
   * given money they no longer have.
   */
  const paid = await prisma.payoutItem.aggregate({
    where: {
      reversedAt: null,
      payout: { sellerId, status: PayoutStatus.PAID },
    },
    _sum: { amountCents: true },
  });

  const debt = await prisma.payoutDebt.aggregate({
    where: { sellerId, settledAt: null },
    _sum: { amountCents: true },
  });

  const open = gates.payoutsEnabled && gates.payoutsReady;

  return {
    currency: "USD",
    paidCents: paid._sum.amountCents ?? 0,
    // Eligible money moves to `withheld` when the account cannot receive it, so
    // the two never double-count and "available" never promises the impossible.
    payableCents: open ? eligibleCents : 0,
    withheldCents: open ? 0 : eligibleCents,
    heldCents,
    heldUntil,
    inFlightCents,
    notEarnedCents,
    debtCents: debt._sum.amountCents ?? 0,
    gates: {
      payoutsEnabled: gates.payoutsEnabled,
      payoutsReady: gates.payoutsReady,
      onboarded: gates.connectAccountId !== null,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Moving the money
 * ------------------------------------------------------------------ */

export type ClaimOutcome =
  | { claimed: true; payoutId: string; amountCents: number; nettedCents: number; items: number }
  | {
      claimed: false;
      reason: "nothing-payable" | "not-verified" | "not-ready" | "no-account" | "raced";
    };

/**
 * Reserves a payout, atomically, before a single cent moves.
 *
 * THE INSERT IS THE CLAIM. Both the eligibility query and this function run in
 * every concurrent payout attempt, and both will happily agree that the same
 * $50 is payable. What separates them is `payout_items.orderItemId @unique`:
 * the transaction that inserts first wins, and the second fails on the
 * constraint and rolls back its whole payout.
 *
 * That is deliberately not a check followed by a write. A read-then-transfer
 * version ("what is owed? right, send that") lets two runs both read the same
 * balance and both send it, which for a $120 order means $240 leaving the
 * platform — the identical shape of bug as the five-simultaneous-charges one,
 * with the identical fix. See ADR 0013, ADR 0016 and ADR 0029.
 *
 * NOTHING IS SENT HERE. The provider is called by `runPayout` only after this
 * has returned `claimed: true`.
 */
export async function claimPayout(
  sellerId: string,
  now: Date = new Date()
): Promise<ClaimOutcome> {
  const gates = await gatesFor(sellerId);
  // Ordered most-actionable-first, so a seller is told the thing they can fix.
  if (!gates.connectAccountId) return { claimed: false, reason: "no-account" };
  if (!gates.payoutsEnabled) return { claimed: false, reason: "not-verified" };
  if (!gates.payoutsReady) return { claimed: false, reason: "not-ready" };

  const items = await payableItems(sellerId, now);
  if (items.length === 0) return { claimed: false, reason: "nothing-payable" };

  const grossCents = items.reduce((sum, i) => sum + i.amountCents, 0);

  /**
   * Debt is netted off, oldest first, and never below zero.
   *
   * A seller who owes more than this payout is worth keeps the remainder owing
   * rather than receiving a negative transfer, which Stripe would refuse
   * anyway. Settling only what this payout can absorb is why the debts are
   * claimed inside the same transaction as the payout.
   */
  const debts = await prisma.payoutDebt.findMany({
    where: { sellerId, settledAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, amountCents: true },
  });

  let remaining = grossCents;
  const settling: string[] = [];
  for (const d of debts) {
    if (d.amountCents > remaining) break;
    remaining -= d.amountCents;
    settling.push(d.id);
  }
  const nettedCents = grossCents - remaining;

  if (remaining <= 0) {
    /**
     * Everything owed went to debt. The lines are still marked as paid — they
     * HAVE been settled, just against what the seller owed rather than into
     * their account — because leaving them payable would net the same debt off
     * again on the next run.
     */
    await prisma.$transaction(async (tx) => {
      const payout = await tx.payout.create({
        data: {
          sellerId,
          amountCents: 0,
          nettedCents,
          status: PayoutStatus.PAID,
          provider: isStubPayouts() ? "stub" : "stripe_connect",
          completedAt: now,
          items: {
            create: items.map((i) => ({
              orderItemId: i.orderItemId,
              amountCents: i.amountCents,
            })),
          },
        },
        select: { id: true },
      });
      if (settling.length > 0) {
        await tx.payoutDebt.updateMany({
          where: { id: { in: settling } },
          data: { settledAt: now },
        });
      }
      return payout;
    });
    return { claimed: false, reason: "nothing-payable" };
  }

  try {
    const payout = await prisma.$transaction(async (tx) => {
      const created = await tx.payout.create({
        data: {
          sellerId,
          amountCents: remaining,
          nettedCents,
          status: PayoutStatus.PENDING,
          provider: isStubPayouts() ? "stub" : "stripe_connect",
          items: {
            create: items.map((i) => ({
              orderItemId: i.orderItemId,
              amountCents: i.amountCents,
            })),
          },
        },
        select: { id: true },
      });

      if (settling.length > 0) {
        await tx.payoutDebt.updateMany({
          where: { id: { in: settling }, settledAt: null },
          data: { settledAt: now },
        });
      }

      return created;
    });

    return {
      claimed: true,
      payoutId: payout.id,
      amountCents: remaining,
      nettedCents,
      items: items.length,
    };
  } catch (err) {
    // P2002 on payout_items.orderItemId: a concurrent run claimed these lines.
    if ((err as { code?: string })?.code === "P2002") {
      return { claimed: false, reason: "raced" };
    }
    throw err;
  }
}

/**
 * Claims, then transfers, then settles — in that order, always.
 *
 * If the process dies between the claim and the transfer, the payout is left
 * `PENDING` with its lines already spoken for. Nothing is lost and nothing is
 * paid twice: `sendPendingPayouts()` picks it up, and because the payout id is
 * Stripe's idempotency key, even a genuine double-send returns the SAME
 * transfer rather than making a second one.
 */
export async function runPayout(sellerId: string, now: Date = new Date()) {
  const claim = await claimPayout(sellerId, now);
  if (!claim.claimed) return { sent: false as const, reason: claim.reason };

  const outcome = await sendClaimedPayout(claim.payoutId);
  return outcome;
}

/** Sends one already-claimed payout. Safe to call twice. */
export async function sendClaimedPayout(payoutId: string) {
  const payout = await prisma.payout.findUnique({
    where: { id: payoutId },
    select: {
      id: true,
      amountCents: true,
      currency: true,
      status: true,
      seller: { select: { connectAccountId: true } },
    },
  });

  if (!payout) return { sent: false as const, reason: "no-such-payout" };
  if (payout.status !== PayoutStatus.PENDING) {
    return { sent: false as const, reason: "already-settled" };
  }
  if (!payout.seller.connectAccountId) {
    return { sent: false as const, reason: "no-account" };
  }

  try {
    const result = await transfer({
      accountId: payout.seller.connectAccountId,
      amountCents: payout.amountCents,
      currency: payout.currency,
      payoutId: payout.id,
    });

    /**
     * Settled with the status in the WHERE clause, so a second sender updating
     * the same row is a no-op rather than a second settlement. Both callers
     * hold the same transferId, because Stripe's idempotency key gave them the
     * same transfer.
     */
    const settledHere = await prisma.payout.updateMany({
      where: { id: payout.id, status: PayoutStatus.PENDING },
      data: {
        status: PayoutStatus.PAID,
        providerTransferId: result.transferId,
        completedAt: new Date(),
      },
    });

    return {
      sent: true as const,
      payoutId: payout.id,
      amountCents: payout.amountCents,
      transferId: result.transferId,
      /**
       * WHETHER THIS CALLER WAS THE ONE THAT SETTLED IT, which is not the same
       * question as whether it succeeded.
       *
       * The status check at the top of this function is a read, so two workers
       * can both pass it and both call `transfer()`. That is safe — they get
       * the same transfer back, by idempotency key — and both of them
       * legitimately return `sent: true`. But only one `updateMany` matches a
       * row, and the other's count is 0.
       *
       * Exposed because `sendPendingPayouts` runs as a scheduled job whose log
       * line is the whole interface an operator has. Two overlapping runs
       * reporting `sent=1` each reads as two payouts; it was one.
       */
      settled: settledHere.count === 1,
    };
  } catch (err) {
    const permanent = err instanceof PayoutError && err.permanent;
    const message = err instanceof Error ? err.message : String(err);

    if (permanent) {
      /**
       * A rejected account will refuse identically forever. The payout is
       * FAILED and its lines stay claimed, deliberately: releasing them would
       * make every subsequent run re-attempt a transfer that cannot work. An
       * operator fixes the account and retries this payout explicitly.
       */
      await prisma.payout.updateMany({
        where: { id: payout.id, status: PayoutStatus.PENDING },
        data: { status: PayoutStatus.FAILED, failureReason: message, completedAt: new Date() },
      });
    } else {
      // Transient: left PENDING for sendPendingPayouts() to try again.
      await prisma.payout.updateMany({
        where: { id: payout.id, status: PayoutStatus.PENDING },
        data: { failureReason: message },
      });
    }

    return { sent: false as const, reason: permanent ? "refused" : "retry-later" };
  }
}

/**
 * Finishes payouts that were claimed and never sent.
 *
 * The gap between the claim and the transfer is the one place a crash leaves
 * money owed with nothing chasing it — the same shape as the delivery ledger's
 * ambiguous middle (ADR 0026), and it gets the same answer: something has to
 * come back for it.
 */
export async function sendPendingPayouts(limit = 25) {
  const pending = await prisma.payout.findMany({
    where: { status: PayoutStatus.PENDING },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });

  let sent = 0;
  let failed = 0;
  let raced = 0;

  for (const p of pending) {
    const outcome = await sendClaimedPayout(p.id);
    if (outcome.sent) {
      // `settled` distinguishes "this run sent it" from "this run watched
      // another run send it and got the same transfer back".
      if (outcome.settled) sent += 1;
      else raced += 1;
    } else if (outcome.reason === "already-settled" || outcome.reason === "no-such-payout") {
      /**
       * SOMEBODY ELSE GOT THERE FIRST, which is not a failure.
       *
       * Counted separately because this runs as a scheduled job, and its
       * output is the whole interface an operator has. Two workers overlapping
       * — a CronJob firing while a seller presses the button — is the ordinary
       * case, and reporting it as `failed` trains whoever reads the logs to
       * ignore the number that matters. Seen for real in a kind cluster: two
       * concurrent Jobs reported `sent=1` and `failed=1`, and the second was
       * correct behaviour.
       *
       * This branch catches the SLOWER overlap, where the second worker starts
       * after the first has settled the row. The faster one — both inside
       * `transfer()` at once — lands on `sent: true, settled: false` above,
       * which is why that flag exists.
       */
      raced += 1;
    } else {
      failed += 1;
    }
  }

  return { sent, failed, raced, considered: pending.length };
}

/* ------------------------------------------------------------------ *
 * A refund that arrives after the seller was paid
 * ------------------------------------------------------------------ */

export type ReversalOutcome = {
  /** No payout covered this line — the hold did its job. */
  nothingToReverse: boolean;
  reversedCents: number;
  debtCents: number;
};

/**
 * Claws back what was paid for one line, because the buyer got a refund.
 *
 * The hold period makes this rare rather than impossible, so it has to exist
 * and it has to be honest about failing: a seller who has already withdrawn the
 * money leaves nothing to reverse, and the shortfall becomes a `PayoutDebt`
 * netted off their next payout. Silently absorbing it would mean the platform
 * loses money with no record of who owes what.
 *
 * NEVER THROWS. It runs on the refund path, and a reversal problem must not
 * fail a refund the buyer has already been given.
 */
export async function reverseForRefund(
  orderItemId: string,
  refundedCents: number
): Promise<ReversalOutcome> {
  const nothing: ReversalOutcome = { nothingToReverse: true, reversedCents: 0, debtCents: 0 };

  try {
    const line = await prisma.payoutItem.findUnique({
      where: { orderItemId },
      select: {
        id: true,
        amountCents: true,
        reversedAt: true,
        payout: {
          select: { id: true, sellerId: true, status: true, providerTransferId: true },
        },
      },
    });

    if (!line || line.reversedAt !== null) return nothing;
    if (line.payout.status !== PayoutStatus.PAID) return nothing;

    // Never claw back more than was actually paid for this line.
    const target = Math.min(line.amountCents, refundedCents);
    if (target <= 0) return nothing;

    /**
     * Claimed by setting reversedAt conditionally, so two refunds against the
     * same line cannot both reverse it.
     */
    const claimed = await prisma.payoutItem.updateMany({
      where: { id: line.id, reversedAt: null },
      data: { reversedAt: new Date() },
    });
    if (claimed.count !== 1) return nothing;

    if (!line.payout.providerTransferId) {
      // Paid entirely out of debt netting: there is no transfer to reverse.
      return { nothingToReverse: false, reversedCents: 0, debtCents: 0 };
    }

    let reversedCents = 0;
    let failure: string | null = null;
    try {
      const result = await reverseTransfer({
        transferId: line.payout.providerTransferId,
        amountCents: target,
      });
      reversedCents = result.reversedCents;
      await prisma.payoutItem.update({
        where: { id: line.id },
        data: { providerReversalId: result.reversalId },
      });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    const shortfall = target - reversedCents;
    if (shortfall > 0) {
      await prisma.payoutDebt.create({
        data: {
          sellerId: line.payout.sellerId,
          amountCents: shortfall,
          orderItemId,
          reason:
            failure ??
            "the transfer could not be fully reversed — the funds had already been withdrawn",
        },
      });
    }

    return { nothingToReverse: false, reversedCents, debtCents: shortfall };
  } catch (err) {
    console.error(`[payouts] reversal for order item ${orderItemId} failed`, err);
    return nothing;
  }
}
