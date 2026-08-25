import { Router } from "express";
import { z } from "zod";
import { checkRateLimit } from "../lib/rateLimit";
import { requireAuth } from "../middleware/requireAuth";
import { ModerationError, fileReport } from "../lib/moderation";
import { ReportReason, ReportTargetType } from "../generated/prisma/enums";

/**
 * Reporting something. Open to any signed-in user.
 *
 * Signed-in on purpose: anonymous reporting is trivially abusable, and a report
 * with nobody behind it cannot be followed up or weighed against a reporter's
 * history.
 */
export const reportsRouter = Router();

reportsRouter.use(requireAuth);

const body = z.object({
  targetType: z.nativeEnum(ReportTargetType),
  targetId: z.string().uuid(),
  reason: z.nativeEnum(ReportReason),
  detail: z.string().trim().max(1000).nullish(),
});

reportsRouter.post("/", async (req, res) => {
  try {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Pick a reason and try again.", code: "INVALID_INPUT" });
    }

    // Bounded so one person cannot flood the queue faster than it can be read.
    const limit = await checkRateLimit(`report:${req.userId}`, 20, 60 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "You've reported a lot recently. Give us a chance to catch up.",
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const report = await fileReport({
      reporterId: req.userId!,
      targetType: parsed.data.targetType,
      targetId: parsed.data.targetId,
      reason: parsed.data.reason,
      detail: parsed.data.detail ?? null,
    });

    res.status(201).json({ report });
  } catch (err) {
    if (err instanceof ModerationError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error("POST /reports failed", err);
    res.status(500).json({ error: "Could not send that report." });
  }
});

/** The reasons, for a dropdown. Kept server-side so both ends agree. */
reportsRouter.get("/reasons", (_req, res) => {
  res.json({
    reasons: [
      { value: ReportReason.PROHIBITED_ITEM, label: "Shouldn't be sold here" },
      { value: ReportReason.COUNTERFEIT, label: "Counterfeit or fake" },
      { value: ReportReason.MISLEADING_DESCRIPTION, label: "Description is misleading" },
      { value: ReportReason.SPAM, label: "Spam" },
      { value: ReportReason.HARASSMENT, label: "Abusive or harassing" },
      { value: ReportReason.OTHER, label: "Something else" },
    ],
  });
});
