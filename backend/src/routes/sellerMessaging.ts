import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import { requireSeller } from "../middleware/requireSeller";
import { checkRateLimit } from "../lib/rateLimit";
import {
  markRead,
  openThread,
  postMessage,
  threadDetail,
  threadsForSeller,
  unreadThreadCount,
} from "../lib/messaging";
import {
  acceptCounter,
  placementDetail,
  placementsForSeller,
  positionsFor,
  requestPlacement,
  withdrawPlacement,
} from "../lib/placement";
import { MessageAuthor, PlacementSlot, ThreadKind } from "../generated/prisma/enums";

/**
 * The seller's half of talking to the platform, and of asking for a slot.
 *
 * See docs/adr/0033-seller-admin-messaging.md
 *     docs/adr/0034-paid-homepage-placement.md
 */

export const sellerMessagingRouter = Router();

/**
 * PATH-SCOPED, both of them, and that is not cosmetic.
 *
 * This router is mounted at `/seller` alongside the payouts, verification and
 * sales routers. A `use()` with no path runs for every request that reaches
 * that mount — including `/seller/verification`, which an unverified seller has
 * to be able to reach. An unscoped gate in any file mounted there locks doors
 * belonging to other files, and the failure is a 500 rather than a 403 because
 * `req.sellerId` is never set. That mistake has been made in this directory
 * before; every `use()` here names its path.
 */
sellerMessagingRouter.use("/messages", requireAuth, requireSeller);
sellerMessagingRouter.use("/placements", requireAuth, requireSeller);

/* ------------------------------------------------------------------ *
 * Threads
 * ------------------------------------------------------------------ */

sellerMessagingRouter.get("/messages", async (req, res) => {
  try {
    const [threads, unread] = await Promise.all([
      threadsForSeller(req.sellerId!),
      unreadThreadCount("SELLER", req.sellerId!),
    ]);
    res.json({ threads, unreadThreads: unread });
  } catch (err) {
    console.error("GET /seller/messages failed", err);
    res.status(500).json({ error: "Could not load your messages." });
  }
});

/**
 * Reading a thread clears the seller's badge, which is why this is not a pure
 * GET in effect. It stays a GET because the alternative is the client having to
 * remember to POST a read receipt, and a forgotten one leaves a badge that
 * never clears — a worse bug than a non-idempotent read.
 */
sellerMessagingRouter.get("/messages/:id", async (req, res) => {
  try {
    const thread = await threadDetail(req.params.id, "SELLER", req.sellerId!);
    if (!thread) {
      // 404 rather than 403: an id must not reveal that somebody else's thread exists.
      return res.status(404).json({ error: "No such conversation.", code: "NOT_FOUND" });
    }
    await markRead(req.params.id, "SELLER");
    res.json({ thread });
  } catch (err) {
    console.error("GET /seller/messages/:id failed", err);
    res.status(500).json({ error: "Could not load that conversation." });
  }
});

const replyBody = z.object({
  body: z.string().trim().min(1, "Write something first.").max(4000),
});

sellerMessagingRouter.post("/messages/:id/reply", async (req, res) => {
  try {
    const parsed = replyBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Write something first.",
        code: "INVALID_INPUT",
        field: "body",
      });
    }

    /**
     * Rate limited because each message is something a person has to read —
     * the same reasoning as return requests. The cap lives here rather than in
     * `lib/messaging`, which the placement library also calls and which must
     * never refuse a system-generated message about a decision.
     */
    const limit = await checkRateLimit(`msg-reply:${req.userId}`, 30, 60 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "That's a lot of messages. Try again shortly.",
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    // Ownership before the write: postMessage does not know whose thread it is.
    const owned = await threadDetail(req.params.id, "SELLER", req.sellerId!);
    if (!owned) {
      return res.status(404).json({ error: "No such conversation.", code: "NOT_FOUND" });
    }

    const outcome = await postMessage({
      threadId: req.params.id,
      author: MessageAuthor.SELLER,
      authorUserId: req.userId!,
      body: parsed.data.body,
    });

    if (!outcome.posted) {
      if (outcome.reason === "closed") {
        return res.status(409).json({
          error: "That conversation has been closed. Start a new one.",
          code: "THREAD_CLOSED",
        });
      }
      return res.status(404).json({ error: "No such conversation.", code: "NOT_FOUND" });
    }

    res.status(201).json({ id: outcome.messageId });
  } catch (err) {
    console.error("POST /seller/messages/:id/reply failed", err);
    res.status(500).json({ error: "Could not send that message." });
  }
});

const openBody = z.object({
  subject: z.string().trim().min(3, "Give it a subject.").max(120),
  body: z.string().trim().min(1, "Write something first.").max(4000),
});

sellerMessagingRouter.post("/messages", async (req, res) => {
  try {
    const parsed = openBody.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return res.status(400).json({
        error: issue?.message ?? "Check those details.",
        code: "INVALID_INPUT",
        field: issue?.path[0] != null ? String(issue.path[0]) : undefined,
      });
    }

    /** Opening is capped harder than replying: a new thread is a new queue entry. */
    const limit = await checkRateLimit(`msg-open:${req.userId}`, 5, 60 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "You've opened several conversations already. Reply in one of those instead.",
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const outcome = await openThread({
      sellerId: req.sellerId!,
      kind: ThreadKind.SUPPORT,
      subject: parsed.data.subject,
      body: parsed.data.body,
      author: MessageAuthor.SELLER,
      authorUserId: req.userId!,
    });

    if (!outcome.opened) {
      return res.status(404).json({ error: "Seller profile not found.", code: "NOT_FOUND" });
    }
    res.status(201).json({ threadId: outcome.threadId });
  } catch (err) {
    console.error("POST /seller/messages failed", err);
    res.status(500).json({ error: "Could not start that conversation." });
  }
});

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */

/** What the form needs to render: the slots, and how many positions each has. */
sellerMessagingRouter.get("/placements/slots", (_req, res) => {
  res.json({
    slots: Object.values(PlacementSlot).map((slot) => ({
      slot,
      positions: positionsFor(slot),
      label: slot === PlacementSlot.HERO ? "Homepage hero banner" : "Picked for you shelf",
    })),
    /**
     * Said out loud in the API, not only in the UI. A seller agreeing to pay
     * for placement is entitled to know it will be labelled as paid, and a
     * client that forgets to mention it should not be the only thing standing
     * between them and a surprise (ADR 0034).
     */
    disclosure: "Paid placements are labelled “Promoted” wherever they appear.",
  });
});

sellerMessagingRouter.get("/placements", async (req, res) => {
  try {
    res.json({ placements: await placementsForSeller(req.sellerId!) });
  } catch (err) {
    console.error("GET /seller/placements failed", err);
    res.status(500).json({ error: "Could not load your placement requests." });
  }
});

sellerMessagingRouter.get("/placements/:id", async (req, res) => {
  try {
    const placement = await placementDetail(req.params.id, req.sellerId!);
    if (!placement) {
      return res.status(404).json({ error: "No such request.", code: "NOT_FOUND" });
    }
    res.json({ placement });
  } catch (err) {
    console.error("GET /seller/placements/:id failed", err);
    res.status(500).json({ error: "Could not load that request." });
  }
});

const requestBody = z.object({
  listingId: z.string().uuid(),
  slot: z.nativeEnum(PlacementSlot),
  position: z.coerce.number().int().min(0).max(3).optional(),
  /** Whole cents, like every amount in this application (ADR 0005). */
  offeredCents: z.coerce.number().int().min(100, "Offer at least $1.").max(1_000_000),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  note: z.string().trim().min(10, "Say a little about why.").max(2000),
});

sellerMessagingRouter.post("/placements", async (req, res) => {
  try {
    const parsed = requestBody.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return res.status(400).json({
        error: issue?.message ?? "Check those details.",
        code: "INVALID_INPUT",
        field: issue?.path[0] != null ? String(issue.path[0]) : undefined,
      });
    }

    const { startsAt, endsAt } = parsed.data;
    if (startsAt && endsAt && endsAt <= startsAt) {
      return res.status(400).json({
        error: "The end date has to be after the start date.",
        code: "INVALID_INPUT",
        field: "endsAt",
      });
    }

    const limit = await checkRateLimit(`placement-open:${req.userId}`, 10, 24 * 3600_000);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "You've made several placement requests today. Wait for an answer on those.",
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const outcome = await requestPlacement({
      sellerId: req.sellerId!,
      listingId: parsed.data.listingId,
      slot: parsed.data.slot,
      position: parsed.data.position,
      offeredCents: parsed.data.offeredCents,
      startsAt: startsAt ?? null,
      endsAt: endsAt ?? null,
      note: parsed.data.note,
    });

    if (!outcome.requested) {
      switch (outcome.reason) {
        /**
         * Both answer 404. A listing that is not yours and a listing that does
         * not exist must be indistinguishable, or an id becomes a way to ask
         * whether a rival's listing is real — the same policy as sales, payouts
         * and returns.
         */
        case "no-listing":
        case "not-yours":
          return res.status(404).json({ error: "No such listing.", code: "NOT_FOUND" });
        case "not-active":
          return res.status(409).json({
            error: "Publish the listing before asking for a placement.",
            code: "LISTING_NOT_ACTIVE",
          });
        case "bad-position":
          return res.status(400).json({
            error: "That slot does not have that position.",
            code: "INVALID_INPUT",
            field: "position",
          });
        case "already-open":
          return res.status(409).json({
            error: "There is already an open request for that listing.",
            code: "ALREADY_OPEN",
          });
      }
    }

    res.status(201).json({ id: outcome.id, threadId: outcome.threadId });
  } catch (err) {
    console.error("POST /seller/placements failed", err);
    res.status(500).json({ error: "Could not make that request." });
  }
});

const decideNote = z.object({ note: z.string().trim().max(2000).optional() });

sellerMessagingRouter.post("/placements/:id/accept", async (req, res) => {
  try {
    const parsed = decideNote.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Check those details.", code: "INVALID_INPUT" });
    }

    // Ownership first: acceptCounter is keyed by id alone.
    const owned = await placementDetail(req.params.id, req.sellerId!);
    if (!owned) return res.status(404).json({ error: "No such request.", code: "NOT_FOUND" });

    const outcome = await acceptCounter({
      id: req.params.id,
      sellerUserId: req.userId!,
      note: parsed.data.note,
    });

    if (!outcome.changed) {
      if (outcome.reason === "no-placement") {
        return res.status(404).json({ error: "No such request.", code: "NOT_FOUND" });
      }
      return res.status(409).json({
        error: "There is no counter-offer waiting on that request.",
        code: "WRONG_STATE",
      });
    }
    res.json({ status: outcome.status });
  } catch (err) {
    console.error("POST /seller/placements/:id/accept failed", err);
    res.status(500).json({ error: "Could not accept that offer." });
  }
});

sellerMessagingRouter.post("/placements/:id/withdraw", async (req, res) => {
  try {
    const parsed = decideNote.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Check those details.", code: "INVALID_INPUT" });
    }

    const outcome = await withdrawPlacement({
      id: req.params.id,
      sellerId: req.sellerId!,
      sellerUserId: req.userId!,
      note: parsed.data.note,
    });

    if (!outcome.changed) {
      if (outcome.reason === "no-placement") {
        return res.status(404).json({ error: "No such request.", code: "NOT_FOUND" });
      }
      return res.status(409).json({
        error: "That request has already been settled.",
        code: "WRONG_STATE",
      });
    }
    res.json({ status: outcome.status });
  } catch (err) {
    console.error("POST /seller/placements/:id/withdraw failed", err);
    res.status(500).json({ error: "Could not withdraw that request." });
  }
});
