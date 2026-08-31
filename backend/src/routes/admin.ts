import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { checkRateLimit } from "../lib/rateLimit";
import { requireAuth } from "../middleware/requireAuth";
import { requireAdmin } from "../middleware/requireAdmin";
import { adminPlacementRouter } from "./adminPlacement";
import {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_SECONDS,
  AdminAuthError,
  adminTokenSecondsLeft,
  clearAdminCookie,
  generateTotpSecret,
  setAdminCookie,
  stepUp,
  totpEnrolment,
  verifyAndSpendTotp,
} from "../lib/adminAuth";
import {
  ModerationError,
  auditLog,
  listReports,
  reinstateUser,
  removeListing,
  removeReview,
  reportCounts,
  resolveReport,
  restoreListing,
  suspendUser,
} from "../lib/moderation";
import { RefundError, issueRefund, refundableCents, refundsForOrder } from "../lib/refunds";
import { approveReturn, refuseReturn } from "../lib/returns";
import {
  attention,
  customerDetail,
  listCatalogue,
  listCustomers,
  listOrders,
  metrics,
  orderDetail,
  recentOrders,
  topSellers,
  listDeliveries,
  listPayouts,
  listReturns,
  type Range,
} from "../lib/adminStats";
import {
  ListingStatus,
  OrderStatus,
  ReportStatus,
  UserRole,
} from "../generated/prisma/enums";

export const adminRouter = Router();

function fail(res: import("express").Response, err: unknown, fallback: string) {
  if (
    err instanceof AdminAuthError ||
    err instanceof ModerationError ||
    err instanceof RefundError
  ) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

/* ================================================================== *
 * Step-up authentication
 *
 * These routes need an ordinary session but NOT an admin one — they are
 * how an admin one is obtained.
 * ================================================================== */

/** Whether the caller could use the panel, and whether they're in it now. */
adminRouter.get("/session", requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { role: true, totpConfirmedAt: true },
    });

    const isAdmin = user?.role === UserRole.ADMIN;
    // A non-admin gets a plain false rather than a 403. This endpoint decides
    // whether to render a link, and an error would be noise on every page.
    res.json({
      isAdmin,
      needsTotpSetup: isAdmin && !user?.totpConfirmedAt,
      active: false,
      expiresInSeconds: ADMIN_SESSION_SECONDS,
    });
  } catch (err) {
    fail(res, err, "Could not check admin status.");
  }
});

/** Confirms an admin session is live. Behind requireAdmin, so a 401 is the answer. */
adminRouter.get("/session/active", requireAdmin, async (req, res) => {
  res.json({
    active: true,
    secondsLeft: adminTokenSecondsLeft(req.cookies?.[ADMIN_COOKIE_NAME]),
  });
});

const setupBody = z.object({ password: z.string().min(1) });

/**
 * Starts TOTP enrolment.
 *
 * Requires the password again even though the caller is signed in: enrolling a
 * second factor from a session that might be stolen would defeat the point of
 * having one.
 */
adminRouter.post("/totp/setup", requireAuth, async (req, res) => {
  try {
    const parsed = setupBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Enter your password.", code: "INVALID_INPUT" });
    }

    const limit = await checkRateLimit(`admin-totp:${req.userId}`, 10, 60 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({ error: "Too many attempts.", code: "RATE_LIMITED" });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { id: true, email: true, role: true, passwordHash: true, totpConfirmedAt: true },
    });
    if (!user || user.role !== UserRole.ADMIN) {
      return res.status(403).json({ error: "Not available.", code: "NOT_ADMIN" });
    }

    const bcrypt = await import("bcryptjs");
    if (!(await bcrypt.default.compare(parsed.data.password, user.passwordHash))) {
      return res.status(401).json({ error: "That password is wrong.", code: "BAD_PASSWORD" });
    }

    if (user.totpConfirmedAt) {
      return res.status(409).json({
        error: "Two-factor is already set up. Revoke and re-grant admin from the CLI to reset it.",
        code: "ALREADY_ENROLLED",
      });
    }

    const secret = generateTotpSecret();
    // Stored unconfirmed. totpConfirmedAt stays null until a code proves the
    // authenticator app actually has it — otherwise a half-finished enrolment
    // would lock the account out of its own panel.
    await prisma.user.update({ where: { id: user.id }, data: { totpSecret: secret } });

    const enrolment = await totpEnrolment(user.email, secret);
    res.json({
      qrDataUrl: enrolment.qrDataUrl,
      // Shown so it can be typed into an app that cannot scan.
      secret: enrolment.secret,
    });
  } catch (err) {
    fail(res, err, "Could not start two-factor setup.");
  }
});

const confirmBody = z.object({ code: z.string().trim().min(6).max(10) });

adminRouter.post("/totp/confirm", requireAuth, async (req, res) => {
  try {
    const parsed = confirmBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Enter the six-digit code.", code: "INVALID_INPUT" });
    }

    const limit = await checkRateLimit(`admin-totp-confirm:${req.userId}`, 10, 15 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({ error: "Too many attempts.", code: "RATE_LIMITED" });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { id: true, role: true, totpSecret: true, totpConfirmedAt: true },
    });
    if (!user || user.role !== UserRole.ADMIN || !user.totpSecret) {
      return res.status(400).json({ error: "Start setup first.", code: "NOT_STARTED" });
    }
    if (user.totpConfirmedAt) {
      return res.status(409).json({ error: "Already set up.", code: "ALREADY_ENROLLED" });
    }

    /**
     * Enrolment spends the code too.
     *
     * Otherwise the code typed to finish setup would still be live, and could
     * be replayed seconds later against the step-up endpoint to open the panel
     * — which is the exact replay this protection exists to stop, reached
     * through the one door that was not watching for it.
     */
    if (!(await verifyAndSpendTotp(user.id, user.totpSecret, parsed.data.code))) {
      return res.status(400).json({ error: "That code isn't right.", code: "BAD_CODE" });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { totpConfirmedAt: new Date() },
    });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, "Could not confirm two-factor setup.");
  }
});

const stepUpBody = z.object({
  password: z.string().min(1),
  code: z.string().trim().min(6).max(10),
});

adminRouter.post("/session", requireAuth, async (req, res) => {
  try {
    const parsed = stepUpBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Enter your password and code.", code: "INVALID_INPUT" });
    }

    /**
     * Rate limited hard.
     *
     * Six digits is a million combinations, and the verify window accepts three
     * of them at any moment. Without a limit that is brute-forceable in hours;
     * with one it is not brute-forceable at all.
     */
    /**
     * The one limit that fails CLOSED.
     *
     * Everywhere else an unreachable store allows the request — a defence in
     * depth should not take the site down. Here it refuses: unlimited guessing
     * at the admin panel is a worse outcome than nobody opening it during an
     * outage, and the panel has one user who can wait.
     */
    const limit = await checkRateLimit(`admin-stepup:${req.userId}`, 8, 15 * 60 * 1000, {
      failClosed: true,
    });
    if (!limit.allowed) {
      return res.status(429).json({
        error: "Too many attempts. Wait a few minutes.",
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const token = await stepUp({
      userId: req.userId!,
      password: parsed.data.password,
      totpCode: parsed.data.code,
    });

    setAdminCookie(res, token);
    res.json({ active: true, expiresInSeconds: ADMIN_SESSION_SECONDS });
  } catch (err) {
    fail(res, err, "Could not sign in to the admin panel.");
  }
});

adminRouter.post("/session/end", requireAuth, async (_req, res) => {
  clearAdminCookie(res);
  res.status(204).end();
});

/* ================================================================== *
 * Everything below requires a live admin session.
 * ================================================================== */

adminRouter.use(requireAdmin);

/**
 * Merchandising and seller conversations, in their own file but mounted HERE —
 * below the gate — so they inherit the admin session check. A separate
 * `app.use("/admin", ...)` in index.ts would look the same and be unguarded.
 */
adminRouter.use(adminPlacementRouter);

adminRouter.get("/overview", async (_req, res) => {
  try {
    const [
      reports,
      listings,
      activeListings,
      users,
      suspended,
      orders,
      paidOrders,
      escalatedReturns,
    ] = await Promise.all([
        reportCounts(),
        prisma.listing.count(),
        prisma.listing.count({ where: { status: "ACTIVE", deletedAt: null } }),
        prisma.user.count(),
        prisma.user.count({ where: { suspendedAt: { not: null } } }),
        prisma.order.count(),
        prisma.order.count({ where: { status: "PAID" } }),
        /**
         * Badged in the nav, so it is on this endpoint rather than only on the
         * dashboard: an escalated return is a buyer waiting on a human, nothing
         * in the system will ever move it on its own, and a moderator should
         * not have to open a page to find out one is waiting.
         */
        prisma.returnRequest.count({ where: { status: "ESCALATED" } }),
      ]);

    res.json({
      reports,
      catalogue: { total: listings, active: activeListings },
      accounts: { total: users, suspended },
      orders: { total: orders, paid: paidOrders },
      returns: { escalated: escalatedReturns },
    });
  } catch (err) {
    fail(res, err, "Could not load the overview.");
  }
});

/* ---- dashboard ---- *
 *
 * All reads. The queries live in adminStats.ts; nothing below this comment and
 * above "actions" changes any state.
 */

const rangeParam = z.coerce.number().int().refine((n): n is Range => n === 7 || n === 30 || n === 90);

function range(req: import("express").Request): Range {
  const parsed = rangeParam.safeParse(req.query.days ?? 30);
  return parsed.success ? parsed.data : 30;
}

function pageParam(req: import("express").Request): number {
  const parsed = z.coerce.number().int().min(1).max(10_000).safeParse(req.query.page ?? 1);
  return parsed.success ? parsed.data : 1;
}

/** Trimmed, and blank becomes undefined so an empty search box is not a filter. */
function queryParam(req: import("express").Request): string | undefined {
  const raw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  return raw.length > 0 ? raw.slice(0, 200) : undefined;
}

adminRouter.get("/metrics", async (req, res) => {
  try {
    const days = range(req);
    const [data, needs, sellers, recent] = await Promise.all([
      metrics(days),
      attention(),
      topSellers(days),
      recentOrders(),
    ]);
    res.json({ ...data, attention: needs, topSellers: sellers, recentOrders: recent });
  } catch (err) {
    fail(res, err, "Could not load the dashboard.");
  }
});

adminRouter.get("/orders", async (req, res) => {
  try {
    const status = z
      // REFUNDED included, or .catch("ALL") would silently answer a "show me
      // refunded orders" request with every order on the site.
      .enum(["ALL", "PENDING_PAYMENT", "PROCESSING", "PAID", "FAILED", "CANCELLED", "REFUNDED"])
      .catch("ALL")
      .parse(req.query.status ?? "ALL");
    res.json(
      await listOrders({
        q: queryParam(req),
        status: status === "ALL" ? "ALL" : (status as OrderStatus),
        page: pageParam(req),
      })
    );
  } catch (err) {
    fail(res, err, "Could not load orders.");
  }
});

adminRouter.get("/orders/:id", async (req, res) => {
  try {
    const order = await orderDetail(req.params.id);
    if (!order) return res.status(404).json({ error: "No such order.", code: "NOT_FOUND" });
    const refunds = await refundsForOrder(order.id);
    res.json({ order: { ...order, refunds, refundableCents: await refundableCents(order.id) } });
  } catch (err) {
    fail(res, err, "Could not load that order.");
  }
});

const refundBody = z.object({
  /**
   * Minor units. Required rather than defaulted to the whole order: a moderator
   * refunding "everything" should have to say so, because the common dispute is
   * about one line in a basket that spans several sellers.
   */
  amountCents: z.number().int().positive(),
  reason: z.string().trim().min(3).max(1000),
  orderItemId: z.string().uuid().nullish(),
});

/**
 * Refunds part or all of an order, by hand.
 *
 * The automatic path is a seller marking a line unfulfillable. This is the
 * other half: a dispute a person has to settle. It goes through the same
 * issueRefund(), so the over-refund guard and the idempotency key are identical
 * — an admin-issued refund has no special privileges over the arithmetic.
 */
adminRouter.post("/orders/:id/refund", async (req, res) => {
  try {
    const parsed = refundBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "Give an amount and a reason. The buyer sees the reason.",
        code: "INVALID_INPUT",
      });
    }

    const refund = await issueRefund({
      orderId: req.params.id,
      orderItemId: parsed.data.orderItemId ?? null,
      amountCents: parsed.data.amountCents,
      reason: parsed.data.reason,
      trigger: "ADMIN",
      initiatedById: req.adminId!,
    });
    res.json({ refund });
  } catch (err) {
    fail(res, err, "Could not issue that refund.");
  }
});

adminRouter.get("/customers", async (req, res) => {
  try {
    const filter = z
      .enum(["ALL", "SELLERS", "SUSPENDED", "ADMINS"])
      .catch("ALL")
      .parse(req.query.filter ?? "ALL");
    res.json(await listCustomers({ q: queryParam(req), filter, page: pageParam(req) }));
  } catch (err) {
    fail(res, err, "Could not load customers.");
  }
});

adminRouter.get("/customers/:id", async (req, res) => {
  try {
    const customer = await customerDetail(req.params.id);
    if (!customer) return res.status(404).json({ error: "No such account.", code: "NOT_FOUND" });
    res.json({ customer });
  } catch (err) {
    fail(res, err, "Could not load that account.");
  }
});

adminRouter.get("/catalogue", async (req, res) => {
  try {
    const status = z
      .enum(["ALL", "DRAFT", "ACTIVE", "RESERVED", "SOLD", "REMOVED"])
      .catch("ALL")
      .parse(req.query.status ?? "ALL");
    res.json(
      await listCatalogue({
        q: queryParam(req),
        status: status === "ALL" ? "ALL" : (status as ListingStatus | "REMOVED"),
        page: pageParam(req),
      })
    );
  } catch (err) {
    fail(res, err, "Could not load the catalogue.");
  }
});

/* ---- reports ---- */

adminRouter.get("/reports", async (req, res) => {
  try {
    const status = z
      .enum(["OPEN", "RESOLVED", "DISMISSED", "ALL"])
      .default("OPEN")
      .safeParse(req.query.status ?? "OPEN");
    if (!status.success) {
      return res.status(400).json({ error: "Unknown status.", code: "INVALID_INPUT" });
    }

    const [reports, counts] = await Promise.all([
      listReports(status.data === "ALL" ? "ALL" : (status.data as ReportStatus)),
      reportCounts(),
    ]);
    res.json({ reports, counts });
  } catch (err) {
    fail(res, err, "Could not load reports.");
  }
});

const resolveBody = z.object({
  outcome: z.string().trim().min(3).max(1000),
  dismissed: z.boolean().default(false),
});

adminRouter.post("/reports/:id/resolve", async (req, res) => {
  try {
    const parsed = resolveBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Write what you decided.", code: "INVALID_INPUT", field: "outcome" });
    }
    await resolveReport({
      moderatorId: req.adminId!,
      reportId: req.params.id,
      outcome: parsed.data.outcome,
      dismissed: parsed.data.dismissed,
    });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, "Could not close that report.");
  }
});

/* ---- actions ---- */

const actionBody = z.object({
  reason: z.string().trim().min(3).max(1000),
  reportId: z.string().uuid().nullish(),
});

function parseAction(req: import("express").Request) {
  const parsed = actionBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new ModerationError("REASON_REQUIRED", "Write a reason. The person sees this.", 400);
  }
  return parsed.data;
}

adminRouter.post("/listings/:id/remove", async (req, res) => {
  try {
    const { reason, reportId } = parseAction(req);
    await removeListing({
      moderatorId: req.adminId!,
      listingId: req.params.id,
      reason,
      reportId,
    });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, "Could not remove that listing.");
  }
});

adminRouter.post("/listings/:id/restore", async (req, res) => {
  try {
    const { reason } = parseAction(req);
    await restoreListing({ moderatorId: req.adminId!, listingId: req.params.id, reason });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, "Could not restore that listing.");
  }
});

adminRouter.post("/reviews/:id/remove", async (req, res) => {
  try {
    const { reason, reportId } = parseAction(req);
    await removeReview({ moderatorId: req.adminId!, reviewId: req.params.id, reason, reportId });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, "Could not remove that review.");
  }
});

adminRouter.post("/users/:id/suspend", async (req, res) => {
  try {
    const { reason, reportId } = parseAction(req);
    await suspendUser({ moderatorId: req.adminId!, userId: req.params.id, reason, reportId });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, "Could not suspend that account.");
  }
});

adminRouter.post("/users/:id/reinstate", async (req, res) => {
  try {
    const { reason } = parseAction(req);
    await reinstateUser({ moderatorId: req.adminId!, userId: req.params.id, reason });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, "Could not reinstate that account.");
  }
});

/* ---- audit ---- */

/**
 * The delivery ledger.
 *
 * Behind the same admin gate as everything else in this router, and that is not
 * incidental: these rows say which notifications a named person received, which
 * is exactly as sensitive as their order history. The response carries a MASKED
 * provider id and never the message body — the ledger records that something
 * was sent, not what it said (ADR 0026), and this endpoint must not become the
 * place that leaks it.
 */
adminRouter.get("/deliveries", async (req, res) => {
  try {
    const channel = z
      .enum(["ALL", "EMAIL", "PUSH", "SMS"])
      .catch("ALL")
      .parse(req.query.channel ?? "ALL");
    const status = z
      .enum(["ALL", "PENDING", "SENT", "FAILED", "SUPPRESSED", "DEFERRED"])
      .catch("ALL")
      .parse(req.query.status ?? "ALL");

    res.json(
      await listDeliveries({
        q: queryParam(req),
        channel,
        status,
        page: pageParam(req),
      })
    );
  } catch (err) {
    fail(res, err, "Could not load the delivery log.");
  }
});

/**
 * Money leaving the platform.
 *
 * Read only, deliberately. There is no admin "retry this payout" button here:
 * a retry moves money, and the safe way to move money again is the seller's
 * own claim-then-transfer path, which cannot pay the same item twice. An admin
 * endpoint that transferred directly would bypass the claim and be the one way
 * to double-pay somebody.
 */
adminRouter.get("/payouts", async (req, res) => {
  try {
    const status = z
      .enum(["ALL", "PENDING", "PAID", "FAILED"])
      .catch("ALL")
      .parse(req.query.status ?? "ALL");

    res.json(
      await listPayouts({ q: queryParam(req), status, page: pageParam(req) })
    );
  } catch (err) {
    fail(res, err, "Could not load the payout log.");
  }
});

/**
 * Return requests, and the escalations that need settling.
 *
 * This is the only place an ESCALATED request can be seen: the buyer asked for
 * money back, the seller refused, and somebody impartial has to decide. A
 * seller sees only their own requests and a buyer only theirs, so without this
 * an escalation would be a state nothing could act on.
 */
adminRouter.get("/returns", async (req, res) => {
  try {
    const status = z
      .enum(["ALL", "OPEN", "APPROVED", "REFUSED", "ESCALATED", "REJECTED", "WITHDRAWN"])
      .catch("ALL")
      .parse(req.query.status ?? "ALL");

    res.json(await listReturns({ q: queryParam(req), status, page: pageParam(req) }));
  } catch (err) {
    fail(res, err, "Could not load the returns.");
  }
});

/**
 * A moderator settling one, either way.
 *
 * `allowEscalated` is set here and nowhere else: a moderator can answer a
 * request the seller has already refused, which is the entire point of
 * escalation, and the seller's own route deliberately cannot.
 *
 * A rejection here is TERMINAL — `REJECTED`, not `REFUSED` — so the buyer
 * cannot escalate the same request to a second moderator.
 *
 * THE AUDIT TRAIL IS ON THE ROWS, not in ModerationAction. `decidedById` and
 * `decidedAt` record who settled it, and an approval also writes a Refund
 * carrying `initiatedById`. That is the same arrangement as the admin refund
 * route beside it, and duplicating it into the moderation log would give two
 * records of one act that could disagree.
 */
adminRouter.post("/returns/:id/decide", async (req, res) => {
  try {
    const parsed = z
      .object({ approve: z.boolean(), note: z.string().trim().max(2000).optional() })
      .safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input", code: "INVALID_INPUT" });
    }

    const outcome = parsed.data.approve
      ? await approveReturn({
          id: req.params.id,
          decidedById: req.userId!,
          note: parsed.data.note ?? null,
          allowEscalated: true,
        })
      : await refuseReturn({
          id: req.params.id,
          decidedById: req.userId!,
          note: parsed.data.note ?? "",
          terminal: true,
        });

    if (outcome.done) return res.json({ status: outcome.status, refundId: outcome.refundId });

    if (outcome.reason === "note-required") {
      return res.status(400).json({
        error: "Say why. The buyer and the seller both see this.",
        code: "NOTE_REQUIRED",
      });
    }
    if (outcome.reason === "wrong-state") {
      return res.status(409).json({
        error: "That return has already been settled.",
        code: "WRONG_STATE",
        status: outcome.detail,
      });
    }
    if (outcome.reason === "refund-failed") {
      return res.status(502).json({
        error: "The refund could not be issued, so the return is still open.",
        code: "REFUND_FAILED",
        detail: outcome.detail,
      });
    }
    res.status(404).json({ error: "No such return.", code: "NOT_FOUND" });
  } catch (err) {
    fail(res, err, "Could not settle that return.");
  }
});

adminRouter.get("/audit", async (_req, res) => {
  try {
    res.json({ actions: await auditLog() });
  } catch (err) {
    fail(res, err, "Could not load the audit log.");
  }
});
