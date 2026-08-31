import { prisma } from "./prisma";
import { events } from "./notifications";
import { refundUnfulfillableLine } from "./refunds";
import { FulfilmentStatus, OrderStatus, RefundStatus } from "../generated/prisma/enums";

/**
 * What a seller has sold, and sending it.
 *
 * WHY THIS DID NOT EXIST
 * Order lines carried a `sellerName` string and nothing else, so there was no
 * way to ask "what did I sell?". Someone could buy a chair and the seller would
 * never be told, never see it, and never be able to act on it. The marketplace
 * loop was open at exactly the point where a real transaction begins.
 *
 * ONLY ORDERS WHERE MONEY MOVED
 * A seller sees a line once the money has actually moved. Showing them a
 * PENDING_PAYMENT order would have them packing parcels for checkouts that get
 * abandoned — and roughly half of all abandoned carts sit in that state until a
 * sweeper releases them.
 *
 * That USED to mean status PAID alone, which was right when PAID was the only
 * post-payment state. It is not any more: a fully refunded order becomes
 * REFUNDED, and filtering on PAID made those sales disappear from the seller's
 * list, their summary, and their totals as though the transaction had never
 * happened. They need to see it, marked refunded.
 *
 * VISIBILITY AND EARNINGS ARE DIFFERENT QUESTIONS
 * A refunded line is still a sale that happened, so it is visible. It is not
 * money the seller keeps, so it is excluded from soldCount and grossCents.
 * Conflating the two would either hide history or inflate earnings, and both
 * are worse than carrying two filters.
 */

/**
 * Order states in which the money moved, so the seller has a real sale.
 *
 * One constant rather than six copies of the same array: this filter appears in
 * every seller-facing query, and a single site left on PAID alone is a sale that
 * silently vanishes from one screen but not the others.
 */
const SETTLED = { in: [OrderStatus.PAID, OrderStatus.REFUNDED] };

export class SalesError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "SalesError";
    this.code = code;
    this.status = status;
  }
}

const saleSelect = {
  id: true,
  title: true,
  unitPriceCents: true,
  quantity: true,
  fulfilment: true,
  shippedAt: true,
  deliveredAt: true,
  carrier: true,
  trackingNumber: true,
  fulfilmentNote: true,
  listing: {
    select: {
      slug: true,
      images: { take: 1, orderBy: { position: "asc" as const }, select: { url: true } },
    },
  },
  order: {
    select: {
      id: true,
      reference: true,
      currency: true,
      paidAt: true,
      createdAt: true,
      buyer: { select: { name: true } },
      shipToName: true,
      shipToLine1: true,
      shipToLine2: true,
      shipToCity: true,
      shipToRegion: true,
      shipToPostcode: true,
      shipToCountry: true,
      shipToPhone: true,
    },
  },
} as const;

type SaleRow = Awaited<ReturnType<typeof fetchSales>>[number];

function fetchSales(sellerId: string, where: object, take: number) {
  return prisma.orderItem.findMany({
    where: { sellerId, order: { status: SETTLED }, ...where },
    // Oldest paid first: the thing waiting longest is the thing to post next.
    orderBy: { order: { paidAt: "asc" } },
    take,
    select: saleSelect,
  });
}

function serialize(row: SaleRow, refunded = false) {
  const o = row.order;
  return {
    id: row.id,
    title: row.title,
    unitPriceCents: row.unitPriceCents,
    quantity: row.quantity,
    currency: o.currency,
    slug: row.listing?.slug ?? null,
    image: row.listing?.images[0]?.url ?? null,

    /**
     * Whether the money for THIS line has gone back.
     *
     * Separate from `fulfilment`, and both are needed. A seller can mark a line
     * unfulfillable — which refunds it — but a moderator can also refund a line
     * that shipped and arrived, after a dispute. So DELIVERED and refunded is a
     * real combination, and inferring one from the other would misreport it.
     *
     * Without this the seller sees the line at its full price in a list, learns
     * nothing, and the summary's totals silently disagree with it — the totals
     * exclude refunded lines, as they should, so the rows would add up to more
     * than the figure above them with no explanation on screen.
     */
    refunded,

    order: {
      id: o.id,
      reference: o.reference,
      buyerName: o.buyer.name,
      paidAt: o.paidAt ? o.paidAt.toISOString() : null,
      placedAt: o.createdAt.toISOString(),
    },

    fulfilment: row.fulfilment,
    shippedAt: row.shippedAt ? row.shippedAt.toISOString() : null,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    carrier: row.carrier,
    trackingNumber: row.trackingNumber,
    fulfilmentNote: row.fulfilmentNote,

    /**
     * The buyer's address, released only once the order is PAID — which the
     * query above enforces. A seller has no business seeing where someone
     * lives before they have bought anything.
     */
    shipTo: o.shipToLine1
      ? {
          fullName: o.shipToName,
          line1: o.shipToLine1,
          line2: o.shipToLine2,
          city: o.shipToCity,
          region: o.shipToRegion,
          postcode: o.shipToPostcode,
          country: o.shipToCountry,
          phone: o.shipToPhone,
        }
      : null,
  };
}

export type SaleView = ReturnType<typeof serialize>;

export async function listSales(
  sellerId: string,
  filter: "all" | "to_send" | "sent" = "all",
  take = 100
) {
  const where =
    filter === "to_send"
      ? { fulfilment: FulfilmentStatus.UNFULFILLED }
      : filter === "sent"
        ? { fulfilment: { in: [FulfilmentStatus.SHIPPED, FulfilmentStatus.DELIVERED] } }
        : {};

  // Fetched alongside the rows rather than per row: one query for the whole
  // page instead of N, and it is the same helper the summary counts with, so
  // the list and the totals above it cannot disagree about what "refunded"
  // means.
  const [rows, refundedIds] = await Promise.all([
    fetchSales(sellerId, where, take),
    refundedLines(sellerId),
  ]);

  return rows.map((row) => serialize(row, refundedIds.has(row.id)));
}

/** Counts for the dashboard tabs, so a seller sees what needs doing. */
export async function salesSummary(sellerId: string) {
  const base = { sellerId, order: { status: SETTLED } };

  const [toSend, shipped, delivered, lines, refundedLineIds] = await Promise.all([
    prisma.orderItem.count({ where: { ...base, fulfilment: FulfilmentStatus.UNFULFILLED } }),
    prisma.orderItem.count({ where: { ...base, fulfilment: FulfilmentStatus.SHIPPED } }),
    prisma.orderItem.count({ where: { ...base, fulfilment: FulfilmentStatus.DELIVERED } }),
    prisma.orderItem.findMany({
      where: base,
      select: { id: true, unitPriceCents: true, quantity: true },
    }),
    refundedLines(sellerId),
  ]);

  const kept = lines.filter((l) => !refundedLineIds.has(l.id));

  return {
    toSend,
    shipped,
    delivered,
    /**
     * Refunded lines are counted separately, and left out of the two figures
     * below.
     *
     * A sale whose money went back is not something the seller sold, and it is
     * certainly not something they earned. Including it would make the totals
     * on this page disagree with their bank in the one direction nobody wants
     * to discover late.
     */
    refunded: refundedLineIds.size,
    soldCount: kept.length,
    /**
     * Gross, before any fee, and net of refunds. Named so nobody mistakes it
     * for a payout balance — there is no payout pipeline, and calling this
     * "earnings" would imply money is waiting somewhere for them.
     */
    grossCents: kept.reduce((sum, r) => sum + r.unitPriceCents * r.quantity, 0),
  };
}

/**
 * The seller's line ids that have money going back.
 *
 * PENDING counts as refunded. A refund in flight is money leaving; treating it
 * as still-earned until it settles would show a figure that is about to be
 * wrong, and the seller would see it drop for no visible reason.
 */
async function refundedLines(sellerId: string): Promise<Set<string>> {
  const rows = await prisma.refund.findMany({
    where: {
      status: { in: [RefundStatus.PENDING, RefundStatus.SUCCEEDED] },
      orderItemId: { not: null },
      order: { items: { some: { sellerId } } },
    },
    select: { orderItemId: true },
  });

  // Filtered again by seller: the query above matches refunds on any ORDER that
  // contains one of this seller's lines, which in a multi-seller basket
  // includes somebody else's refunded line.
  const ids = rows.map((r) => r.orderItemId!).filter(Boolean);
  if (ids.length === 0) return new Set();

  const mine = await prisma.orderItem.findMany({
    where: { id: { in: ids }, sellerId },
    select: { id: true },
  });
  return new Set(mine.map((m) => m.id));
}

/** One sale, scoped to its seller. */
export async function getSale(sellerId: string, orderItemId: string) {
  const row = await prisma.orderItem.findFirst({
    where: { id: orderItemId, sellerId, order: { status: SETTLED } },
    select: saleSelect,
  });
  if (!row) return null;

  // Asked for even though it is one line: `serialize` defaults `refunded` to
  // false, and a default that quietly reports a refunded line as not refunded
  // is worse than not having the field. One extra query on a single-row read.
  const refundedIds = await refundedLines(sellerId);
  return serialize(row, refundedIds.has(row.id));
}

/**
 * Marks a line as sent.
 *
 * Scoped by sellerId in the same query that finds it, so one seller can never
 * fulfil another's line — and a 404 rather than a 403, so probing tells them
 * nothing.
 */
export async function markShipped(input: {
  sellerId: string;
  orderItemId: string;
  carrier?: string | null;
  trackingNumber?: string | null;
}) {
  const line = await prisma.orderItem.findFirst({
    where: { id: input.orderItemId, sellerId: input.sellerId, order: { status: SETTLED } },
    select: { id: true, fulfilment: true },
  });
  if (!line) throw new SalesError("NOT_FOUND", "Sale not found.", 404);

  if (line.fulfilment === FulfilmentStatus.SHIPPED) {
    // Idempotent: a double-tapped button should update the tracking number, not
    // complain.
    return prisma.orderItem.update({
      where: { id: line.id },
      data: {
        carrier: input.carrier?.trim() || null,
        trackingNumber: input.trackingNumber?.trim() || null,
      },
      select: saleSelect,
    }).then(serialize);
  }

  if (line.fulfilment !== FulfilmentStatus.UNFULFILLED) {
    throw new SalesError(
      "NOT_SHIPPABLE",
      line.fulfilment === FulfilmentStatus.DELIVERED
        ? "That's already been delivered."
        : "That sale can no longer be shipped.",
      409
    );
  }

  const updated = await prisma.orderItem.update({
    where: { id: line.id },
    data: {
      fulfilment: FulfilmentStatus.SHIPPED,
      shippedAt: new Date(),
      carrier: input.carrier?.trim() || null,
      trackingNumber: input.trackingNumber?.trim() || null,
      fulfilmentNote: null,
    },
    select: { ...saleSelect, order: { select: { ...saleSelect.order.select, buyerId: true } } },
  });

  // Best-effort and after the write: telling the buyer must never be able to
  // undo the shipment being recorded.
  void events.orderShipped({
    buyerUserId: updated.order.buyerId,
    itemTitle: updated.title,
    orderId: updated.order.id,
    carrier: updated.carrier,
    trackingNumber: updated.trackingNumber,
  });

  return serialize(updated);
}

/**
 * The buyer confirms arrival.
 *
 * Deliberately the BUYER's action, not the seller's. A seller marking their own
 * parcel delivered is not evidence of anything — and this is now load-bearing
 * rather than hypothetical: `deliveredAt` starts the payout hold, so the moment
 * this is called is the moment a seller's money begins counting down.
 * See ADR 0030.
 */
export async function markDelivered(buyerId: string, orderItemId: string) {
  const line = await prisma.orderItem.findFirst({
    where: {
      id: orderItemId,
      order: { buyerId, status: SETTLED },
    },
    select: {
      id: true,
      fulfilment: true,
      title: true,
      seller: { select: { userId: true } },
    },
  });
  if (!line) throw new SalesError("NOT_FOUND", "Item not found.", 404);

  if (line.fulfilment === FulfilmentStatus.DELIVERED) return; // idempotent
  if (line.fulfilment !== FulfilmentStatus.SHIPPED) {
    throw new SalesError("NOT_SHIPPED", "That hasn't been sent yet.", 409);
  }

  await prisma.orderItem.update({
    where: { id: line.id },
    data: { fulfilment: FulfilmentStatus.DELIVERED, deliveredAt: new Date() },
  });

  if (line.seller?.userId) {
    void events.orderDelivered({
      sellerUserId: line.seller.userId,
      itemTitle: line.title,
    });
  }
}

/** The seller cannot send it after all. */
export async function markUnfulfillable(input: {
  sellerId: string;
  orderItemId: string;
  reason: string;
}) {
  const line = await prisma.orderItem.findFirst({
    where: { id: input.orderItemId, sellerId: input.sellerId, order: { status: SETTLED } },
    select: {
      id: true,
      fulfilment: true,
      title: true,
      order: { select: { id: true, buyerId: true } },
    },
  });
  if (!line) throw new SalesError("NOT_FOUND", "Sale not found.", 404);

  if (line.fulfilment === FulfilmentStatus.DELIVERED) {
    throw new SalesError("ALREADY_DELIVERED", "That's already been delivered.", 409);
  }

  /**
   * Already marked, so stop here.
   *
   * Without this the second attempt fell through to the refund helper, which
   * correctly declined to pay twice — but the seller got "Sale not found" from
   * a later lookup, which is both wrong and alarming. Saying plainly that it is
   * already done is the honest answer.
   */
  if (line.fulfilment === FulfilmentStatus.UNFULFILLABLE) {
    throw new SalesError(
      "ALREADY_UNFULFILLABLE",
      "You've already told the buyer this can't be sent. They've been refunded.",
      409
    );
  }

  const reason = input.reason.trim();
  if (!reason) {
    throw new SalesError("REASON_REQUIRED", "Tell the buyer why.", 400);
  }

  await prisma.orderItem.update({
    where: { id: line.id },
    data: {
      fulfilment: FulfilmentStatus.UNFULFILLABLE,
      fulfilmentNote: reason,
      shippedAt: null,
    },
  });


  /**
   * REFUNDED HERE, AUTOMATICALLY.
   *
   * The buyer paid for something they will not receive. Nobody should have to
   * ask for that back — they did their part, and making them chase it is how a
   * marketplace earns a reputation. This used to return a flag saying a refund
   * was owed, and nothing settled it.
   *
   * Failures do NOT roll back the unfulfillable mark. The item genuinely is not
   * coming and the buyer needs to know that regardless; a refund that could not
   * be issued is recorded as a FAILED row for a person to pick up, which is
   * strictly better than pretending the line is still fulfillable.
   */
  let refund: Awaited<ReturnType<typeof refundUnfulfillableLine>> = null;
  let refundError: string | null = null;
  try {
    refund = await refundUnfulfillableLine({ orderItemId: line.id, reason });
  } catch (err) {
    refundError = err instanceof Error ? err.message : "The refund could not be issued.";
    console.error(`[sales] refund failed for order item ${line.id}:`, err);
  }

  // Told after the attempt, so the wording can reflect what actually happened
  // rather than what was hoped for.
  void events.orderUnfulfillable({
    buyerUserId: line.order.buyerId,
    itemTitle: line.title,
    orderId: line.order.id,
    reason,
    refunded: refund !== null,
  });

  return {
    refunded: refund !== null,
    refundCents: refund?.amountCents ?? 0,
    refundStatus: refund?.status ?? null,
    refundError,
  };
}
