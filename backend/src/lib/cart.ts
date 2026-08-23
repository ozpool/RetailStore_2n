import { prisma } from "./prisma";
import { OrderStatus, ReservationStatus } from "../generated/prisma/enums";

/**
 * What's in a buyer's cart, in one query pair.
 *
 * Lives in its own module because it spans reservations and orders, and
 * lib/orders.ts already imports lib/reservations.ts — putting this in either
 * would create an import cycle.
 *
 * WHY OPEN ORDERS COUNT
 * Checking out converts holds, so the moment someone reaches the payment page
 * their hold count drops to zero. A badge driven by holds alone would empty
 * mid-checkout and read as "my items disappeared" — the same confusion the
 * cart page's resume banner exists to prevent. An unpaid order still commits
 * the stock, so it is still, in every sense the buyer cares about, in the cart.
 */
export async function cartSummary(userId: string) {
  const now = new Date();

  const [holds, openOrder] = await Promise.all([
    prisma.reservation.findMany({
      where: { userId, status: ReservationStatus.HELD, expiresAt: { gt: now } },
      orderBy: { expiresAt: "asc" },
      select: { quantity: true, expiresAt: true },
    }),
    prisma.order.findFirst({
      where: {
        buyerId: userId,
        status: { in: [OrderStatus.PENDING_PAYMENT, OrderStatus.PROCESSING] },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        reference: true,
        status: true,
        items: { select: { id: true } },
      },
    }),
  ]);

  /**
   * Counts lines, not units.
   *
   * Holding three identical glasses is one line, and the cart page already
   * says "1 item on hold" for it. A badge summing units would say 3 next to a
   * page saying 1, and a number that disagrees with the page it links to is
   * worse than either choice on its own.
   */
  const heldCount = holds.length;
  const openOrderItems = openOrder?.items.length ?? 0;

  return {
    count: heldCount + openOrderItems,
    heldCount,
    openOrderItems,
    /**
     * When the soonest hold lapses.
     *
     * Sent so the client can refresh exactly then instead of polling. Without
     * it a badge sits there claiming two items for as long as the tab is open,
     * fifteen minutes after both holds expired.
     */
    nextExpiresAt: holds[0]?.expiresAt.toISOString() ?? null,
    openOrder: openOrder
      ? { id: openOrder.id, reference: openOrder.reference, status: openOrder.status }
      : null,
  };
}
