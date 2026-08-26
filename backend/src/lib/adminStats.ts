import { z } from "zod";
import { prisma } from "./prisma";
import {
  OrderStatus,
  ListingStatus,
  PayoutStatus,
  RefundStatus,
  ReportStatus,
  ReturnStatus,
} from "../generated/prisma/enums";
import type { DeliveryChannel, DeliveryStatus } from "../generated/prisma/enums";

/**
 * Read-only queries behind the admin dashboard.
 *
 * Everything here is a SELECT. Nothing in this file changes state — the actions
 * live in moderation.ts, where each one writes an audit row. Keeping the two
 * apart means a dashboard query can never quietly become a dashboard action.
 *
 * ON THE WORD "REVENUE"
 * ---------------------
 * It does not appear here, and that is deliberate. RetailStore_2n takes no cut, so
 * every cent counted below belongs to a seller, not to the platform. Labelling
 * it revenue would make the headline number on the dashboard a lie — the kind
 * that survives right up until someone forecasts against it. It is called gross
 * sales throughout: money that moved through the site.
 */

export type Range = 7 | 30 | 90;

/** A page of rows, in the one shape every list endpoint returns. */
export type Page<T> = {
  rows: T[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
};

const PAGE_SIZE = 25;

function paginate(page: number, total: number) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  return { skip: (current - 1) * PAGE_SIZE, page: current, pages, pageSize: PAGE_SIZE };
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

/* ================================================================== *
 * Headline metrics
 * ================================================================== */

type Totals = { grossCents: number; orders: number; buyers: number };

async function totalsBetween(from: Date, to: Date): Promise<Totals> {
  const rows = await prisma.$queryRaw<
    Array<{ cents: bigint; orders: bigint; buyers: bigint }>
  >`
    SELECT
      COALESCE(SUM("subtotalCents"), 0)::bigint AS cents,
      COUNT(*)::bigint                          AS orders,
      COUNT(DISTINCT "buyerId")::bigint         AS buyers
    FROM orders
    WHERE status = 'PAID' AND "paidAt" >= ${from} AND "paidAt" < ${to}
  `;
  const r = rows[0];
  return {
    grossCents: Number(r?.cents ?? 0),
    orders: Number(r?.orders ?? 0),
    buyers: Number(r?.buyers ?? 0),
  };
}

/**
 * Percentage change, or null when there is nothing to compare against.
 *
 * Null rather than 0 or 100: a period with no prior sales has no meaningful
 * change, and rendering "+100%" against zero is how dashboards manufacture
 * good news. The frontend shows a dash.
 */
function delta(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/**
 * The daily series for the chart.
 *
 * Days with no orders are filled in as zero. Without that, Postgres returns
 * only the days that had sales and the chart draws a smooth line across a
 * fortnight of silence — the gap is exactly the thing worth seeing.
 */
async function dailySeries(days: number) {
  const from = daysAgo(days - 1);
  const rows = await prisma.$queryRaw<Array<{ day: Date; cents: bigint; orders: bigint }>>`
    SELECT
      date_trunc('day', "paidAt")               AS day,
      COALESCE(SUM("subtotalCents"), 0)::bigint AS cents,
      COUNT(*)::bigint                          AS orders
    FROM orders
    WHERE status = 'PAID' AND "paidAt" >= ${from}
    GROUP BY 1
    ORDER BY 1
  `;

  const byDay = new Map(
    rows.map((r) => [
      new Date(r.day).toISOString().slice(0, 10),
      { cents: Number(r.cents), orders: Number(r.orders) },
    ])
  );

  const series: Array<{ date: string; grossCents: number; orders: number }> = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const hit = byDay.get(key);
    series.push({ date: key, grossCents: hit?.cents ?? 0, orders: hit?.orders ?? 0 });
  }
  return series;
}

/**
 * Money sent back in a window.
 *
 * PENDING counts alongside SUCCEEDED. A refund in flight is money leaving, and
 * excluding it would show a figure that is about to be wrong. FAILED does not
 * count — that money never left.
 */
async function refundedBetween(from: Date, to: Date): Promise<number> {
  const agg = await prisma.refund.aggregate({
    where: {
      status: { in: [RefundStatus.PENDING, RefundStatus.SUCCEEDED] },
      createdAt: { gte: from, lt: to },
    },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents ?? 0;
}

/**
 * DELIBERATELY NOT CACHED, having been tried.
 *
 * These are the most expensive queries on the site — two windowed sums over
 * every paid order, a daily series, two user counts, two refund totals — which
 * makes them look like the obvious thing to cache. They are not, for two
 * reasons that only became clear once it was wired up.
 *
 * The first is that there is nothing to relieve. A cache earns its place
 * against LOAD, not against cost-per-query, and this page has one user opening
 * it a few times a day. Saving a handful of queries buys nothing.
 *
 * The second is what it costs. Its inputs are every order and refund on the
 * platform, so nothing short of invalidating on every payment would keep it
 * honest — which puts dashboard bookkeeping inside the checkout path. The
 * alternative, a plain TTL, means the dashboard quietly disagrees with the
 * database: tests/browser/admin-dashboard.ts caught exactly that, reading
 * $65 in gross sales while the database held $95.22.
 *
 * A moderator deciding whether to refund somebody needs the real number.
 */
export async function metrics(days: Range) {
  const now = new Date();
  const periodStart = daysAgo(days - 1);
  const priorStart = daysAgo(days * 2 - 1);

  const [current, prior, series, newUsers, priorNewUsers, refunded, priorRefunded] =
    await Promise.all([
      totalsBetween(periodStart, now),
      totalsBetween(priorStart, periodStart),
      dailySeries(days),
      prisma.user.count({ where: { createdAt: { gte: periodStart } } }),
      prisma.user.count({ where: { createdAt: { gte: priorStart, lt: periodStart } } }),
      refundedBetween(periodStart, now),
      refundedBetween(priorStart, periodStart),
    ]);

  // Average order value, in cents. Guarded because a period with no orders
  // would otherwise divide by zero and render NaN on the dashboard.
  const aov = current.orders > 0 ? Math.round(current.grossCents / current.orders) : 0;
  const priorAov = prior.orders > 0 ? Math.round(prior.grossCents / prior.orders) : 0;

  return {
    days,
    grossCents: current.grossCents,
    orders: current.orders,
    buyers: current.buyers,
    aovCents: aov,
    newUsers,
    /**
     * Shown alongside gross rather than subtracted from it.
     *
     * A fully refunded order leaves the PAID set and drops out of gross on its
     * own. A PARTLY refunded one stays PAID, so its whole subtotal is still
     * counted — which would quietly overstate the figure. Reporting both lets
     * the reader do the subtraction knowingly instead of being handed a net
     * number that hides how much came back.
     */
    refundedCents: refunded,
    deltas: {
      gross: delta(current.grossCents, prior.grossCents),
      orders: delta(current.orders, prior.orders),
      aov: delta(aov, priorAov),
      newUsers: delta(newUsers, priorNewUsers),
      refunded: delta(refunded, priorRefunded),
    },
    series,
  };
}

/* ================================================================== *
 * What needs a human
 * ================================================================== */

/**
 * The queue behind the dashboard's "Needs attention" panel.
 *
 * Each entry is something a person has to decide about. Counts that are merely
 * interesting — total users, total listings — are not here; they belong in the
 * stat row where nobody feels obliged to act on them.
 */
export async function attention() {
  const staleAfter = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

  const [openReports, unfulfilled, stuck, failedPayments, rejectedKyc, escalatedReturns] =
    await Promise.all([
    prisma.report.count({ where: { status: ReportStatus.OPEN } }),
    prisma.orderItem.count({
      where: { fulfilment: "UNFULFILLED", order: { status: OrderStatus.PAID, paidAt: { lt: staleAfter } } },
    }),
    // An order left mid-payment. The sweeper reconciles these, so a non-zero
    // count that persists means the sweeper is not running.
    prisma.order.count({
      where: { status: OrderStatus.PROCESSING, updatedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) } },
    }),
    prisma.order.count({
      where: { status: OrderStatus.FAILED, createdAt: { gte: daysAgo(7) } },
    }),
    prisma.sellerProfile.count({ where: { kycStatus: "REJECTED" } }),
    /**
     * A buyer disputed a seller's refusal, and only a moderator can settle it.
     * Belongs here rather than only on the returns page: nothing else in the
     * system will ever move it, and a person is waiting on the answer. There is
     * no timer that resolves these — by design, since there is no scheduler.
     */
    prisma.returnRequest.count({ where: { status: ReturnStatus.ESCALATED } }),
  ]);

  return {
    openReports,
    unfulfilledOver3Days: unfulfilled,
    stuckPayments: stuck,
    failedPayments,
    rejectedKyc,
    escalatedReturns,
  };
}

/* ================================================================== *
 * Orders
 * ================================================================== */

export async function listOrders(opts: {
  q?: string;
  status?: OrderStatus | "ALL";
  page?: number;
}): Promise<Page<Awaited<ReturnType<typeof shapeOrder>>>> {
  const where = {
    ...(opts.status && opts.status !== "ALL" ? { status: opts.status } : {}),
    ...(opts.q
      ? {
          OR: [
            { reference: { contains: opts.q, mode: "insensitive" as const } },
            { buyer: { email: { contains: opts.q, mode: "insensitive" as const } } },
            { buyer: { name: { contains: opts.q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const total = await prisma.order.count({ where });
  const { skip, page, pages, pageSize } = paginate(opts.page ?? 1, total);

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip,
    take: pageSize,
    include: {
      buyer: { select: { id: true, name: true, email: true } },
      items: { select: { id: true, quantity: true, fulfilment: true } },
    },
  });

  return { rows: orders.map(shapeOrder), total, page, pages, pageSize };
}

function shapeOrder(o: {
  id: string;
  reference: string;
  status: OrderStatus;
  subtotalCents: number;
  currency: string;
  createdAt: Date;
  paidAt: Date | null;
  buyer: { id: string; name: string; email: string };
  items: Array<{ id: string; quantity: number; fulfilment: string }>;
}) {
  const units = o.items.reduce((n, i) => n + i.quantity, 0);
  const shipped = o.items.filter((i) => i.fulfilment !== "UNFULFILLED").length;
  return {
    id: o.id,
    reference: o.reference,
    status: o.status,
    subtotalCents: o.subtotalCents,
    currency: o.currency,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    buyerId: o.buyer.id,
    buyerName: o.buyer.name,
    buyerEmail: o.buyer.email,
    lines: o.items.length,
    units,
    fulfilledLines: shipped,
  };
}

export async function orderDetail(id: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      buyer: { select: { id: true, name: true, email: true, createdAt: true, suspendedAt: true } },
      items: {
        include: {
          listing: { select: { id: true, slug: true, title: true, status: true, deletedAt: true } },
          seller: { select: { id: true, shopName: true, userId: true } },
        },
      },
    },
  });
  if (!order) return null;

  return {
    id: order.id,
    reference: order.reference,
    status: order.status,
    subtotalCents: order.subtotalCents,
    currency: order.currency,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    failureReason: order.failureReason,
    // The provider's id, not card data — there is none of that here to show.
    // See docs/adr/0013-payment-provider-seam.md
    paymentProvider: order.paymentProvider,
    paymentIntentId: order.paymentIntentId,
    buyer: order.buyer,
    shipTo: order.shipToLine1
      ? {
          name: order.shipToName,
          line1: order.shipToLine1,
          line2: order.shipToLine2,
          city: order.shipToCity,
          region: order.shipToRegion,
          postcode: order.shipToPostcode,
          country: order.shipToCountry,
          phone: order.shipToPhone,
        }
      : null,
    items: order.items.map((i) => ({
      id: i.id,
      title: i.title,
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
      sellerName: i.sellerName,
      sellerUserId: i.seller?.userId ?? null,
      fulfilment: i.fulfilment,
      carrier: i.carrier,
      trackingNumber: i.trackingNumber,
      fulfilmentNote: i.fulfilmentNote,
      shippedAt: i.shippedAt,
      deliveredAt: i.deliveredAt,
      listingId: i.listing?.id ?? null,
      listingSlug: i.listing?.slug ?? null,
      // True when the line's product no longer exists. The order still shows
      // what was bought because the title and price were snapshotted onto it.
      listingGone: !i.listing || i.listing.deletedAt !== null,
    })),
  };
}

/* ================================================================== *
 * Customers
 * ================================================================== */

export async function listCustomers(opts: {
  q?: string;
  filter?: "ALL" | "SELLERS" | "SUSPENDED" | "ADMINS";
  page?: number;
}) {
  const where = {
    ...(opts.filter === "SELLERS" ? { isSeller: true } : {}),
    ...(opts.filter === "SUSPENDED" ? { suspendedAt: { not: null } } : {}),
    ...(opts.filter === "ADMINS" ? { role: "ADMIN" as const } : {}),
    ...(opts.q
      ? {
          OR: [
            { email: { contains: opts.q, mode: "insensitive" as const } },
            { name: { contains: opts.q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const total = await prisma.user.count({ where });
  const { skip, page, pages, pageSize } = paginate(opts.page ?? 1, total);

  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip,
    take: pageSize,
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
      isSeller: true,
      emailVerified: true,
      role: true,
      suspendedAt: true,
      suspendedReason: true,
      _count: { select: { orders: true } },
    },
  });

  return {
    rows: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      createdAt: u.createdAt,
      isSeller: u.isSeller,
      emailVerified: u.emailVerified,
      role: u.role,
      suspendedAt: u.suspendedAt,
      suspendedReason: u.suspendedReason,
      orders: u._count.orders,
    })),
    total,
    page,
    pages,
    pageSize,
  };
}

export async function customerDetail(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
      isSeller: true,
      emailVerified: true,
      role: true,
      avatarUrl: true,
      suspendedAt: true,
      suspendedReason: true,
      sellerProfile: {
        select: {
          id: true,
          shopName: true,
          kycStatus: true,
          payoutsEnabled: true,
          _count: { select: { listings: true, sales: true } },
        },
      },
    },
  });
  if (!user) return null;

  const [orders, spend, reportsAgainst] = await Promise.all([
    prisma.order.findMany({
      where: { buyerId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, reference: true, status: true, subtotalCents: true, createdAt: true },
    }),
    prisma.order.aggregate({
      where: { buyerId: id, status: OrderStatus.PAID },
      _sum: { subtotalCents: true },
      _count: true,
    }),
    prisma.report.count({ where: { targetType: "USER", targetId: id } }),
  ]);

  return {
    ...user,
    lifetimeSpendCents: spend._sum.subtotalCents ?? 0,
    paidOrders: spend._count,
    recentOrders: orders,
    reportsAgainst,
  };
}

/* ================================================================== *
 * Catalogue
 * ================================================================== */

export async function listCatalogue(opts: {
  q?: string;
  status?: ListingStatus | "ALL" | "REMOVED";
  page?: number;
}) {
  const where = {
    ...(opts.status === "REMOVED"
      ? { deletedAt: { not: null } }
      : opts.status && opts.status !== "ALL"
        ? { status: opts.status, deletedAt: null }
        : {}),
    ...(opts.q
      ? {
          OR: [
            { title: { contains: opts.q, mode: "insensitive" as const } },
            { seller: { shopName: { contains: opts.q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const total = await prisma.listing.count({ where });
  const { skip, page, pages, pageSize } = paginate(opts.page ?? 1, total);

  const listings = await prisma.listing.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip,
    take: pageSize,
    select: {
      id: true,
      slug: true,
      title: true,
      priceCents: true,
      currency: true,
      quantity: true,
      status: true,
      deletedAt: true,
      createdAt: true,
      condition: true,
      seller: { select: { id: true, shopName: true, userId: true } },
      category: { select: { title: true } },
      images: { select: { url: true }, take: 1, orderBy: { position: "asc" } },
      _count: { select: { reviews: true, orderItems: true } },
    },
  });

  return {
    rows: listings.map((l) => ({
      id: l.id,
      slug: l.slug,
      title: l.title,
      priceCents: l.priceCents,
      currency: l.currency,
      quantity: l.quantity,
      status: l.status,
      removed: l.deletedAt !== null,
      createdAt: l.createdAt,
      condition: l.condition,
      sellerName: l.seller.shopName,
      sellerUserId: l.seller.userId,
      category: l.category.title,
      image: l.images[0]?.url ?? null,
      reviews: l._count.reviews,
      sold: l._count.orderItems,
    })),
    total,
    page,
    pages,
    pageSize,
  };
}

/* ================================================================== *
 * Recent activity, for the dashboard
 * ================================================================== */

export async function recentOrders(limit = 8) {
  const orders = await prisma.order.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      buyer: { select: { id: true, name: true, email: true } },
      items: { select: { id: true, quantity: true, fulfilment: true } },
    },
  });
  return orders.map(shapeOrder);
}

/**
 * Sellers ranked by what they actually sold, not by what they listed.
 *
 * Only PAID orders count. Counting held or failed ones would put a seller with
 * an abandoned basket above one with a real sale.
 */
export async function topSellers(days: Range, limit = 5) {
  const from = daysAgo(days - 1);
  const rows = await prisma.$queryRaw<
    Array<{ sellerId: string; shopName: string; userId: string; cents: bigint; units: bigint }>
  >`
    SELECT
      sp.id                                                   AS "sellerId",
      sp."shopName"                                           AS "shopName",
      sp."userId"                                             AS "userId",
      COALESCE(SUM(oi."unitPriceCents" * oi.quantity), 0)::bigint AS cents,
      COALESCE(SUM(oi.quantity), 0)::bigint                   AS units
    FROM order_items oi
    JOIN orders o        ON o.id = oi."orderId"
    JOIN seller_profiles sp ON sp.id = oi."sellerId"
    WHERE o.status = 'PAID' AND o."paidAt" >= ${from}
    GROUP BY sp.id, sp."shopName", sp."userId"
    ORDER BY cents DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    sellerId: r.sellerId,
    shopName: r.shopName,
    userId: r.userId,
    grossCents: Number(r.cents),
    units: Number(r.units),
  }));
}

/* ------------------------------------------------------------------ *
 * The delivery ledger
 * ------------------------------------------------------------------ */

/**
 * "Did the buyer actually get the refund email?"
 *
 * That is a real support question, asked often, and until this existed the only
 * way to answer it was a database console — which means in practice it was
 * answered by guessing, or by resending and hoping.
 *
 * SEARCHES BY THE THINGS SOMEBODY ACTUALLY HAS. A support conversation starts
 * with an email address, occasionally with an order id pasted out of a
 * notification link. It never starts with an eventId, so searching by email or
 * name has to work, and the eventId is accepted only because it is what an
 * engineer looking at a DLQ entry will have.
 *
 * The row carries WHY, not just what: `suppressReason` for a channel the
 * recipient turned off, `lastError` for a provider that refused, `notBefore`
 * for something quiet hours parked. An answer of "FAILED" with no reason sends
 * the person straight back to the database.
 */
export async function listDeliveries(opts: {
  q?: string;
  channel?: "ALL" | DeliveryChannel;
  status?: "ALL" | DeliveryStatus;
  page?: number;
}) {
  const q = opts.q?.trim();

  /**
   * An email or name has to become a set of user ids first, because the ledger
   * has no relation to `users` — `userId` is a plain column so a delivery
   * record outlives the account it was for.
   *
   * Only a UUID skips that lookup. Testing for a bare "-" also skipped it for
   * every email with a hyphenated domain, so those people could not be found.
   */
  let userIds: string[] | undefined;
  if (q && !z.string().uuid().safeParse(q).success) {
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { id: true },
      take: 200,
    });
    userIds = users.map((u) => u.id);
  }

  const where = {
    ...(opts.channel && opts.channel !== "ALL" ? { channel: opts.channel } : {}),
    ...(opts.status && opts.status !== "ALL" ? { status: opts.status } : {}),
    ...(q
      ? {
          OR: [
            { eventId: q },
            { userId: q },
            { notificationId: q },
            ...(userIds && userIds.length > 0 ? [{ userId: { in: userIds } }] : []),
          ],
        }
      : {}),
  };

  const total = await prisma.notificationDelivery.count({ where });
  const { skip, page, pages, pageSize } = paginate(opts.page ?? 1, total);

  const rows = await prisma.notificationDelivery.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip,
    take: pageSize,
  });

  /**
   * Recipients and notification text are fetched in two queries rather than
   * per row. Twenty-five rows would otherwise be fifty extra round trips, and
   * this page is opened while somebody is on the phone.
   */
  const recipients = new Map(
    (
      await prisma.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
        select: { id: true, email: true, name: true },
      })
    ).map((u) => [u.id, u])
  );

  const notificationIds = [
    ...new Set(rows.map((r) => r.notificationId).filter((id): id is string => !!id)),
  ];
  const notifications = new Map(
    (
      await prisma.notification.findMany({
        where: { id: { in: notificationIds } },
        select: { id: true, title: true, type: true },
      })
    ).map((n) => [n.id, n])
  );

  /** Counts for the whole filtered set, not just this page. */
  const grouped = await prisma.notificationDelivery.groupBy({
    by: ["status"],
    where,
    _count: { _all: true },
  });
  const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));

  return {
    rows: rows.map((r) => {
      const who = recipients.get(r.userId);
      const what = r.notificationId ? notifications.get(r.notificationId) : undefined;
      return {
        id: r.id,
        eventId: r.eventId,
        channel: r.channel,
        status: r.status,
        // Null when the account has since been deleted, which is worth showing
        // rather than hiding: the delivery still happened.
        recipient: who ? { id: who.id, email: who.email, name: who.name } : null,
        notification: what ? { id: what.id, title: what.title, type: what.type } : null,
        providerMessageId: r.providerMessageId,
        attempts: r.attempts,
        lastError: r.lastError,
        suppressReason: r.suppressReason,
        notBefore: r.notBefore,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
      };
    }),
    byStatus,
    total,
    page,
    pages,
    pageSize,
  };
}

/* ================================================================== *
 * Payouts
 * ================================================================== */

/**
 * Money leaving the platform, in one list.
 *
 * The seller's own page answers "where is my money". This answers the harder
 * question, which is asked by whoever has to reconcile the bank statement:
 * what did we send, to whom, and did it land. Those are different views of the
 * same rows and both are needed — a seller cannot see a payout that failed for
 * another seller, and that is exactly the row that needs finding.
 *
 * FAILED IS THE DEFAULT INTERESTING CASE, so the counts are returned for the
 * whole filtered set rather than the page. A PENDING row that has sat there
 * since yesterday is a stuck transfer, and the number is what makes it
 * visible without reading every row.
 *
 * Searchable by seller email, seller name, payout id or the provider's
 * transfer id — the four things somebody actually arrives holding. Nobody
 * starts a reconciliation with a sellerId.
 */
export async function listPayouts(opts: {
  q?: string;
  status?: "ALL" | PayoutStatus;
  page?: number;
}) {
  const q = opts.q?.trim();

  /**
   * A payout hangs off SellerProfile, whose id is the profile's, not the
   * user's — so an email has to be resolved to profile ids before it can
   * filter anything.
   */
  let sellerIds: string[] | undefined;
  if (q) {
    const profiles = await prisma.sellerProfile.findMany({
      where: {
        user: {
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
          ],
        },
      },
      select: { id: true },
      take: 200,
    });
    sellerIds = profiles.map((p) => p.id);
  }

  const where = {
    ...(opts.status && opts.status !== "ALL" ? { status: opts.status } : {}),
    ...(q
      ? {
          OR: [
            { id: q },
            { providerTransferId: q },
            ...(sellerIds && sellerIds.length > 0 ? [{ sellerId: { in: sellerIds } }] : []),
          ],
        }
      : {}),
  };

  const total = await prisma.payout.count({ where });
  const { skip, page, pages, pageSize } = paginate(opts.page ?? 1, total);

  const rows = await prisma.payout.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip,
    take: pageSize,
    select: {
      id: true,
      amountCents: true,
      nettedCents: true,
      currency: true,
      status: true,
      failureReason: true,
      providerTransferId: true,
      createdAt: true,
      completedAt: true,
      seller: {
        select: {
          id: true,
          connectAccountId: true,
          user: { select: { id: true, email: true, name: true } },
        },
      },
      items: { select: { orderItemId: true, amountCents: true, reversedAt: true } },
    },
  });

  /** Counts for the whole filtered set, not just this page. */
  const grouped = await prisma.payout.groupBy({
    by: ["status"],
    where,
    _count: { _all: true },
  });
  const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));

  /**
   * Sums over everything matching the filter, because "how much have we sent"
   * is not answerable from a page of twenty-five. Netted is separate: it is
   * money we kept back, not money we sent, and adding the two would overstate
   * what left the account.
   */
  const paidTotal = await prisma.payout.aggregate({
    where: { ...where, status: PayoutStatus.PAID },
    _sum: { amountCents: true, nettedCents: true },
  });

  /** Outstanding seller debt, which is a platform liability and not per-page. */
  const debt = await prisma.payoutDebt.aggregate({ _sum: { amountCents: true } });

  return {
    rows: rows.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      nettedCents: p.nettedCents,
      currency: p.currency,
      status: p.status,
      failureReason: p.failureReason,
      providerTransferId: p.providerTransferId,
      // The connected account id is here because a reconciliation ends in the
      // provider's dashboard, and this is the value to paste into it.
      connectAccountId: p.seller.connectAccountId,
      seller: {
        profileId: p.seller.id,
        userId: p.seller.user.id,
        email: p.seller.user.email,
        name: p.seller.user.name,
      },
      itemCount: p.items.length,
      reversedCents: p.items
        .filter((i) => i.reversedAt !== null)
        .reduce((sum, i) => sum + i.amountCents, 0),
      items: p.items,
      createdAt: p.createdAt,
      completedAt: p.completedAt,
    })),
    byStatus,
    totals: {
      paidCents: paidTotal._sum.amountCents ?? 0,
      nettedCents: paidTotal._sum.nettedCents ?? 0,
      outstandingDebtCents: debt._sum.amountCents ?? 0,
    },
    total,
    page,
    pages,
    pageSize,
  };
}

/* ================================================================== *
 * Returns
 * ================================================================== */

/**
 * Return requests, for the moderator who has to settle the ones a seller
 * refused.
 *
 * ESCALATED is the status this view exists for: a buyer has asked for money
 * back, the seller has said no, and somebody impartial has to decide. Those
 * cannot be found any other way — a seller sees only their own, and a buyer
 * sees only theirs.
 *
 * Searchable by buyer email or name, the request id, or the order reference —
 * what somebody actually arrives holding from a support conversation.
 */
export async function listReturns(opts: {
  q?: string;
  status?: "ALL" | ReturnStatus;
  page?: number;
}) {
  const q = opts.q?.trim();

  let buyerIds: string[] | undefined;
  let orderIds: string[] | undefined;
  if (q) {
    const [users, orders] = await Promise.all([
      prisma.user.findMany({
        where: {
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
          ],
        },
        select: { id: true },
        take: 200,
      }),
      prisma.order.findMany({
        where: { reference: { contains: q, mode: "insensitive" } },
        select: { id: true },
        take: 200,
      }),
    ]);
    buyerIds = users.map((u) => u.id);
    orderIds = orders.map((o) => o.id);
  }

  const where = {
    ...(opts.status && opts.status !== "ALL" ? { status: opts.status } : {}),
    ...(q
      ? {
          OR: [
            { id: q },
            { orderItemId: q },
            ...(buyerIds && buyerIds.length > 0 ? [{ buyerId: { in: buyerIds } }] : []),
            ...(orderIds && orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
          ],
        }
      : {}),
  };

  const total = await prisma.returnRequest.count({ where });
  const { skip, page, pages, pageSize } = paginate(opts.page ?? 1, total);

  const rows = await prisma.returnRequest.findMany({
    where,
    // ESCALATED first regardless of age: those are the ones waiting on a
    // decision from whoever is reading this page.
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    skip,
    take: pageSize,
    select: {
      id: true,
      orderItemId: true,
      orderId: true,
      status: true,
      reason: true,
      notAsDescribed: true,
      decisionNote: true,
      decidedById: true,
      decidedAt: true,
      refundId: true,
      createdAt: true,
      buyer: { select: { id: true, email: true, name: true } },
      order: { select: { reference: true } },
    },
  });

  /** One query for the lines, not one per row. */
  const items = await prisma.orderItem.findMany({
    where: { id: { in: rows.map((r) => r.orderItemId) } },
    select: {
      id: true,
      title: true,
      unitPriceCents: true,
      quantity: true,
      sellerName: true,
      deliveredAt: true,
      seller: { select: { id: true, user: { select: { email: true, name: true } } } },
    },
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  const grouped = await prisma.returnRequest.groupBy({
    by: ["status"],
    where,
    _count: { _all: true },
  });
  const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));

  return {
    rows: rows.map((r) => {
      const item = byId.get(r.orderItemId);
      return {
        id: r.id,
        status: r.status,
        reason: r.reason,
        notAsDescribed: r.notAsDescribed,
        decisionNote: r.decisionNote,
        decidedAt: r.decidedAt,
        refundId: r.refundId,
        createdAt: r.createdAt,
        orderReference: r.order.reference,
        buyer: r.buyer,
        // Null when the line has been removed, which is worth showing: the
        // request still happened and still needs an answer.
        title: item?.title ?? "an item since removed",
        amountCents: item ? item.unitPriceCents * item.quantity : 0,
        deliveredAt: item?.deliveredAt ?? null,
        seller: item?.seller
          ? {
              profileId: item.seller.id,
              email: item.seller.user.email,
              name: item.seller.user.name,
            }
          : { profileId: null, email: null, name: item?.sellerName ?? null },
      };
    }),
    byStatus,
    total,
    page,
    pages,
    pageSize,
  };
}
