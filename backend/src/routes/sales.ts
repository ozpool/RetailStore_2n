import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import { requireSeller } from "../middleware/requireSeller";
import {
  approveReturn,
  refuseReturn,
  returnsForSeller,
  sellerForRequest,
} from "../lib/returns";
import {
  SalesError,
  getSale,
  listSales,
  markShipped,
  markUnfulfillable,
  salesSummary,
} from "../lib/sales";

/**
 * A seller's own sales.
 *
 * Mounted under /seller, so requireSeller already guarantees req.sellerId. Every
 * query below is scoped to it — a seller can only ever see and act on lines they
 * sold, and a line belonging to someone else is a 404 rather than a 403.
 */
export const salesRouter = Router();

salesRouter.use(requireAuth, requireSeller);

function fail(res: import("express").Response, err: unknown, fallback: string) {
  if (err instanceof SalesError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

const filters = z.enum(["all", "to_send", "sent"]).default("all");

salesRouter.get("/sales", async (req, res) => {
  try {
    const filter = filters.safeParse(req.query.filter ?? "all");
    if (!filter.success) {
      return res.status(400).json({ error: "Unknown filter.", code: "INVALID_INPUT" });
    }

    const [sales, summary] = await Promise.all([
      listSales(req.sellerId!, filter.data),
      salesSummary(req.sellerId!),
    ]);

    res.json({ sales, summary });
  } catch (err) {
    fail(res, err, "Could not load your sales.");
  }
});

salesRouter.get("/sales/:id", async (req, res) => {
  try {
    const sale = await getSale(req.sellerId!, req.params.id);
    if (!sale) return res.status(404).json({ error: "Sale not found.", code: "NOT_FOUND" });
    res.json({ sale });
  } catch (err) {
    fail(res, err, "Could not load that sale.");
  }
});

const shipBody = z.object({
  // Both optional: plenty of secondhand sales are handed over in person or
  // posted without a trackable service, and demanding a number would push
  // sellers into inventing one.
  carrier: z.string().trim().max(80).nullish(),
  trackingNumber: z.string().trim().max(120).nullish(),
});

salesRouter.post("/sales/:id/ship", async (req, res) => {
  try {
    const parsed = shipBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Check those details.", code: "INVALID_INPUT" });
    }

    const sale = await markShipped({
      sellerId: req.sellerId!,
      orderItemId: req.params.id,
      carrier: parsed.data.carrier ?? null,
      trackingNumber: parsed.data.trackingNumber ?? null,
    });
    res.json({ sale });
  } catch (err) {
    fail(res, err, "Could not mark that as sent.");
  }
});

const cannotSendBody = z.object({
  reason: z.string().trim().min(1, "Tell the buyer why.").max(500),
});

salesRouter.post("/sales/:id/cannot-send", async (req, res) => {
  try {
    const parsed = cannotSendBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Tell the buyer why.", code: "INVALID_INPUT", field: "reason" });
    }

    const result = await markUnfulfillable({
      sellerId: req.sellerId!,
      orderItemId: req.params.id,
      reason: parsed.data.reason,
    });

    res.json({
      ok: true,
      /**
       * The refund outcome, reported rather than assumed.
       *
       * This used to return `refundOwed: true` and a note admitting refunds
       * were not built. They are now issued in the same operation — but a
       * provider can still refuse, so the seller is told which happened
       * instead of being reassured either way.
       */
      refunded: result.refunded,
      refundCents: result.refundCents,
      refundStatus: result.refundStatus,
      refundError: result.refundError,
      note: result.refunded
        ? "The buyer has been refunded automatically."
        : result.refundError
          ? "The buyer was told, but the refund did not go through — it is recorded for someone to settle."
          : "Nothing to refund: this order was never paid for.",
    });
  } catch (err) {
    fail(res, err, "Could not update that sale.");
  }
});

/* ------------------------------------------------------------------ *
 * Returns the seller has to answer
 *
 * Added to this router rather than a new one mounted at /seller. Two routers
 * on one mount is how the payout gate came to answer 500 for every sibling
 * route under /seller, and a return is a fact about a sale — it belongs beside
 * the sales it concerns.
 * See docs/adr/0031-buyer-initiated-returns.md
 * ------------------------------------------------------------------ */

const respondSchema = z.object({
  approve: z.boolean(),
  /**
   * Required to refuse, optional to approve. A refusal with no reason forces
   * the buyer to escalate blind, which makes escalation the only rational
   * answer every time.
   */
  note: z.string().trim().max(2000).optional(),
});

salesRouter.get("/returns", async (req, res) => {
  try {
    const openOnly = req.query.filter === "open";
    res.json({ returns: await returnsForSeller(req.sellerId!, openOnly) });
  } catch (err) {
    fail(res, err, "Could not load your returns.");
  }
});

salesRouter.post("/returns/:id/respond", async (req, res) => {
  try {
    const parsed = respondSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return res.status(400).json({
        error: issue?.message ?? "Invalid input",
        code: "INVALID_INPUT",
      });
    }

    /**
     * Scoped by walking the line back to its seller. Another seller's request
     * answers 404 rather than 403 — the same policy as sales and payouts, so
     * an id cannot be used to ask whether a rival has an open return.
     */
    const owner = await sellerForRequest(req.params.id);
    if (owner === null || owner !== req.sellerId) {
      return res.status(404).json({ error: "No such return.", code: "NOT_FOUND" });
    }

    const outcome = parsed.data.approve
      ? await approveReturn({
          id: req.params.id,
          decidedById: req.userId!,
          note: parsed.data.note ?? null,
        })
      : await refuseReturn({
          id: req.params.id,
          decidedById: req.userId!,
          note: parsed.data.note ?? "",
        });

    if (outcome.done) return res.json({ status: outcome.status, refundId: outcome.refundId });

    if (outcome.reason === "note-required") {
      return res.status(400).json({
        error: "Say why you're refusing — the buyer sees this.",
        code: "NOTE_REQUIRED",
      });
    }
    if (outcome.reason === "wrong-state") {
      return res.status(409).json({
        error: "That return has already been answered.",
        code: "WRONG_STATE",
        status: outcome.detail,
      });
    }
    if (outcome.reason === "refund-failed") {
      /**
       * 502, and the request has been put back to OPEN by `approveReturn`. The
       * seller meant to approve and nothing moved, so this has to read as "try
       * again" rather than as a decision that stuck.
       */
      return res.status(502).json({
        error: "The refund could not be issued, so the return is still open. Try again.",
        code: "REFUND_FAILED",
        detail: outcome.detail,
      });
    }
    res.status(404).json({ error: "No such return.", code: "NOT_FOUND" });
  } catch (err) {
    fail(res, err, "Could not answer that return.");
  }
});
