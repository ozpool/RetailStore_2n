import { prisma } from "./prisma";
import { holdDays } from "./payouts";
import { issueRefund } from "./refunds";
import { isUniqueViolation } from "./pgErrors";
import {
  FulfilmentStatus,
  OrderStatus,
  RefundStatus,
  RefundTrigger,
  ReturnStatus,
} from "../generated/prisma/enums";

/**
 * A buyer asking for their money back.
 *
 * This is the entry point to machinery that already existed. Everything past
 * an approval — the over-refund guard, the provider call, webhook settlement,
 * the payout reversal and the debt a failed reversal leaves — is `lib/refunds`
 * and `lib/payouts` unchanged. What lives here is who may ask, what makes the
 * asking valid, and who answers.
 *
 * See docs/adr/0031-buyer-initiated-returns.md
 */

/**
 * How long after DELIVERY a buyer may still ask.
 *
 * DERIVED FROM THE PAYOUT HOLD, and that is the decision worth reading twice.
 * The hold exists so the platform does not pay a seller money that is about to
 * be clawed back. A return window LONGER than the hold means every late return
 * lands on money already transferred, so the reversal-and-debt path stops being
 * the exceptional case it was designed as and becomes the ordinary one. Two
 * numbers chosen independently that must relate to each other will not stay
 * related; deriving one from the other makes them consistent by construction.
 *
 * Read per call, never captured at module load — a value frozen at import makes
 * the whole thing untestable without a subprocess, which this codebase has been
 * bitten by four times now.
 */
export function returnWindowDays(): number {
  const raw = process.env.RETURN_WINDOW_DAYS;
  if (raw === undefined || raw.trim() === "") return holdDays();
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : holdDays();
}

/**
 * Said at boot when the window has been configured past the hold.
 *
 * Not fatal: it is a legitimate choice, and a buyer-friendly one. But it makes
 * transfer reversals routine rather than exceptional, and nobody should
 * discover that from a debt row.
 */
export function returnWindowSummary(): string {
  const window = returnWindowDays();
  const hold = holdDays();
  if (window <= hold) {
    return `${window} day(s) after delivery (within the ${hold}-day payout hold)`;
  }
  return (
    `${window} day(s) after delivery — LONGER than the ${hold}-day payout hold, ` +
    `so returns opened after day ${hold} will need transfer reversals`
  );
}

/** Why a line cannot be returned. Each one is a different thing to tell them. */
export type Ineligibility =
  | "not-your-order"
  | "no-such-item"
  | "order-not-paid"
  | "not-delivered"
  | "window-closed"
  | "already-refunded"
  | "already-requested";

export type Eligibility =
  | { eligible: true; orderId: string; title: string; amountCents: number; deadline: Date }
  | { eligible: false; reason: Ineligibility; deadline?: Date };

const DAY = 24 * 3600_000;

/**
 * The five conditions, checked in the order that gives the most useful answer.
 *
 * Ownership first, because telling somebody a line is out of window when it was
 * never theirs leaks that the line exists. Then the facts about the money, then
 * the facts about the line, then whether anyone has already acted on it.
 */
export async function eligibility(
  buyerId: string,
  orderItemId: string,
  now: Date = new Date()
): Promise<Eligibility> {
  const item = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    select: {
      id: true,
      orderId: true,
      title: true,
      unitPriceCents: true,
      quantity: true,
      fulfilment: true,
      deliveredAt: true,
      order: { select: { buyerId: true, status: true } },
    },
  });

  if (!item) return { eligible: false, reason: "no-such-item" };
  if (item.order.buyerId !== buyerId) return { eligible: false, reason: "not-your-order" };

  /**
   * Condition 1. The money actually arrived, and is still here.
   *
   * REFUNDED IS ANSWERED SEPARATELY, and it has to be. `Order.status` becomes
   * REFUNDED once `refundedCents` reaches the subtotal (data-model invariant
   * 18), so a buyer who successfully returns something and then reopens the
   * page hits this check — and lumping it in with the others told them "that
   * order was never paid", which is both false and baffling given they had
   * just been refunded for it. Caught by a test asserting the wrong thing for
   * the right reason.
   */
  if (item.order.status === OrderStatus.REFUNDED) {
    return { eligible: false, reason: "already-refunded" };
  }
  if (item.order.status !== OrderStatus.PAID) {
    return { eligible: false, reason: "order-not-paid" };
  }

  /**
   * Condition 2. Delivered, and by the BUYER's own confirmation — `deliveredAt`
   * is set by `POST /orders/items/:id/delivered`, which only the buyer can
   * call. A seller's word that they posted something is not a delivery.
   */
  if (item.fulfilment !== FulfilmentStatus.DELIVERED || item.deliveredAt === null) {
    return { eligible: false, reason: "not-delivered" };
  }

  // Condition 3. Inside the window, measured from that confirmation.
  const deadline = new Date(item.deliveredAt.getTime() + returnWindowDays() * DAY);
  if (now > deadline) return { eligible: false, reason: "window-closed", deadline };

  /**
   * Condition 4. Nothing has already given the money back. A PENDING refund
   * counts: it may not have left the provider yet, but a refund in flight is
   * not a reason to let somebody ask for a second one.
   */
  const refunded = await prisma.refund.count({
    where: {
      orderItemId,
      status: { in: [RefundStatus.PENDING, RefundStatus.SUCCEEDED] },
    },
  });
  if (refunded > 0) return { eligible: false, reason: "already-refunded" };

  /**
   * Condition 5. Nobody has asked yet. Checked so the buyer gets a sentence
   * rather than a constraint violation — the unique index on `orderItemId` is
   * what actually enforces it, and this read cannot be trusted to.
   */
  const existing = await prisma.returnRequest.count({ where: { orderItemId } });
  if (existing > 0) return { eligible: false, reason: "already-requested" };

  return {
    eligible: true,
    orderId: item.orderId,
    title: item.title,
    amountCents: item.unitPriceCents * item.quantity,
    deadline,
  };
}

export type OpenOutcome =
  | { opened: true; id: string; deadline: Date }
  | { opened: false; reason: Ineligibility | "raced"; deadline?: Date };

/**
 * Opens a request. THE INSERT IS THE CLAIM.
 *
 * `eligibility()` above and this function both run in every concurrent attempt,
 * and both will happily agree the line is returnable. What separates them is
 * `return_requests.orderItemId @unique`: the transaction that inserts first
 * wins and the second fails on the constraint. Same discipline as the payout
 * claim (ADR 0030) and the delivery ledger (ADR 0026) — a read-then-write
 * version lets a double tap open two rival requests against one line, which
 * then get answered separately.
 */
export async function openReturn(input: {
  buyerId: string;
  orderItemId: string;
  reason: string;
  notAsDescribed: boolean;
  now?: Date;
}): Promise<OpenOutcome> {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();

  const check = await eligibility(input.buyerId, input.orderItemId, now);
  if (!check.eligible) return { opened: false, reason: check.reason, deadline: check.deadline };

  try {
    const created = await prisma.returnRequest.create({
      data: {
        orderItemId: input.orderItemId,
        orderId: check.orderId,
        buyerId: input.buyerId,
        reason,
        notAsDescribed: input.notAsDescribed,
        status: ReturnStatus.OPEN,
      },
      select: { id: true },
    });
    return { opened: true, id: created.id, deadline: check.deadline };
  } catch (err) {
    // P2002 is the unique violation, which here means somebody else got there
    // first — the ordinary outcome of a double tap, not an error worth raising.
    if (isUniqueViolation(err)) return { opened: false, reason: "raced" };
    throw err;
  }
}


/* ------------------------------------------------------------------ *
 * Answering it
 * ------------------------------------------------------------------ */

export type RespondOutcome =
  | { done: true; status: ReturnStatus; refundId?: string }
  | {
      done: false;
      reason: "no-such-request" | "not-yours" | "wrong-state" | "note-required" | "refund-failed";
      detail?: string;
    };

/**
 * Moves a request from one state to another, or does nothing.
 *
 * EVERY TRANSITION GOES THROUGH HERE, and it is an `updateMany` filtered on the
 * status it expects to find rather than an `update` by id. Two people answering
 * the same request at the same moment — a seller refusing while a moderator
 * approves — both read OPEN and both would write. Filtering on the expected
 * status means the first write moves it and the second matches zero rows and
 * loses, which is the same conditional-UPDATE claim used for the payment
 * (ADR 0013) and the refund headroom (ADR 0016).
 */
async function transition(
  id: string,
  from: ReturnStatus[],
  data: Record<string, unknown>
): Promise<boolean> {
  const moved = await prisma.returnRequest.updateMany({
    where: { id, status: { in: from } },
    data,
  });
  return moved.count === 1;
}

/** The buyer changing their mind about having asked. */
export async function withdrawReturn(
  buyerId: string,
  id: string
): Promise<RespondOutcome> {
  const req = await prisma.returnRequest.findUnique({
    where: { id },
    select: { buyerId: true, status: true },
  });
  if (!req) return { done: false, reason: "no-such-request" };
  if (req.buyerId !== buyerId) return { done: false, reason: "not-yours" };

  // Only from OPEN. Once somebody has answered, withdrawing would erase their
  // answer — and once APPROVED the money has already moved.
  const ok = await transition(id, [ReturnStatus.OPEN], {
    status: ReturnStatus.WITHDRAWN,
    decidedAt: new Date(),
  });
  return ok
    ? { done: true, status: ReturnStatus.WITHDRAWN }
    : { done: false, reason: "wrong-state", detail: req.status };
}

/**
 * The buyer asking a moderator to look at a refusal.
 *
 * Only from REFUSED, so this is not a way to bypass the seller: they have to
 * have said no first. There is no timer that escalates on its own, because
 * there is no scheduler here to run one — a seller who stays silent leaves the
 * request OPEN, and the buyer's route is this button, not a deadline.
 */
export async function escalateReturn(
  buyerId: string,
  id: string
): Promise<RespondOutcome> {
  const req = await prisma.returnRequest.findUnique({
    where: { id },
    select: { buyerId: true, status: true },
  });
  if (!req) return { done: false, reason: "no-such-request" };
  if (req.buyerId !== buyerId) return { done: false, reason: "not-yours" };

  const ok = await transition(id, [ReturnStatus.REFUSED], {
    status: ReturnStatus.ESCALATED,
  });
  return ok
    ? { done: true, status: ReturnStatus.ESCALATED }
    : { done: false, reason: "wrong-state", detail: req.status };
}

/**
 * The seller (or a moderator) answering yes, and the only path here that moves
 * money.
 *
 * ORDER OF OPERATIONS, which is the whole of the difficulty:
 *
 *   1. Claim the right to answer — a conditional UPDATE to APPROVED, so two
 *      people approving at once produce one winner.
 *   2. Issue the refund through the ordinary `issueRefund`, so the over-refund
 *      guard, the idempotency key, the provider call and the payout reversal
 *      all apply exactly as they do to a moderator's refund.
 *   3. Record the refund id on the request.
 *
 * If step 2 throws, step 1 IS ROLLED BACK to the state it came from. A request
 * left APPROVED with no refund is the worst available outcome: it tells the
 * buyer their money is coming and nothing is owed to anyone. Reverting leaves
 * the request answerable, which is recoverable.
 *
 * The reverse ordering — refund first, then mark — was considered and rejected.
 * It cannot double-spend (the headroom guard on `Order.refundedCents` stops the
 * second), but it leaves money moved against a request that still looks
 * unanswered, and a second approval attempt then fails confusingly on headroom
 * rather than on state.
 */
export async function approveReturn(input: {
  id: string;
  /** The seller's user id, or the moderator's. Recorded either way. */
  decidedById: string;
  note?: string | null;
  /** Set by the admin path. The seller path may only answer OPEN requests. */
  allowEscalated?: boolean;
}): Promise<RespondOutcome> {
  const req = await prisma.returnRequest.findUnique({
    where: { id: input.id },
    select: { id: true, status: true, orderId: true, orderItemId: true, reason: true },
  });
  if (!req) return { done: false, reason: "no-such-request" };

  const from = input.allowEscalated
    ? [ReturnStatus.OPEN, ReturnStatus.ESCALATED, ReturnStatus.REFUSED]
    : [ReturnStatus.OPEN];

  const item = await prisma.orderItem.findUnique({
    where: { id: req.orderItemId },
    select: { unitPriceCents: true, quantity: true, title: true },
  });
  if (!item) return { done: false, reason: "no-such-request" };

  const previous = req.status;
  const claimed = await transition(req.id, from, {
    status: ReturnStatus.APPROVED,
    decidedById: input.decidedById,
    decisionNote: input.note?.trim() || null,
    decidedAt: new Date(),
  });
  if (!claimed) return { done: false, reason: "wrong-state", detail: previous };

  try {
    const refund = await issueRefund({
      orderId: req.orderId,
      orderItemId: req.orderItemId,
      amountCents: item.unitPriceCents * item.quantity,
      // The buyer's own words reach the refund row, so the reason a buyer sees
      // on their refund is the reason they gave for wanting it.
      reason: `Return approved: ${req.reason}`.slice(0, 500),
      trigger: RefundTrigger.BUYER_RETURN,
      initiatedById: input.decidedById,
    });

    await prisma.returnRequest.update({
      where: { id: req.id },
      data: { refundId: refund.id },
    });
    return { done: true, status: ReturnStatus.APPROVED, refundId: refund.id };
  } catch (err) {
    // Put it back. See the ordering note above.
    await prisma.returnRequest.updateMany({
      where: { id: req.id, status: ReturnStatus.APPROVED },
      data: {
        status: previous,
        decidedById: null,
        decisionNote: null,
        decidedAt: null,
      },
    });
    return {
      done: false,
      reason: "refund-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Answering no.
 *
 * A NOTE IS REQUIRED, for the same reason a refund's reason is: a decision with
 * no stated cause is unanswerable, and this one is the input to the buyer
 * deciding whether to escalate. Refusing with silence would make escalation the
 * only rational response every time.
 */
export async function refuseReturn(input: {
  id: string;
  decidedById: string;
  note: string;
  /** The moderator's REJECTED is terminal; the seller's REFUSED is not. */
  terminal?: boolean;
}): Promise<RespondOutcome> {
  const note = input.note.trim();
  if (note.length < 3) return { done: false, reason: "note-required" };

  const req = await prisma.returnRequest.findUnique({
    where: { id: input.id },
    select: { status: true },
  });
  if (!req) return { done: false, reason: "no-such-request" };

  const from = input.terminal
    ? [ReturnStatus.OPEN, ReturnStatus.ESCALATED, ReturnStatus.REFUSED]
    : [ReturnStatus.OPEN];
  const to = input.terminal ? ReturnStatus.REJECTED : ReturnStatus.REFUSED;

  const ok = await transition(input.id, from, {
    status: to,
    decidedById: input.decidedById,
    decisionNote: note,
    decidedAt: new Date(),
  });
  return ok
    ? { done: true, status: to }
    : { done: false, reason: "wrong-state", detail: req.status };
}

/* ------------------------------------------------------------------ *
 * Reading them back
 * ------------------------------------------------------------------ */

/** Everything one request needs to be rendered, whoever is looking. */
const REQUEST_VIEW = {
  id: true,
  orderItemId: true,
  orderId: true,
  status: true,
  reason: true,
  notAsDescribed: true,
  decisionNote: true,
  decidedAt: true,
  refundId: true,
  createdAt: true,
} as const;

/**
 * The line a request is about, fetched separately.
 *
 * `orderItemId` is deliberately not a relation (ADR 0031), so there is no join
 * to lean on. One query for the whole page rather than one per row: a support
 * conversation is happening while this loads.
 */
async function decorate<T extends { orderItemId: string; orderId: string }>(rows: T[]) {
  if (rows.length === 0) return [];
  const items = await prisma.orderItem.findMany({
    where: { id: { in: rows.map((r) => r.orderItemId) } },
    select: {
      id: true,
      title: true,
      unitPriceCents: true,
      quantity: true,
      sellerName: true,
      deliveredAt: true,
    },
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  const orders = await prisma.order.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.orderId))] } },
    select: { id: true, reference: true },
  });
  const refById = new Map(orders.map((o) => [o.id, o.reference]));

  return rows.map((r) => {
    const item = byId.get(r.orderItemId);
    return {
      ...r,
      // Null when the line is gone, which is worth showing rather than hiding:
      // the request still happened.
      title: item?.title ?? "an item since removed",
      amountCents: item ? item.unitPriceCents * item.quantity : 0,
      sellerName: item?.sellerName ?? null,
      deliveredAt: item?.deliveredAt ?? null,
      orderReference: refById.get(r.orderId) ?? null,
    };
  });
}

/** A buyer's own requests, newest first. */
export async function returnsForBuyer(buyerId: string) {
  const rows = await prisma.returnRequest.findMany({
    where: { buyerId },
    orderBy: { createdAt: "desc" },
    select: REQUEST_VIEW,
  });
  return decorate(rows);
}

/**
 * The requests a seller has to answer.
 *
 * Scoped by walking the order items they own, because a request records the
 * line rather than the seller — the seller of a line can change to null when a
 * profile is deleted, and a request must not vanish from a queue because of it.
 */
export async function returnsForSeller(sellerProfileId: string, openOnly = false) {
  const theirItems = await prisma.orderItem.findMany({
    where: { sellerId: sellerProfileId },
    select: { id: true },
  });
  if (theirItems.length === 0) return [];

  const rows = await prisma.returnRequest.findMany({
    where: {
      orderItemId: { in: theirItems.map((i) => i.id) },
      ...(openOnly ? { status: ReturnStatus.OPEN } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: REQUEST_VIEW,
  });
  return decorate(rows);
}

/** One request, with the seller who owes the answer — for the admin view. */
export async function returnDetail(id: string) {
  const req = await prisma.returnRequest.findUnique({
    where: { id },
    select: { ...REQUEST_VIEW, buyerId: true },
  });
  if (!req) return null;
  const [decorated] = await decorate([req]);
  return decorated ?? null;
}

/** Which seller owes the answer on a line, for authorising a response. */
export async function sellerForRequest(id: string): Promise<string | null> {
  const req = await prisma.returnRequest.findUnique({
    where: { id },
    select: { orderItemId: true },
  });
  if (!req) return null;
  const item = await prisma.orderItem.findUnique({
    where: { id: req.orderItemId },
    select: { sellerId: true },
  });
  return item?.sellerId ?? null;
}
