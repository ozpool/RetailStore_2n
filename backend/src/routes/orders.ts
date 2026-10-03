import { Router } from "express";
import { z } from "zod";
import { refundsForBuyer, refundsForOrder } from "../lib/refunds";
import {
  OrderError,
  attachPaymentIntent,
  claimOrderForPayment,
  createOrderFromHolds,
  getOrder,
  listOrders,
  markOrderPaid,
  releaseOrder,
  unclaimOrder,
} from "../lib/orders";
import {
  PAYMENT_PROVIDER,
  PaymentError,
  confirmIntent,
  createIntent,
  isStubProvider,
  isTestMode,
  normaliseCardNumber,
} from "../lib/paymentProvider";
import { SalesError, markDelivered } from "../lib/sales";
import {
  eligibility,
  escalateReturn,
  openReturn,
  returnWindowDays,
  returnsForBuyer,
  withdrawReturn,
} from "../lib/returns";
import { checkRateLimit } from "../lib/rateLimit";
import { requireAuth } from "../middleware/requireAuth";
import { idempotent } from "../middleware/idempotent";
import { OrderStatus } from "../generated/prisma/enums";

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

function serialize(order: Awaited<ReturnType<typeof getOrder>>) {
  if (!order) return null;
  return {
    id: order.id,
    reference: order.reference,
    status: order.status,
    subtotalCents: order.subtotalCents,
    currency: order.currency,
    paymentProvider: order.paymentProvider,
    /**
     * Lets the payment form say plainly whether real money is involved. Sent
     * per order rather than inferred client-side, because the browser cannot
     * tell a Stripe test key from a live one.
     */
    testMode: isTestMode(),
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    failureReason: order.failureReason,
    createdAt: order.createdAt.toISOString(),
    /**
     * The address as it was at checkout, not as it is now. Null on orders
     * placed before addresses existed.
     */
    shipTo: order.shipToLine1
      ? {
          fullName: order.shipToName,
          line1: order.shipToLine1,
          line2: order.shipToLine2,
          city: order.shipToCity,
          region: order.shipToRegion,
          postcode: order.shipToPostcode,
          country: order.shipToCountry,
          phone: order.shipToPhone,
        }
      : null,
    items: order.items.map((item) => ({
      id: item.id,
      title: item.title,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
      sellerName: item.sellerName,
      slug: item.listing?.slug ?? null,
      image: item.listing?.images[0]?.url ?? null,
      // Per line, because a basket can span sellers and they ship separately.
      fulfilment: item.fulfilment,
      shippedAt: item.shippedAt ? item.shippedAt.toISOString() : null,
      deliveredAt: item.deliveredAt ? item.deliveredAt.toISOString() : null,
      carrier: item.carrier,
      trackingNumber: item.trackingNumber,
      fulfilmentNote: item.fulfilmentNote,
    })),
  };
}

function fail(res: import("express").Response, err: unknown, fallback: string) {
  if (err instanceof OrderError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  if (err instanceof PaymentError) {
    // An indeterminate failure is not the buyer's fault and must not read like
    // a decline — the charge may well have gone through.
    return err.indeterminate
      ? res.status(502).json({ error: err.message, code: "PAYMENT_UNCONFIRMED" })
      : res.status(400).json({ error: err.message, code: "PAYMENT_ERROR" });
  }
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

/**
 * Idempotency keys, derived from the order — never random.
 *
 * A key generated per attempt makes every retry look new to the provider,
 * which is the most common way this protection is added and does nothing. Tying
 * it to the order id is what makes "create an intent for this order" and "pay
 * this order" safe to repeat after a lost response.
 */
function intentKey(orderId: string) {
  return `retailstore-2n:order:${orderId}:intent`;
}

function confirmKey(orderId: string) {
  return `retailstore-2n:order:${orderId}:confirm`;
}

ordersRouter.get("/", async (req, res) => {
  try {
    const orders = await listOrders(req.userId!);
    res.json({ orders: orders.map(serialize) });
  } catch (err) {
    fail(res, err, "Could not load your orders.");
  }
});

/**
 * Every refund this buyer has received.
 *
 * DECLARED BEFORE "/:id" ON PURPOSE. Express matches in order, so with these
 * swapped the request would be read as an order whose id is the string
 * "refunds" and answered with a 404.
 */
/* ------------------------------------------------------------------ *
 * Returns
 *
 * The buyer's side. Mounted here rather than behind a router of its own
 * deliberately: a second router at the same mount point is how the payout gate
 * came to 500 every sibling route under `/seller`, and there is nothing about
 * returns that needs its own mount.
 * See docs/adr/0031-buyer-initiated-returns.md
 * ------------------------------------------------------------------ */

const returnSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Say a little more about what's wrong — the seller reads this.")
    .max(2000),
  /** Misdescribed, rather than simply unwanted. */
  notAsDescribed: z.boolean().default(false),
});

/** Every return this buyer has asked for. */
ordersRouter.get("/returns", async (req, res) => {
  try {
    res.json({
      returns: await returnsForBuyer(req.userId!),
      windowDays: returnWindowDays(),
    });
  } catch (err) {
    fail(res, err, "Could not load your returns.");
  }
});

/**
 * Whether a line can be returned, and if not, why.
 *
 * Asked by the order page before it offers the control, so a buyer is told
 * "the window closed on the 14th" rather than being given a button that fails.
 */
ordersRouter.get("/items/:itemId/return", async (req, res) => {
  try {
    const check = await eligibility(req.userId!, req.params.itemId);
    if (!check.eligible) {
      /**
       * A line that is not theirs, and one that does not exist, both answer
       * 404 — the same policy as addresses and payouts. Distinguishing them
       * turns an id into a way to ask whether somebody else bought something.
       */
      if (check.reason === "not-your-order" || check.reason === "no-such-item") {
        return res.status(404).json({ error: "No such item.", code: "NOT_FOUND" });
      }
      return res.json({
        eligible: false,
        code: RETURN_REFUSALS[check.reason].code,
        error: RETURN_REFUSALS[check.reason].error,
        deadline: check.deadline ?? null,
        windowDays: returnWindowDays(),
      });
    }
    res.json({
      eligible: true,
      title: check.title,
      amountCents: check.amountCents,
      deadline: check.deadline,
      windowDays: returnWindowDays(),
    });
  } catch (err) {
    fail(res, err, "Could not check that item.");
  }
});

/**
 * Each refusal is a different thing for the buyer to do, so each gets its own
 * sentence rather than one generic "cannot return".
 */
const RETURN_REFUSALS: Record<string, { code: string; error: string }> = {
  "order-not-paid": {
    code: "ORDER_NOT_PAID",
    error: "That order was never paid, so there's nothing to return.",
  },
  "not-delivered": {
    code: "NOT_DELIVERED",
    error: "Confirm the item arrived first — returns start from delivery.",
  },
  "window-closed": {
    code: "WINDOW_CLOSED",
    error: "The return window for that item has closed.",
  },
  "already-refunded": {
    code: "ALREADY_REFUNDED",
    error: "That item has already been refunded.",
  },
  "already-requested": {
    code: "ALREADY_REQUESTED",
    error: "You've already opened a return for that item.",
  },
  raced: {
    code: "ALREADY_REQUESTED",
    error: "You've already opened a return for that item.",
  },
  "not-your-order": { code: "NOT_FOUND", error: "No such item." },
  "no-such-item": { code: "NOT_FOUND", error: "No such item." },
};

ordersRouter.post("/items/:itemId/return", idempotent, async (req, res) => {
  try {
    const parsed = returnSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return res.status(400).json({
        error: issue?.message ?? "Invalid input",
        code: "INVALID_INPUT",
        field: issue?.path[0],
      });
    }

    /**
     * Rate limited because each request is a message a seller has to read, and
     * an unlimited endpoint is a way to bury one seller in requests.
     */
    const limit = await checkRateLimit(`return-open:${req.userId}`, 20, 60 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "Too many return requests. Try again later.",
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const outcome = await openReturn({
      buyerId: req.userId!,
      orderItemId: req.params.itemId,
      reason: parsed.data.reason,
      notAsDescribed: parsed.data.notAsDescribed,
    });

    if (outcome.opened) {
      return res.status(201).json({ id: outcome.id, deadline: outcome.deadline });
    }

    if (outcome.reason === "not-your-order" || outcome.reason === "no-such-item") {
      return res.status(404).json({ error: "No such item.", code: "NOT_FOUND" });
    }
    const explain = RETURN_REFUSALS[outcome.reason];
    res.status(409).json({ error: explain.error, code: explain.code });
  } catch (err) {
    fail(res, err, "Could not open that return.");
  }
});

ordersRouter.post("/returns/:id/withdraw", async (req, res) => {
  try {
    const outcome = await withdrawReturn(req.userId!, req.params.id);
    if (outcome.done) return res.json({ status: outcome.status });
    // "not-yours" answers 404 alongside "no-such-request", so an id is not an
    // oracle for whether somebody else has an open return.
    if (outcome.reason === "no-such-request" || outcome.reason === "not-yours") {
      return res.status(404).json({ error: "No such return.", code: "NOT_FOUND" });
    }
    res.status(409).json({
      error: "That return has already been answered.",
      code: "WRONG_STATE",
      status: outcome.detail,
    });
  } catch (err) {
    fail(res, err, "Could not withdraw that return.");
  }
});

/** Asking a moderator to look at a refusal. Only from REFUSED. */
ordersRouter.post("/returns/:id/escalate", async (req, res) => {
  try {
    const outcome = await escalateReturn(req.userId!, req.params.id);
    if (outcome.done) return res.json({ status: outcome.status });
    if (outcome.reason === "no-such-request" || outcome.reason === "not-yours") {
      return res.status(404).json({ error: "No such return.", code: "NOT_FOUND" });
    }
    res.status(409).json({
      error: "Only a refused return can be escalated.",
      code: "WRONG_STATE",
      status: outcome.detail,
    });
  } catch (err) {
    fail(res, err, "Could not escalate that return.");
  }
});

ordersRouter.get("/refunds", async (req, res) => {
  try {
    res.json({ refunds: await refundsForBuyer(req.userId!) });
  } catch (err) {
    fail(res, err, "Could not load your refunds.");
  }
});

ordersRouter.get("/:id", async (req, res) => {
  try {
    const order = await getOrder(req.userId!, req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found.", code: "NOT_FOUND" });
    }
    // Attached rather than folded into serialize(): the list view has no use
    // for them, and this is the only place they are read.
    const refunds = await refundsForOrder(order.id);
    res.json({ order: { ...serialize(order), refunds } });
  } catch (err) {
    fail(res, err, "Could not load that order.");
  }
});

/**
 * Checkout: converts the buyer's holds into an order and opens a payment
 * intent for it. The stock is already committed by the holds, so nobody can
 * be told their item is gone after paying for it.
 */
const checkoutBody = z.object({
  /** Omitted means "use my default", which is what the cart button does. */
  addressId: z.string().uuid().optional(),
});

/**
 * Keyed because a retry here cannot recover on its own: the first request
 * already turned the holds into an order, so a second finds nothing to check
 * out — and the client never learned the id of the order it created.
 */
ordersRouter.post("/", idempotent, async (req, res) => {
  try {
    const parsed = checkoutBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Pick a delivery address.", code: "INVALID_INPUT", field: "addressId" });
    }

    const order = await createOrderFromHolds(req.userId!, parsed.data.addressId);

    const intent = await createIntent({
      amountCents: order.subtotalCents,
      currency: order.currency,
      orderReference: order.reference,
      idempotencyKey: intentKey(order.id),
    });

    await attachPaymentIntent({
      orderId: order.id,
      provider: PAYMENT_PROVIDER,
      intentId: intent.id,
    });

    res.status(201).json({
      order: { ...serialize(order), paymentProvider: PAYMENT_PROVIDER },
      payment: {
        intentId: intent.id,
        clientSecret: intent.clientSecret,
        amountCents: intent.amountCents,
        currency: intent.currency,
        // So the UI can say plainly that no real payment is being taken.
        isStub: isStubProvider(),
      },
    });
  } catch (err) {
    fail(res, err, "Could not start checkout.");
  }
});

const payBody = z.object({
  // Never stored. Passed to the provider stub to pick a test outcome and
  // discarded, exactly like the KYC document number.
  cardNumber: z.string().trim().min(12).max(24),
});

/**
 * Confirms payment.
 *
 * THE ORDER OF THESE STEPS IS THE SAFETY PROPERTY.
 *
 *   1. validate the input          — before anything is claimed, so a typo
 *                                    doesn't lock the order
 *   2. claim the order atomically  — exactly one concurrent request wins
 *   3. talk to the provider        — only the winner gets here, with an
 *                                    idempotency key so a lost response is
 *                                    safe to retry
 *   4. record the result           — idempotently, because a webhook may say
 *                                    the same thing again
 *
 * Doing 3 before 2 is the double-charge bug: two requests both read
 * PENDING_PAYMENT, both charge, both then agree the order is paid.
 *
 * With real Stripe in a browser flow the client confirms via Stripe.js and the
 * webhook below is the source of truth. Confirming here as well is what makes
 * sandbox testing possible without a browser, and it is scoped to the order's
 * owner.
 *
 * The Idempotency-Key does not replace any of that — the claim in step 2 is
 * still what stops a second charge. What the key adds is that a retry is told
 * how its own first attempt went, instead of a bare ALREADY_PAID. ADR 0035.
 */
ordersRouter.post("/:id/pay", idempotent, async (req, res) => {
  let claimed: string | null = null;
  try {
    const parsed = payBody.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Enter a card number.", code: "INVALID_INPUT", field: "cardNumber" });
    }

    // Step 1. Reject a malformed number now — claiming first would leave the
    // order stuck in PROCESSING over a typing mistake.
    try {
      normaliseCardNumber(parsed.data.cardNumber);
    } catch {
      return res.status(400).json({
        error: "That doesn't look like a card number.",
        code: "INVALID_INPUT",
        field: "cardNumber",
      });
    }

    const order = await getOrder(req.userId!, req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found.", code: "NOT_FOUND" });
    }
    if (!order.paymentIntentId) {
      return res
        .status(409)
        .json({ error: "That order has no payment attached.", code: "NO_INTENT" });
    }

    // Step 2. The guard. Everything past this line runs in exactly one request.
    const won = await claimOrderForPayment(req.userId!, order.id);
    if (!won) {
      // Re-read to say precisely why, rather than guessing from a stale copy.
      const current = await getOrder(req.userId!, order.id);
      if (current?.status === OrderStatus.PAID) {
        return res
          .status(409)
          .json({ error: "That order is already paid.", code: "ALREADY_PAID" });
      }
      if (current?.status === OrderStatus.PROCESSING) {
        return res.status(409).json({
          error: "That payment is already going through. Give it a moment.",
          code: "PAYMENT_IN_PROGRESS",
        });
      }
      return res
        .status(409)
        .json({ error: "That order can no longer be paid.", code: "NOT_PAYABLE" });
    }
    claimed = order.id;

    // Step 3.
    const outcome = await confirmIntent({
      intentId: order.paymentIntentId,
      cardNumber: parsed.data.cardNumber,
      idempotencyKey: confirmKey(order.id),
    });

    // Step 4.
    if (outcome.status === "succeeded") {
      await markOrderPaid(order.id);
    } else if (outcome.status === "failed") {
      // A definitive refusal: no money moved, so return the stock.
      await releaseOrder(order.id, OrderStatus.FAILED, outcome.reason);
    } else {
      // Pending (3-D Secure, async method). The order stays PROCESSING so the
      // stock stays committed; the webhook or reconciliation will settle it.
      // Deliberately NOT unclaimed — a payment may still complete.
    }
    claimed = null;

    const updated = await getOrder(req.userId!, order.id);
    res.json({
      outcome: outcome.status,
      reason: outcome.status === "succeeded" ? null : outcome.reason,
      order: serialize(updated),
    });
  } catch (err) {
    /**
     * A throw after the claim is the dangerous case: the provider may have
     * charged the card before the error. Reopening the order for payment could
     * charge twice, so it stays PROCESSING and reconciliation asks the provider
     * what actually happened. The only exception is a definitive refusal, where
     * we know no money moved.
     */
    if (claimed) {
      const definitive = err instanceof PaymentError && !err.indeterminate;
      if (definitive) {
        await unclaimOrder(claimed).catch(() => {});
      } else {
        console.error(
          `Order ${claimed} left PROCESSING after an unconfirmed payment; reconciliation will settle it.`,
          err
        );
      }
    }
    fail(res, err, "Could not complete that payment.");
  }
});

/**
 * The buyer confirms an item arrived.
 *
 * Deliberately the buyer's action, not the seller's: a seller marking their own
 * parcel delivered is not evidence of anything — and this endpoint is what
 * releasing money hangs on, since `deliveredAt` starts the payout hold.
 * A seller who could call it would be starting their own clock. See ADR 0030.
 */
ordersRouter.post("/items/:itemId/delivered", async (req, res) => {
  try {
    await markDelivered(req.userId!, req.params.itemId);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof SalesError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    fail(res, err, "Could not confirm that delivery.");
  }
});

/** Buyer abandons checkout: give the stock straight back. */
ordersRouter.post("/:id/cancel", async (req, res) => {
  try {
    const order = await getOrder(req.userId!, req.params.id);
    if (!order) {
      return res.status(404).json({ error: "Order not found.", code: "NOT_FOUND" });
    }
    // PROCESSING is deliberately not cancellable: a charge may be in flight,
    // and returning the stock now could mean selling an item someone has paid
    // for. It settles either way within a couple of minutes.
    if (order.status === OrderStatus.PROCESSING) {
      return res.status(409).json({
        error: "A payment is going through for that order. Try again in a moment.",
        code: "PAYMENT_IN_PROGRESS",
      });
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      return res
        .status(409)
        .json({ error: "Only an unpaid order can be cancelled.", code: "NOT_CANCELLABLE" });
    }

    await releaseOrder(order.id, OrderStatus.CANCELLED, "Cancelled by the buyer.");
    res.json({ order: serialize(await getOrder(req.userId!, order.id)) });
  } catch (err) {
    fail(res, err, "Could not cancel that order.");
  }
});
