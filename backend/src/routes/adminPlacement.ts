import { Router } from "express";
import { z } from "zod";
import {
  closeThread,
  markRead,
  postMessage,
  reopenThread,
  threadDetail,
  threadsForAdmin,
  unreadThreadCount,
} from "../lib/messaging";
import {
  acceptAsOffered,
  activate,
  counterOffer,
  declinePlacement,
  endPlacement,
  livePlacements,
  placementDetail,
  placementQueue,
} from "../lib/placement";
import { MessageAuthor, PlacementSlot } from "../generated/prisma/enums";

/**
 * Merchandising, which is a new KIND of admin power.
 *
 * Every other admin capability in this application is restrictive — remove a
 * listing, suspend an account, refuse a return. Choosing what to promote is the
 * first one that is productive, and it is the first one where the platform has
 * a commercial interest in the outcome. That is why the label is not optional
 * and why the terms live in a thread the seller can read back.
 *
 * MOUNTED INSIDE `admin.ts`, BELOW `adminRouter.use(requireAdmin)`, so every
 * route here inherits the admin session gate. Mounting it separately at
 * `/admin` in `index.ts` would look identical and be wide open — a separate
 * router does not inherit another router's middleware.
 *
 * See docs/adr/0034-paid-homepage-placement.md
 */

export const adminPlacementRouter = Router();

/* ------------------------------------------------------------------ *
 * The placement queue
 * ------------------------------------------------------------------ */

adminPlacementRouter.get("/placements", async (req, res) => {
  try {
    const pendingOnly = req.query.pending === "1" || req.query.pending === "true";
    const [queue, live] = await Promise.all([placementQueue({ pendingOnly }), livePlacements()]);
    res.json({ placements: queue, live });
  } catch (err) {
    console.error("GET /admin/placements failed", err);
    res.status(500).json({ error: "Could not load the placement queue." });
  }
});

adminPlacementRouter.get("/placements/:id", async (req, res) => {
  try {
    const placement = await placementDetail(req.params.id);
    if (!placement) return res.status(404).json({ error: "No such request.", code: "NOT_FOUND" });
    res.json({ placement });
  } catch (err) {
    console.error("GET /admin/placements/:id failed", err);
    res.status(500).json({ error: "Could not load that request." });
  }
});

const counterBody = z.object({
  agreedCents: z.coerce.number().int().min(0).max(1_000_000),
  slot: z.nativeEnum(PlacementSlot).optional(),
  position: z.coerce.number().int().min(0).max(3).optional(),
  startsAt: z.coerce.date().optional(),
  endsAt: z.coerce.date().optional(),
  note: z.string().trim().min(1, "Say what you're offering.").max(2000),
});

adminPlacementRouter.post("/placements/:id/counter", async (req, res) => {
  try {
    const parsed = counterBody.safeParse(req.body);
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

    const outcome = await counterOffer({
      id: req.params.id,
      adminUserId: req.adminId!,
      agreedCents: parsed.data.agreedCents,
      slot: parsed.data.slot,
      position: parsed.data.position,
      startsAt: startsAt ?? null,
      endsAt: endsAt ?? null,
      note: parsed.data.note,
    });

    if (!outcome.changed) return decided(res, outcome.reason);
    res.json({ status: outcome.status });
  } catch (err) {
    console.error("POST /admin/placements/:id/counter failed", err);
    res.status(500).json({ error: "Could not send that counter-offer." });
  }
});

const noteOnly = z.object({ note: z.string().trim().max(2000).optional() });

adminPlacementRouter.post("/placements/:id/accept", async (req, res) => {
  try {
    const parsed = noteOnly.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Check those details.", code: "INVALID_INPUT" });
    }

    const outcome = await acceptAsOffered({
      id: req.params.id,
      adminUserId: req.adminId!,
      note: parsed.data.note,
    });
    if (!outcome.changed) return decided(res, outcome.reason);
    res.json({ status: outcome.status });
  } catch (err) {
    console.error("POST /admin/placements/:id/accept failed", err);
    res.status(500).json({ error: "Could not accept that request." });
  }
});

const declineBody = z.object({ note: z.string().trim().min(1, "Say why.").max(2000) });

adminPlacementRouter.post("/placements/:id/decline", async (req, res) => {
  try {
    const parsed = declineBody.safeParse(req.body);
    if (!parsed.success) {
      /**
       * A reason is required to decline, for the same reason refusing a return
       * requires one: a refusal with no reason forces the other side to guess,
       * which makes escalating the only rational answer every time.
       */
      return res.status(400).json({
        error: "Say why — the seller reads this.",
        code: "INVALID_INPUT",
        field: "note",
      });
    }

    const outcome = await declinePlacement({
      id: req.params.id,
      adminUserId: req.adminId!,
      note: parsed.data.note,
    });
    if (!outcome.changed) return decided(res, outcome.reason);
    res.json({ status: outcome.status });
  } catch (err) {
    console.error("POST /admin/placements/:id/decline failed", err);
    res.status(500).json({ error: "Could not decline that request." });
  }
});

adminPlacementRouter.post("/placements/:id/activate", async (req, res) => {
  try {
    const outcome = await activate(req.params.id);
    if (outcome.activated) return res.json({ status: "LIVE" });

    switch (outcome.reason) {
      case "no-placement":
        return res.status(404).json({ error: "No such request.", code: "NOT_FOUND" });
      case "wrong-state":
        return res.status(409).json({
          error: "Only an agreed placement can be made live.",
          code: "WRONG_STATE",
        });
      case "slot-taken":
        /**
         * 409 and not 500. The partial unique index refused it because another
         * placement holds that slot — the request stays AGREED and will go live
         * when the slot frees, which is what the message says rather than
         * asking anybody to retry.
         */
        return res.status(409).json({
          error: "Another placement is live in that slot. This one will start when it ends.",
          code: "SLOT_TAKEN",
        });
    }
  } catch (err) {
    console.error("POST /admin/placements/:id/activate failed", err);
    res.status(500).json({ error: "Could not make that placement live." });
  }
});

adminPlacementRouter.post("/placements/:id/end", async (req, res) => {
  try {
    const ended = await endPlacement(req.params.id);
    if (!ended) {
      return res.status(409).json({
        error: "That placement is not live.",
        code: "WRONG_STATE",
      });
    }
    res.json({ status: "ENDED" });
  } catch (err) {
    console.error("POST /admin/placements/:id/end failed", err);
    res.status(500).json({ error: "Could not end that placement." });
  }
});

/* ------------------------------------------------------------------ *
 * Threads, from the moderator side
 * ------------------------------------------------------------------ */

adminPlacementRouter.get("/messages", async (req, res) => {
  try {
    const unansweredOnly = req.query.unanswered === "1" || req.query.unanswered === "true";
    const [threads, unread] = await Promise.all([
      threadsForAdmin({ unansweredOnly }),
      unreadThreadCount("ADMIN"),
    ]);
    res.json({ threads, unreadThreads: unread });
  } catch (err) {
    console.error("GET /admin/messages failed", err);
    res.status(500).json({ error: "Could not load the message queue." });
  }
});

adminPlacementRouter.get("/messages/:id", async (req, res) => {
  try {
    const thread = await threadDetail(req.params.id, "ADMIN");
    if (!thread) {
      return res.status(404).json({ error: "No such conversation.", code: "NOT_FOUND" });
    }
    /**
     * Clearing the badge here clears it for EVERY moderator, because the admin
     * side of a thread is one role with one counter. ADR 0033 accepts that: the
     * first to read it takes it off the queue for all of them.
     */
    await markRead(req.params.id, "ADMIN");
    res.json({ thread });
  } catch (err) {
    console.error("GET /admin/messages/:id failed", err);
    res.status(500).json({ error: "Could not load that conversation." });
  }
});

const replyBody = z.object({
  body: z.string().trim().min(1, "Write something first.").max(4000),
});

adminPlacementRouter.post("/messages/:id/reply", async (req, res) => {
  try {
    const parsed = replyBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Write something first.",
        code: "INVALID_INPUT",
        field: "body",
      });
    }

    const outcome = await postMessage({
      threadId: req.params.id,
      author: MessageAuthor.ADMIN,
      authorUserId: req.adminId!,
      body: parsed.data.body,
    });

    if (!outcome.posted) {
      if (outcome.reason === "closed") {
        return res.status(409).json({
          error: "That conversation is closed. Reopen it first.",
          code: "THREAD_CLOSED",
        });
      }
      return res.status(404).json({ error: "No such conversation.", code: "NOT_FOUND" });
    }
    res.status(201).json({ id: outcome.messageId });
  } catch (err) {
    console.error("POST /admin/messages/:id/reply failed", err);
    res.status(500).json({ error: "Could not send that message." });
  }
});

adminPlacementRouter.post("/messages/:id/close", async (req, res) => {
  try {
    const closed = await closeThread(req.params.id);
    if (!closed) {
      return res.status(409).json({ error: "That conversation is already closed.", code: "WRONG_STATE" });
    }
    res.json({ closed: true });
  } catch (err) {
    console.error("POST /admin/messages/:id/close failed", err);
    res.status(500).json({ error: "Could not close that conversation." });
  }
});

adminPlacementRouter.post("/messages/:id/reopen", async (req, res) => {
  try {
    const reopened = await reopenThread(req.params.id);
    if (!reopened) {
      return res.status(409).json({ error: "That conversation is already open.", code: "WRONG_STATE" });
    }
    res.json({ closed: false });
  } catch (err) {
    console.error("POST /admin/messages/:id/reopen failed", err);
    res.status(500).json({ error: "Could not reopen that conversation." });
  }
});

/** The two ways a transition can decline to run, mapped once. */
function decided(
  res: import("express").Response,
  reason: "no-placement" | "wrong-state" | "bad-position"
) {
  switch (reason) {
    case "no-placement":
      return res.status(404).json({ error: "No such request.", code: "NOT_FOUND" });
    case "bad-position":
      return res.status(400).json({
        error: "That slot does not have that position.",
        code: "INVALID_INPUT",
        field: "position",
      });
    case "wrong-state":
      return res.status(409).json({
        error: "Somebody has already answered that request. Reload it.",
        code: "WRONG_STATE",
      });
  }
}
