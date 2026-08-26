import { prisma } from "./prisma";
import { reverseForRefund } from "./payouts";
import {
  PAYMENT_PROVIDER,
  PaymentError,
  refundIntent,
  type RefundOutcome,
} from "./paymentProvider";
import { events } from "./notifications";
import {
  OrderStatus,
  RefundStatus,
  RefundTrigger,
} from "../generated/prisma/enums";

/**
 * Sending money back.
 *
 * WHY THIS EXISTS
 * A seller could mark a line "can't send it" and the buyer's money simply
 * stayed taken. Nothing in the system would ever return it. That was not a
 * missing feature so much as a wrong one: the code recorded that a refund was
 * owed and then had no mechanism to settle it.
 *
 * THE HARD PART IS NOT CALLING THE PROVIDER
 * It is making sure we never send back more than came in, and never send the
 * same money back twice, when two requests arrive together. Both are solved the
 * same way payment claiming is: one conditional UPDATE decides, and only the
 * caller whose UPDATE matched a row is allowed to talk to the provider.
 * See docs/adr/0013-payment-provider-seam.md
 */

export class RefundError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "RefundError";
    this.code = code;
    this.status = status;
  }
}

/** What is still refundable on an order, in minor units. */
export async function refundableCents(orderId: string): Promise<number> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, subtotalCents: true, refundedCents: true },
  });
  if (!order) return 0;
  // Only a paid order has anything to give back. REFUNDED is fully returned
  // already; anything else never took the money.
  if (order.status !== OrderStatus.PAID) return 0;
  return Math.max(0, order.subtotalCents - order.refundedCents);
}

/**
 * Reserves headroom for a refund, atomically.
 *
 * Returns false when the order cannot absorb it — already fully refunded, not
 * paid, or a concurrent request got there first. The caller must not contact
 * the provider unless this returned true.
 *
 * This is the whole safety property. A read-then-write version ("how much is
 * left? ok, refund that") lets two requests both read the same headroom and
 * both spend it, which for a £120 order means £240 leaving the account. That is
 * the identical shape of bug as the five-simultaneous-charges one, and it gets
 * the identical fix.
 */
async function claimRefundHeadroom(orderId: string, amountCents: number): Promise<boolean> {
  const claimed = await prisma.$executeRaw`
    UPDATE "orders"
    SET "refundedCents" = "refundedCents" + ${amountCents},
        "updatedAt" = NOW()
    WHERE "id" = ${orderId}
      AND "status" = 'PAID'
      AND "refundedCents" + ${amountCents} <= "subtotalCents"
  `;
  return claimed === 1;
}

/** Gives headroom back when the provider refused. */
async function releaseRefundHeadroom(orderId: string, amountCents: number) {
  await prisma.$executeRaw`
    UPDATE "orders"
    SET "refundedCents" = GREATEST(0, "refundedCents" - ${amountCents}),
        "updatedAt" = NOW()
    WHERE "id" = ${orderId}
  `;
}

/**
 * Issues a refund and records it.
 *
 * ORDER OF OPERATIONS, WHICH IS THE POINT
 *   1. claim headroom       — atomic; decides who may proceed
 *   2. write a PENDING row  — so a crash after step 3 is still visible
 *   3. call the provider    — keyed on the row id, so a retry is safe
 *   4. settle the row
 *
 * Claiming before writing means the books say the money is gone slightly before
 * it is. That is the safe direction: the failure mode is a refund we owe and
 * have recorded, which a person can see and finish. The other order round —
 * provider first, books after — fails as money that left with no record, which
 * nobody can find.
 */
export async function issueRefund(input: {
  orderId: string;
  orderItemId?: string | null;
  amountCents: number;
  reason: string;
  trigger: RefundTrigger;
  initiatedById?: string | null;
}) {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new RefundError("REASON_REQUIRED", "Say why the money is going back.", 400);
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents < 1) {
    throw new RefundError("INVALID_AMOUNT", "A refund must be a positive amount.", 400);
  }

  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: {
      id: true,
      reference: true,
      buyerId: true,
      status: true,
      currency: true,
      subtotalCents: true,
      refundedCents: true,
      paymentIntentId: true,
      paymentProvider: true,
    },
  });
  if (!order) throw new RefundError("NOT_FOUND", "Order not found.", 404);

  if (order.status !== OrderStatus.PAID) {
    throw new RefundError(
      "NOT_REFUNDABLE",
      order.status === OrderStatus.REFUNDED
        ? "That order has already been refunded in full."
        : "That order was never paid for, so there is nothing to refund.",
      409
    );
  }
  if (!order.paymentIntentId) {
    throw new RefundError(
      "NO_PAYMENT_REFERENCE",
      "That order has no payment on record to refund against.",
      409
    );
  }
  if (order.refundedCents + input.amountCents > order.subtotalCents) {
    throw new RefundError(
      "EXCEEDS_ORDER_TOTAL",
      `Only ${order.subtotalCents - order.refundedCents} left to refund on this order.`,
      409
    );
  }

  /* ---- 1. claim ---- */
  const claimed = await claimRefundHeadroom(order.id, input.amountCents);
  if (!claimed) {
    // Lost a race, or the order moved underneath us. Either way the check above
    // was advisory and this is the answer that counts.
    throw new RefundError(
      "REFUND_IN_PROGRESS",
      "That refund is already being processed, or the order changed. Reload and check.",
      409
    );
  }

  /* ---- 2. record intent before acting ---- */
  const refund = await prisma.refund.create({
    data: {
      orderId: order.id,
      orderItemId: input.orderItemId ?? null,
      amountCents: input.amountCents,
      currency: order.currency,
      status: RefundStatus.PENDING,
      trigger: input.trigger,
      reason,
      initiatedById: input.initiatedById ?? null,
      provider: order.paymentProvider ?? PAYMENT_PROVIDER,
    },
  });

  /* ---- 3. provider ---- */
  try {
    const outcome = await refundIntent({
      paymentIntentId: order.paymentIntentId,
      amountCents: input.amountCents,
      // Derived from the row, never random. A retry after a dropped connection
      // must return the first refund rather than issuing a second one.
      idempotencyKey: refund.id,
    });

    if (outcome.status === "failed") {
      await prisma.refund.update({
        where: { id: refund.id },
        data: {
          status: RefundStatus.FAILED,
          failureReason: outcome.reason,
          completedAt: new Date(),
        },
      });
      await releaseRefundHeadroom(order.id, input.amountCents);
      throw new RefundError("PROVIDER_REFUSED", outcome.reason, 502);
    }

    /* ---- 4. settle ---- */
    const settled = outcome.status === "succeeded";
    await prisma.refund.update({
      where: { id: refund.id },
      data: {
        status: settled ? RefundStatus.SUCCEEDED : RefundStatus.PENDING,
        providerRefundId: outcome.refundId,
        completedAt: settled ? new Date() : null,
      },
    });

    // Fully refunded orders get the status. Partly refunded ones stay PAID with
    // refundedCents telling the rest — see the schema comment on that column.
    const after = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { refundedCents: true, subtotalCents: true },
    });
    if (after.refundedCents >= after.subtotalCents) {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.REFUNDED },
      });
    }

    /**
     * CLAW BACK WHAT THE SELLER WAS ALREADY PAID, if anything.
     *
     * The hold period exists so this is rare — normally the refund lands long
     * before the payout does, and this finds nothing. When it does find a paid
     * line it reverses the transfer, and records a debt if the money has
     * already been withdrawn.
     *
     * `void`-ed and error-swallowing, exactly like the notification below it
     * and for the same reason: the buyer has already been refunded, and a
     * problem clawing money back from a seller must not undo that.
     */
    if (settled && input.orderItemId) {
      void reverseForRefund(input.orderItemId, input.amountCents);
    }

    if (settled) {
      void events.refundIssued({
        buyerUserId: order.buyerId,
        orderId: order.id,
        amountCents: input.amountCents,
        currency: order.currency,
        reason,
      });
    }

    return {
      id: refund.id,
      status: settled ? RefundStatus.SUCCEEDED : RefundStatus.PENDING,
      amountCents: input.amountCents,
      currency: order.currency,
    };
  } catch (err) {
    if (err instanceof RefundError) throw err;

    /**
     * An indeterminate provider error means the refund MAY have gone through.
     *
     * The headroom stays claimed and the row stays PENDING. Releasing it would
     * invite a second refund for money that may already be on its way back,
     * which is the one outcome worse than a stuck row.
     */
    if (err instanceof PaymentError && err.indeterminate) {
      await prisma.refund.update({
        where: { id: refund.id },
        data: { failureReason: `Unconfirmed: ${err.message}` },
      });
      throw new RefundError(
        "REFUND_UNCONFIRMED",
        "We could not confirm the refund with the payment provider. It is recorded and will be checked — do not retry.",
        502
      );
    }

    await prisma.refund.update({
      where: { id: refund.id },
      data: {
        status: RefundStatus.FAILED,
        failureReason: err instanceof Error ? err.message : "Unknown error",
        completedAt: new Date(),
      },
    });
    await releaseRefundHeadroom(order.id, input.amountCents);
    throw new RefundError(
      "REFUND_FAILED",
      err instanceof Error ? err.message : "The refund could not be issued.",
      502
    );
  }
}

/**
 * Refunds a single unfulfillable line at exactly what was paid for it.
 *
 * Called automatically when a seller says they cannot send something. The buyer
 * should not have to ask: they paid, the item is not coming, and the money is
 * theirs. Making them chase it is how a marketplace acquires a reputation.
 */
export async function refundUnfulfillableLine(input: {
  orderItemId: string;
  reason: string;
}) {
  const line = await prisma.orderItem.findUnique({
    where: { id: input.orderItemId },
    select: {
      id: true,
      orderId: true,
      title: true,
      unitPriceCents: true,
      quantity: true,
      order: { select: { status: true } },
    },
  });
  if (!line) throw new RefundError("NOT_FOUND", "Sale not found.", 404);

  // Nothing to give back on an unpaid order, and saying so is not an error —
  // a cancelled checkout reaching here is normal.
  if (line.order.status !== OrderStatus.PAID) return null;

  const already = await prisma.refund.findFirst({
    where: {
      orderItemId: line.id,
      status: { in: [RefundStatus.PENDING, RefundStatus.SUCCEEDED] },
    },
    select: { id: true },
  });
  // Idempotent by line: a seller toggling the same line twice must not refund
  // twice. The atomic claim would stop over-refunding the ORDER, but a
  // part-refunded multi-line order could still absorb a second one for a line
  // that was already settled.
  if (already) return null;

  return issueRefund({
    orderId: line.orderId,
    orderItemId: line.id,
    amountCents: line.unitPriceCents * line.quantity,
    reason: input.reason,
    trigger: RefundTrigger.SELLER_UNFULFILLABLE,
  });
}

/* ================================================================== *
 * Settling a refund the provider decides asynchronously
 * ================================================================== */

/**
 * Applies a provider decision to a refund that was left PENDING.
 *
 * WHY THIS HAS TO EXIST
 * issueRefund() settles synchronously when the provider answers immediately,
 * which is what Stripe does in test mode. It does not always: a refund can come
 * back `pending` and be decided minutes later. Without this the row would sit
 * PENDING for ever — the buyer told their money was on its way, the headroom
 * held against the order, and nothing anywhere to move it on.
 *
 * IDEMPOTENT, because it has to be
 * Stripe delivers at least once and retries, and `refund.created` /
 * `refund.updated` / `refund.failed` can all describe the same refund. A row
 * that already reached SUCCEEDED or FAILED is left exactly as it is.
 */
export async function settleRefundFromProvider(input: {
  providerRefundId: string;
  outcome: RefundOutcome;
}): Promise<
  | { applied: true; status: RefundStatus; refundId: string }
  | { applied: false; reason: "NOT_FOUND" | "ALREADY_SETTLED" | "STILL_PENDING" }
> {
  const refund = await prisma.refund.findUnique({
    where: { providerRefundId: input.providerRefundId },
    select: {
      id: true,
      orderId: true,
      // Needed to claw back the seller's side of this line, if it was paid.
      orderItemId: true,
      amountCents: true,
      currency: true,
      status: true,
      reason: true,
      order: { select: { buyerId: true, subtotalCents: true } },
    },
  });

  // Not ours. Almost certainly another environment sharing the Stripe account,
  // and no amount of retrying will conjure the row.
  if (!refund) return { applied: false, reason: "NOT_FOUND" };

  if (refund.status !== RefundStatus.PENDING) {
    return { applied: false, reason: "ALREADY_SETTLED" };
  }

  if (input.outcome.status === "pending") {
    return { applied: false, reason: "STILL_PENDING" };
  }

  /* ---- it worked ---- */
  if (input.outcome.status === "succeeded") {
    await prisma.refund.update({
      where: { id: refund.id },
      data: { status: RefundStatus.SUCCEEDED, completedAt: new Date() },
    });

    const after = await prisma.order.findUniqueOrThrow({
      where: { id: refund.orderId },
      select: { refundedCents: true, subtotalCents: true, status: true },
    });
    if (after.refundedCents >= after.subtotalCents && after.status !== OrderStatus.REFUNDED) {
      await prisma.order.update({
        where: { id: refund.orderId },
        data: { status: OrderStatus.REFUNDED },
      });
    }

    /**
     * And claw back the seller's side here too.
     *
     * A refund that settles by webhook rather than synchronously is the SAME
     * event as far as a payout is concerned. Hooking only the synchronous path
     * would mean an asynchronous refund silently left the seller holding money
     * the buyer had been given back.
     */
    if (refund.orderItemId) {
      void reverseForRefund(refund.orderItemId, refund.amountCents);
    }

    // Told now rather than when the refund was requested. issueRefund only
    // notifies on a synchronous success, precisely so nobody is told their
    // money is back while it is still in flight.
    void events.refundIssued({
      buyerUserId: refund.order.buyerId,
      orderId: refund.orderId,
      amountCents: refund.amountCents,
      currency: refund.currency,
      reason: refund.reason,
    });

    return { applied: true, status: RefundStatus.SUCCEEDED, refundId: refund.id };
  }

  /* ---- it did not ---- *
   *
   * The headroom reserved when the refund was requested has to come back, or
   * the order permanently believes money went out that never did — and a
   * legitimate retry would then be refused as an over-refund.
   */
  await prisma.refund.update({
    where: { id: refund.id },
    data: {
      status: RefundStatus.FAILED,
      failureReason: input.outcome.reason,
      completedAt: new Date(),
    },
  });
  await releaseRefundHeadroom(refund.orderId, refund.amountCents);

  /**
   * And the order status, if this refund is what flipped it.
   *
   * A REFUNDED order whose only refund just failed is not refunded — it is
   * paid. Leaving it would tell the buyer their money came back, hide the
   * order from the seller's earnings, and make the books disagree with the
   * provider all at once.
   */
  const unwound = await prisma.order.findUniqueOrThrow({
    where: { id: refund.orderId },
    select: { refundedCents: true, subtotalCents: true, status: true },
  });
  if (unwound.status === OrderStatus.REFUNDED && unwound.refundedCents < unwound.subtotalCents) {
    await prisma.order.update({
      where: { id: refund.orderId },
      data: { status: OrderStatus.PAID },
    });
  }

  console.error(
    `[refunds] provider refused refund ${refund.id} on order ${refund.orderId}: ${input.outcome.reason}`
  );
  return { applied: true, status: RefundStatus.FAILED, refundId: refund.id };
}

/** Every refund on an order, newest first. */
export async function refundsForOrder(orderId: string) {
  return prisma.refund.findMany({
    where: { orderId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      orderItemId: true,
      amountCents: true,
      currency: true,
      status: true,
      trigger: true,
      reason: true,
      failureReason: true,
      createdAt: true,
      completedAt: true,
    },
  });
}

/**
 * A buyer's refunds across every order.
 *
 * Powers /account/cancellations, which existed as a placeholder for exactly as
 * long as refunds did not.
 */
export async function refundsForBuyer(userId: string) {
  const rows = await prisma.refund.findMany({
    where: { order: { buyerId: userId } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      amountCents: true,
      currency: true,
      status: true,
      trigger: true,
      reason: true,
      createdAt: true,
      completedAt: true,
      orderItemId: true,
      order: { select: { id: true, reference: true } },
    },
  });

  // The line title is a snapshot on OrderItem, so it survives the listing being
  // deleted — which is a likely outcome for something a seller could not send.
  const itemIds = rows.map((r) => r.orderItemId).filter((id): id is string => id !== null);
  const items = itemIds.length
    ? await prisma.orderItem.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, title: true },
      })
    : [];
  const titles = new Map(items.map((i) => [i.id, i.title]));

  return rows.map((r) => ({
    id: r.id,
    amountCents: r.amountCents,
    currency: r.currency,
    status: r.status,
    trigger: r.trigger,
    reason: r.reason,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    orderId: r.order.id,
    orderReference: r.order.reference,
    itemTitle: r.orderItemId ? titles.get(r.orderItemId) ?? null : null,
  }));
}
