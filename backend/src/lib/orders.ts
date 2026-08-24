import crypto from "crypto";
import { prisma } from "./prisma";
import { defaultAddress, getAddress, toOrderSnapshot } from "./addresses";
import { notifyMany } from "./notifications";
import { cancelIntent, getIntent } from "./paymentProvider";
import { TX_OPTIONS, lockListing } from "./reservations";
import {
  ListingStatus,
  NotificationType,
  OrderStatus,
  ReservationStatus,
} from "../generated/prisma/enums";

/**
 * Orders.
 *
 * WHERE STOCK LIVES AT EACH STAGE
 *   hold (HELD reservation)  — stock committed, expires in 15 minutes
 *   order (PENDING_PAYMENT)  — stock committed, reservation now CONVERTED
 *   order (PROCESSING)       — stock committed, a payment is in flight
 *   order (PAID)             — listing SOLD, permanent
 *   order (FAILED/CANCELLED) — stock returned, listing ACTIVE again
 *
 * The reservation converts at order creation, not at payment success. If it
 * stayed HELD, the 15-minute sweeper would hand the stock to someone else while
 * the buyer was mid-payment — and the first person to learn would be whoever
 * paid for an item that had already gone.
 *
 * That moves the responsibility: an unpaid order now holds stock, so an
 * abandoned one has to expire too. releaseAbandonedOrders() does that. Without
 * it, an order nobody completes hides a listing forever — the same deadlock the
 * reservation sweeper exists to prevent (ADR 0012).
 */

/** Generous — a card form plus 3-D Secure can legitimately take minutes. */
export const ORDER_PAYMENT_TTL_MS = 30 * 60 * 1000;

/**
 * How long an order may sit in PROCESSING before we go and ask the provider
 * what happened. Short, because this state blocks the buyer: they cannot retry
 * and cannot cancel while a charge might be in flight.
 */
export const ORDER_PROCESSING_TTL_MS = 2 * 60 * 1000;

/** Both states keep stock committed and both are payable-in-progress. */
const STOCK_COMMITTED: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PROCESSING,
];

export class OrderError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "OrderError";
    this.code = code;
    this.status = status;
  }
}

/** Short, unambiguous in speech — no O/0 or I/1 confusion. */
function makeReference() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (const byte of crypto.randomBytes(6)) out += alphabet[byte % alphabet.length];
  return `RS2-${out}`;
}

const orderSelect = {
  id: true,
  reference: true,
  status: true,
  subtotalCents: true,
  currency: true,
  paymentProvider: true,
  paymentIntentId: true,
  paidAt: true,
  failureReason: true,
  createdAt: true,
  shipToName: true,
  shipToLine1: true,
  shipToLine2: true,
  shipToCity: true,
  shipToRegion: true,
  shipToPostcode: true,
  shipToCountry: true,
  shipToPhone: true,
  items: {
    select: {
      id: true,
      listingId: true,
      title: true,
      unitPriceCents: true,
      quantity: true,
      sellerName: true,
      fulfilment: true,
      shippedAt: true,
      deliveredAt: true,
      carrier: true,
      trackingNumber: true,
      fulfilmentNote: true,
      listing: { select: { slug: true, images: { take: 1, orderBy: { position: "asc" as const }, select: { url: true } } } },
    },
  },
};

/**
 * Turns the buyer's live holds into one order.
 *
 * Listings are locked in a stable order (by id) because an order can span
 * several of them — two buyers checking out overlapping carts would otherwise
 * be able to grab the same two rows in opposite orders and deadlock.
 */
export async function createOrderFromHolds(userId: string, addressId?: string) {
  /**
   * The delivery address is resolved and COPIED before the transaction, then
   * written onto the order as plain fields. No foreign key: the buyer can edit
   * or delete that address tomorrow, and this order still has to say where it
   * was actually sent. Same reasoning as the title and price snapshots below.
   */
  const chosen = addressId
    ? await getAddress(userId, addressId)
    : await defaultAddress(userId);

  if (!chosen) {
    throw new OrderError(
      "NO_ADDRESS",
      addressId
        ? "That delivery address is no longer available."
        : "Add a delivery address before checking out.",
      400
    );
  }

  return prisma.$transaction(async (tx) => {
    const now = new Date();

    const holds = await tx.reservation.findMany({
      where: { userId, status: ReservationStatus.HELD, expiresAt: { gt: now } },
      orderBy: { listingId: "asc" },
      select: { id: true, listingId: true, quantity: true },
    });

    if (holds.length === 0) {
      throw new OrderError(
        "NOTHING_TO_BUY",
        "Nothing is on hold. Add something to your cart first.",
        400
      );
    }

    let subtotalCents = 0;
    let currency = "USD";
    const items: {
      listingId: string;
      sellerId: string;
      title: string;
      unitPriceCents: number;
      quantity: number;
      sellerName: string;
    }[] = [];

    for (const hold of holds) {
      // Lock first, then read the details — same ordering as every other path.
      const locked = await lockListing(tx, hold.listingId);
      if (!locked || locked.deletedAt !== null) {
        throw new OrderError("ITEM_GONE", "One of your items is no longer available.");
      }

      const listing = await tx.listing.findUniqueOrThrow({
        where: { id: hold.listingId },
        select: {
          title: true,
          priceCents: true,
          currency: true,
          sellerId: true,
          seller: { select: { shopName: true } },
        },
      });

      // Re-check under the lock: the sweeper may have expired this hold between
      // the query above and the lock being granted.
      const still = await tx.reservation.findFirst({
        where: { id: hold.id, status: ReservationStatus.HELD, expiresAt: { gt: now } },
        select: { id: true },
      });
      if (!still) {
        throw new OrderError(
          "HOLD_EXPIRED",
          "One of your holds expired. Add the item again to continue."
        );
      }

      subtotalCents += listing.priceCents * hold.quantity;
      currency = listing.currency;

      items.push({
        listingId: hold.listingId,
        // A real reference, unlike sellerName below — this is what lets a
        // seller ask "what did I sell?", which they previously could not.
        sellerId: listing.sellerId,
        // Snapshots: the seller can rename or reprice this tomorrow, and the
        // order still has to say what was bought for how much.
        title: listing.title,
        unitPriceCents: listing.priceCents,
        quantity: hold.quantity,
        sellerName: listing.seller.shopName,
      });
    }

    const order = await tx.order.create({
      data: {
        reference: makeReference(),
        buyerId: userId,
        status: OrderStatus.PENDING_PAYMENT,
        subtotalCents,
        currency,
        ...toOrderSnapshot(chosen),
        items: { create: items },
      },
      select: orderSelect,
    });

    // The order owns the stock commitment from here.
    await tx.reservation.updateMany({
      where: { id: { in: holds.map((h) => h.id) } },
      data: { status: ReservationStatus.CONVERTED, releasedAt: now },
    });

    return order;
  }, TX_OPTIONS);
}

export async function attachPaymentIntent(input: {
  orderId: string;
  provider: string;
  intentId: string;
}) {
  await prisma.order.update({
    where: { id: input.orderId },
    data: { paymentProvider: input.provider, paymentIntentId: input.intentId },
  });
}

/**
 * Claims the order for payment, and reports whether this caller won.
 *
 * THIS IS THE DOUBLE-PAYMENT GUARD.
 *
 * Reading the status and then charging the card is two steps, and two
 * concurrent requests both complete step one before either finishes step two.
 * Both see PENDING_PAYMENT, both conclude they are first, both charge. That is
 * not a theoretical race — before this existed, five simultaneous requests
 * produced five successful charges in testing.
 *
 * A single conditional UPDATE closes it. Postgres serialises writes to a row,
 * so of N concurrent statements exactly one matches PENDING_PAYMENT and moves
 * it to PROCESSING; the rest match nothing and get count 0. Only the winner may
 * talk to the provider. There is no window between checking and claiming
 * because they are the same statement.
 *
 * WHY NOT A LOCK
 * A Redis or advisory lock has a lease. If the provider call outlives it — a
 * slow issuer, a 3-D Secure prompt — the lease expires while the charge is
 * still in flight and a second caller acquires it cleanly. Raising the timeout
 * moves the window rather than closing it. This state lives in the same
 * durable store as the order, so there is no lease to expire and no split
 * brain between "the lock says I own this" and what the data says.
 *
 * WHAT THIS DOES NOT COVER
 * A process that dies between claiming and hearing back leaves the order in
 * PROCESSING with a charge of unknown status. No mutual exclusion can fix that
 * — the request that knew is gone. That is what the provider's idempotency key
 * and reconcileProcessingOrders() are for.
 */
export async function claimOrderForPayment(
  userId: string,
  orderId: string
): Promise<boolean> {
  const { count } = await prisma.order.updateMany({
    where: { id: orderId, buyerId: userId, status: OrderStatus.PENDING_PAYMENT },
    data: { status: OrderStatus.PROCESSING },
  });
  return count === 1;
}

/** Hands a claim back after a definitive, no-money-moved refusal. */
export async function unclaimOrder(orderId: string) {
  await prisma.order.updateMany({
    where: { id: orderId, status: OrderStatus.PROCESSING },
    data: { status: OrderStatus.PENDING_PAYMENT },
  });
}

/** Payment succeeded: the listings are sold for good. */
export async function markOrderPaid(orderId: string) {
  /**
   * The transaction reports whether it actually moved the order to PAID.
   *
   * That boolean is what keeps the notification idempotent: webhooks are
   * delivered at least once, so this runs again for orders already paid, and
   * a second "your item sold" would be indistinguishable from a second sale.
   */
  const transitioned = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { id: true, status: true, items: { select: { listingId: true }, orderBy: { listingId: "asc" } } },
    });

    // Idempotent: webhooks are delivered at least once, so this can legitimately
    // be called twice for the same payment. The second call must be a no-op
    // rather than a second round of side effects.
    if (order.status === OrderStatus.PAID) return false;
    if (!STOCK_COMMITTED.includes(order.status)) {
      throw new OrderError("NOT_PAYABLE", "That order can no longer be paid.");
    }

    /**
     * Stock was already decremented when the hold was placed, so payment must
     * NOT touch quantity again.
     *
     * This previously forced `status: SOLD, quantity: 0` on every line. For a
     * one-of-a-kind item that happened to be right. For a listing with several
     * identical pieces it was destructive: buying one of three set quantity to
     * zero and marked the whole listing sold, deleting the other two from the
     * shop. It slipped through because every test listing had quantity 1.
     *
     * The listing is only SOLD once nothing is left. Otherwise the status is
     * left alone rather than forced back to ACTIVE — a seller may have
     * withdrawn it mid-checkout, and payment has no business resurrecting it.
     */
    for (const item of order.items) {
      if (!item.listingId) continue;
      const locked = await lockListing(tx, item.listingId);
      if (!locked) continue;

      if (locked.quantity === 0) {
        await tx.listing.update({
          where: { id: item.listingId },
          data: { status: ListingStatus.SOLD },
        });
      }
    }

    await tx.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.PAID, paidAt: new Date(), failureReason: null },
    });
    return true;
  }, TX_OPTIONS);

  /**
   * Tell the sellers, AFTER the transaction commits, and only if this call is
   * what actually paid the order.
   *
   * Outside the transaction because a notification failing must never roll back
   * a payment. Guarded by `transitioned` because a redelivered webhook would
   * otherwise send a second "your item sold", which is indistinguishable from a
   * second sale.
   */
  if (transitioned) await notifySellersOfSale(orderId);
}

async function notifySellersOfSale(orderId: string) {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        reference: true,
        buyer: { select: { name: true } },
        items: {
          select: { title: true, seller: { select: { userId: true } } },
        },
      },
    });
    if (!order) return;

    await notifyMany(
      order.items
        .filter((i) => i.seller?.userId)
        .map((i) => ({
          userId: i.seller!.userId,
          type: NotificationType.SALE_MADE,
          title: `${i.title} sold`,
          body: `${order.buyer.name} bought it. Order ${order.reference} — send it when you can.`,
          link: "/seller/sales",
        }))
    );
  } catch (err) {
    console.error(`Failed to notify sellers for order ${orderId}`, err);
  }
}

/** Payment failed or the buyer walked away: give the stock back. */
export async function releaseOrder(
  orderId: string,
  status: OrderStatus,
  reason: string | null
) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        items: { select: { listingId: true, quantity: true }, orderBy: { listingId: "asc" } },
      },
    });

    // Never claw stock back from a paid order, and never release twice.
    if (!STOCK_COMMITTED.includes(order.status)) return;

    for (const item of order.items) {
      if (!item.listingId) continue;
      const locked = await lockListing(tx, item.listingId);
      if (!locked) continue;

      await tx.listing.update({
        where: { id: item.listingId },
        data: {
          quantity: locked.quantity + item.quantity,
          // Back on sale unless it sold some other way in the meantime.
          status:
            locked.status === ListingStatus.SOLD
              ? ListingStatus.SOLD
              : ListingStatus.ACTIVE,
        },
      });
    }

    await tx.order.update({
      where: { id: orderId },
      data: { status, failureReason: reason },
    });
  }, TX_OPTIONS);
}

/**
 * Returns stock from orders nobody finished paying for.
 *
 * Necessary for the same reason the reservation sweeper is: a listing held by a
 * PENDING_PAYMENT order is hidden from the catalog, so nothing in the request
 * path will ever come along and free it.
 */
export async function releaseAbandonedOrders(): Promise<number> {
  const cutoff = new Date(Date.now() - ORDER_PAYMENT_TTL_MS);

  const stale = await prisma.order.findMany({
    where: { status: OrderStatus.PENDING_PAYMENT, createdAt: { lte: cutoff } },
    select: { id: true },
  });

  let released = 0;
  for (const order of stale) {
    try {
      await releaseOrder(order.id, OrderStatus.CANCELLED, "Payment wasn't completed in time.");
      released++;
    } catch (err) {
      console.error(`Failed to release abandoned order ${order.id}`, err);
    }
  }
  return released;
}

/**
 * Settles orders left mid-payment, by asking the provider what happened.
 *
 * A crash between claiming an order and hearing back from the provider leaves
 * PROCESSING with a charge of unknown status. Both naive options are wrong:
 * cancelling could discard a payment the buyer actually made, and reopening it
 * for payment could charge them twice. The provider is the only authority, so
 * this asks it.
 *
 * Deliberately not part of the request path — the buyer whose request died is,
 * by definition, not around to trigger it. Same lesson as the reservation
 * sweeper in ADR 0012: state that hides itself needs an out-of-band release.
 */
export async function reconcileProcessingOrders(): Promise<number> {
  const cutoff = new Date(Date.now() - ORDER_PROCESSING_TTL_MS);

  const abandonCutoff = new Date(Date.now() - ORDER_PAYMENT_TTL_MS);

  const stuck = await prisma.order.findMany({
    where: { status: OrderStatus.PROCESSING, updatedAt: { lte: cutoff } },
    select: { id: true, reference: true, paymentIntentId: true, createdAt: true },
  });

  let settled = 0;

  for (const order of stuck) {
    try {
      if (!order.paymentIntentId) {
        // Claimed before an intent existed, so nothing can have been charged.
        await unclaimOrder(order.id);
        settled++;
        continue;
      }

      const intent = await getIntent(order.paymentIntentId);

      if (!intent) {
        // The provider has no record, so no charge exists. In stub mode this is
        // also what a process restart looks like, since its state is in memory.
        console.warn(
          `Order ${order.reference}: provider has no record of ${order.paymentIntentId}; reopening for payment.`
        );
        await unclaimOrder(order.id);
        settled++;
        continue;
      }

      if (intent.outcome.status === "succeeded") {
        // The charge went through and we never recorded it. This is the case
        // that makes reconciliation worth building.
        console.warn(`Order ${order.reference}: charge succeeded but was unrecorded. Settling as paid.`);
        await markOrderPaid(order.id);
        settled++;
      } else if (intent.outcome.status === "failed") {
        await releaseOrder(order.id, OrderStatus.FAILED, intent.outcome.reason);
        settled++;
      } else if (order.createdAt <= abandonCutoff) {
        /**
         * Still pending well past the payment window — an abandoned 3-D Secure
         * prompt, most likely. The stock has to come back, but releasing it
         * alone would be a bug: the intent is still confirmable, so the buyer
         * could complete authentication later and pay for an item we had
         * already resold. Cancel at the provider FIRST, then release.
         *
         * Without this branch, PROCESSING is a third state that commits stock
         * and hides the listing with nothing able to free it — the same
         * deadlock as ADR 0012, for the third time in this codebase.
         */
        await cancelIntent({
          intentId: order.paymentIntentId,
          idempotencyKey: `retailstore-2n:order:${order.id}:cancel`,
        });
        await releaseOrder(
          order.id,
          OrderStatus.CANCELLED,
          "Payment wasn't completed in time."
        );
        settled++;
      }
      // Otherwise still pending inside the window: 3-D Secure and async methods
      // legitimately take a while, and the webhook will resolve it.
    } catch (err) {
      // One unresolvable order must not stop the rest of the sweep.
      console.error(`Failed to reconcile order ${order.id}`, err);
    }
  }

  return settled;
}

/** Runs both order sweeps on an interval. Returns a stop function. */
export function startOrderSweeper(intervalMs = 60_000) {
  async function tick() {
    try {
      const released = await releaseAbandonedOrders();
      if (released > 0) console.log(`Released ${released} abandoned order(s)`);
    } catch (err) {
      console.error("Abandoned-order sweep failed", err);
    }
    try {
      const settled = await reconcileProcessingOrders();
      if (settled > 0) console.log(`Reconciled ${settled} in-flight payment(s)`);
    } catch (err) {
      console.error("Payment reconciliation failed", err);
    }
  }

  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Looks an order up by its provider payment reference. Used by the webhook,
 * which knows the intent but not our order id.
 */
export async function findOrderByIntentId(intentId: string) {
  return prisma.order.findUnique({
    where: { paymentIntentId: intentId },
    select: { id: true, reference: true, status: true, buyerId: true },
  });
}

export async function getOrder(userId: string, orderId: string) {
  return prisma.order.findFirst({
    // Scoped by buyer, and 404 rather than 403 for someone else's order.
    where: { id: orderId, buyerId: userId },
    select: orderSelect,
  });
}

export async function listOrders(userId: string) {
  return prisma.order.findMany({
    where: { buyerId: userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: orderSelect,
  });
}
