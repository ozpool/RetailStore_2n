import { invalidate } from "./cache";
import { listingKey } from "./cacheKeys";
import { prisma } from "./prisma";
import { events } from "./notifications";
import {
  ListingStatus,
  ModerationActionType,
  ReportStatus,
  ReportTargetType,
} from "../generated/prisma/enums";

/**
 * Reports, moderation, and the audit trail behind both.
 *
 * TWO PRINCIPLES SHAPE EVERYTHING HERE.
 *
 * 1. Marketplace data is open to a moderator; personal data is not.
 *    A listing can be inspected completely — every field, every image, every
 *    report against it. Product data is not personal data. A person's address
 *    is reachable only through a specific order under investigation, and the
 *    fact it was read is written down.
 *
 * 2. Suspension, never deletion.
 *    A suspended account cannot log in, but its listings, orders, and reviews
 *    stay exactly where they are. Deleting a bad actor destroys the evidence
 *    and orphans the orders of people who bought from them in good faith.
 *
 * Every action requires a written reason, and every action is appended to
 * ModerationAction — same pattern as KycAttempt, for the same reason: a
 * decision to remove someone's listing has to be explainable afterwards,
 * including when it turns out to have been wrong.
 */

export class ModerationError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "ModerationError";
    this.code = code;
    this.status = status;
  }
}

/* ------------------------------------------------------------------ *
 * Reporting — open to any signed-in user
 * ------------------------------------------------------------------ */

export async function fileReport(input: {
  reporterId: string;
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  detail?: string | null;
}) {
  // Confirm the thing exists, so the queue is not filled with reports about
  // ids somebody made up.
  const exists = await targetExists(input.targetType, input.targetId);
  if (!exists) {
    throw new ModerationError("NOT_FOUND", "That doesn't exist.", 404);
  }

  /**
   * One open report per person per thing.
   *
   * Without this a single upset user can inflate the queue by reporting the
   * same listing eleven times, which buries everything else. Enforced here
   * rather than by an index because Prisma cannot express `WHERE status =
   * 'OPEN'`, and a plain unique would stop anyone ever reporting the same
   * listing again after an earlier report was resolved.
   */
  const already = await prisma.report.findFirst({
    where: {
      reporterId: input.reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      status: ReportStatus.OPEN,
    },
    select: { id: true },
  });
  if (already) {
    throw new ModerationError(
      "ALREADY_REPORTED",
      "You've already reported this. We're looking at it.",
      409
    );
  }

  const report = await prisma.report.create({
    data: {
      reporterId: input.reporterId,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason as never,
      detail: input.detail?.trim() || null,
    },
    select: { id: true, createdAt: true },
  });

  return { id: report.id, createdAt: report.createdAt.toISOString() };
}

async function targetExists(type: ReportTargetType, id: string) {
  if (type === ReportTargetType.LISTING) {
    return (await prisma.listing.count({ where: { id } })) > 0;
  }
  if (type === ReportTargetType.REVIEW) {
    return (await prisma.review.count({ where: { id } })) > 0;
  }
  return (await prisma.user.count({ where: { id } })) > 0;
}

/* ------------------------------------------------------------------ *
 * The queue
 * ------------------------------------------------------------------ */

export async function listReports(status: ReportStatus | "ALL" = ReportStatus.OPEN) {
  const rows = await prisma.report.findMany({
    where: status === "ALL" ? {} : { status },
    // Oldest first: a queue worked newest-first leaves the oldest complaint
    // permanently at the bottom.
    orderBy: { createdAt: "asc" },
    take: 200,
    select: {
      id: true,
      targetType: true,
      targetId: true,
      reason: true,
      detail: true,
      status: true,
      resolution: true,
      resolvedAt: true,
      createdAt: true,
      reporter: { select: { id: true, name: true } },
    },
  });

  // Resolve each target to something a human can read, so a moderator is not
  // looking at a list of UUIDs.
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      targetType: r.targetType,
      targetId: r.targetId,
      targetLabel: await describeTarget(r.targetType, r.targetId),
      reason: r.reason,
      detail: r.detail,
      status: r.status,
      resolution: r.resolution,
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      // The reporter's name, not their email. A moderator triaging a queue does
      // not need contact details to decide whether a listing breaks the rules.
      reporterName: r.reporter.name,
    }))
  );
}

async function describeTarget(type: ReportTargetType, id: string): Promise<string> {
  if (type === ReportTargetType.LISTING) {
    const l = await prisma.listing.findUnique({ where: { id }, select: { title: true } });
    return l?.title ?? "(listing no longer exists)";
  }
  if (type === ReportTargetType.REVIEW) {
    const r = await prisma.review.findUnique({
      where: { id },
      select: { body: true, listing: { select: { title: true } } },
    });
    if (!r) return "(review no longer exists)";
    return `Review on ${r.listing.title}: ${(r.body ?? "(no text)").slice(0, 60)}`;
  }
  const u = await prisma.user.findUnique({ where: { id }, select: { name: true } });
  return u?.name ?? "(account no longer exists)";
}

export async function reportCounts() {
  const [open, resolved, dismissed] = await Promise.all([
    prisma.report.count({ where: { status: ReportStatus.OPEN } }),
    prisma.report.count({ where: { status: ReportStatus.RESOLVED } }),
    prisma.report.count({ where: { status: ReportStatus.DISMISSED } }),
  ]);
  return { open, resolved, dismissed };
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

async function record(input: {
  moderatorId: string;
  action: ModerationActionType;
  targetType: ReportTargetType;
  targetId: string;
  reason: string;
  reportId?: string | null;
}) {
  await prisma.moderationAction.create({
    data: {
      moderatorId: input.moderatorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      reportId: input.reportId ?? null,
    },
  });
}

function requireReason(reason: string) {
  const trimmed = reason?.trim() ?? "";
  if (trimmed.length < 3) {
    // Not bureaucracy. The reason is shown to the person affected, and an
    // action nobody can explain later is indistinguishable from a mistake.
    throw new ModerationError("REASON_REQUIRED", "Write a reason. The person sees this.", 400);
  }
  return trimmed;
}

export async function removeListing(input: {
  moderatorId: string;
  listingId: string;
  reason: string;
  reportId?: string | null;
}) {
  const reason = requireReason(input.reason);

  const listing = await prisma.listing.findUnique({
    where: { id: input.listingId },
    // slug so the cached detail payload can be dropped after removal.
    select: {
      id: true,
      slug: true,
      title: true,
      deletedAt: true,
      seller: { select: { userId: true } },
    },
  });
  if (!listing) throw new ModerationError("NOT_FOUND", "Listing not found.", 404);
  if (listing.deletedAt) {
    throw new ModerationError("ALREADY_REMOVED", "That listing is already removed.", 409);
  }

  // Soft delete, like every other removal here: a listing referenced by a past
  // order must stay resolvable.
  await prisma.listing.update({
    where: { id: listing.id },
    data: { deletedAt: new Date(), status: ListingStatus.REMOVED },
  });

  /**
   * Load-bearing.
   *
   * A moderator removes a listing precisely because it should stop being
   * visible — usually urgently. Leaving it readable at its public URL for the
   * rest of the TTL would make the moderation action look like it had not
   * worked, which is the one place a stale cache is genuinely unacceptable.
   */
  await invalidate(listingKey(listing.slug));

  await record({
    moderatorId: input.moderatorId,
    action: ModerationActionType.LISTING_REMOVED,
    targetType: ReportTargetType.LISTING,
    targetId: listing.id,
    reason,
    reportId: input.reportId,
  });

  if (listing.seller?.userId) {
    void events.listingRemoved({
      sellerUserId: listing.seller.userId,
      itemTitle: listing.title,
      reason,
    });
  }
}

export async function restoreListing(input: {
  moderatorId: string;
  listingId: string;
  reason: string;
}) {
  const reason = requireReason(input.reason);

  const listing = await prisma.listing.findUnique({
    where: { id: input.listingId },
    select: { id: true, slug: true, deletedAt: true },
  });
  if (!listing) throw new ModerationError("NOT_FOUND", "Listing not found.", 404);
  if (!listing.deletedAt) {
    throw new ModerationError("NOT_REMOVED", "That listing isn't removed.", 409);
  }

  // Back to DRAFT, not ACTIVE. Restoring should hand control back to the
  // seller, not silently republish something to the whole marketplace.
  await prisma.listing.update({
    where: { id: listing.id },
    data: { deletedAt: null, status: ListingStatus.DRAFT },
  });

  // Drops the cached 404 from while it was removed.
  await invalidate(listingKey(listing.slug));

  await record({
    moderatorId: input.moderatorId,
    action: ModerationActionType.LISTING_RESTORED,
    targetType: ReportTargetType.LISTING,
    targetId: listing.id,
    reason,
  });
}

export async function removeReview(input: {
  moderatorId: string;
  reviewId: string;
  reason: string;
  reportId?: string | null;
}) {
  const reason = requireReason(input.reason);

  const review = await prisma.review.findUnique({
    where: { id: input.reviewId },
    select: { id: true },
  });
  if (!review) throw new ModerationError("NOT_FOUND", "Review not found.", 404);

  // Hard delete: a review has no downstream references, and leaving abusive
  // text in the table so it can be "audited later" is not a favour to anyone.
  // The action record below preserves that it happened and why.
  await prisma.review.delete({ where: { id: review.id } });

  await record({
    moderatorId: input.moderatorId,
    action: ModerationActionType.REVIEW_REMOVED,
    targetType: ReportTargetType.REVIEW,
    targetId: input.reviewId,
    reason,
    reportId: input.reportId,
  });
}

export async function suspendUser(input: {
  moderatorId: string;
  userId: string;
  reason: string;
  reportId?: string | null;
}) {
  const reason = requireReason(input.reason);

  if (input.userId === input.moderatorId) {
    throw new ModerationError("SELF", "You can't suspend yourself.", 400);
  }

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, role: true, suspendedAt: true },
  });
  if (!user) throw new ModerationError("NOT_FOUND", "Account not found.", 404);

  /**
   * Checked BEFORE the already-suspended state, deliberately.
   *
   * "Admins cannot be suspended from here" is categorical; "already suspended"
   * is a state. An account that is somehow both should hear the rule, not the
   * state — otherwise the answer to "can I suspend this admin?" depends on
   * whether they happen to be suspended already, which is nonsense.
   *
   * Admin is granted from a shell, so it should be removed from one too. An
   * admin able to suspend another admin through the UI is how one compromised
   * account locks everyone else out.
   */
  if (user.role === "ADMIN") {
    throw new ModerationError(
      "CANNOT_SUSPEND_ADMIN",
      "Admins can't be suspended from here. Revoke admin from the CLI first.",
      403
    );
  }
  if (user.suspendedAt) {
    throw new ModerationError("ALREADY_SUSPENDED", "That account is already suspended.", 409);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { suspendedAt: new Date(), suspendedReason: reason },
  });

  await record({
    moderatorId: input.moderatorId,
    action: ModerationActionType.USER_SUSPENDED,
    targetType: ReportTargetType.USER,
    targetId: user.id,
    reason,
    reportId: input.reportId,
  });

  // They cannot log in to read it, but it is there when they are reinstated —
  // and it means the reason exists somewhere other than an admin's memory.
  void events.accountSuspended({ userId: user.id, reason });
}

export async function reinstateUser(input: {
  moderatorId: string;
  userId: string;
  reason: string;
}) {
  const reason = requireReason(input.reason);

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, suspendedAt: true },
  });
  if (!user) throw new ModerationError("NOT_FOUND", "Account not found.", 404);
  if (!user.suspendedAt) {
    throw new ModerationError("NOT_SUSPENDED", "That account isn't suspended.", 409);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { suspendedAt: null, suspendedReason: null },
  });

  await record({
    moderatorId: input.moderatorId,
    action: ModerationActionType.USER_REINSTATED,
    targetType: ReportTargetType.USER,
    targetId: user.id,
    reason,
  });
}

/* ------------------------------------------------------------------ *
 * Closing reports
 * ------------------------------------------------------------------ */

export async function resolveReport(input: {
  moderatorId: string;
  reportId: string;
  outcome: string;
  dismissed: boolean;
}) {
  const outcome = requireReason(input.outcome);

  const report = await prisma.report.findUnique({
    where: { id: input.reportId },
    select: { id: true, status: true, reporterId: true },
  });
  if (!report) throw new ModerationError("NOT_FOUND", "Report not found.", 404);
  if (report.status !== ReportStatus.OPEN) {
    throw new ModerationError("ALREADY_CLOSED", "That report is already closed.", 409);
  }

  await prisma.report.update({
    where: { id: report.id },
    data: {
      // DISMISSED is a decision, not an absence of one. Recording "we looked
      // and found nothing wrong" separately from "we acted" is what stops a
      // queue looking permanently unfinished.
      status: input.dismissed ? ReportStatus.DISMISSED : ReportStatus.RESOLVED,
      resolution: outcome,
      resolvedAt: new Date(),
    },
  });

  if (input.dismissed) {
    await record({
      moderatorId: input.moderatorId,
      action: ModerationActionType.REPORT_DISMISSED,
      targetType: ReportTargetType.USER,
      targetId: report.reporterId,
      reason: outcome,
      reportId: report.id,
    });
  }

  void events.reportResolved({ reporterUserId: report.reporterId, outcome });
}

/** Everything a moderator has ever done, newest first. */
export async function auditLog(take = 100) {
  const rows = await prisma.moderationAction.findMany({
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      action: true,
      targetType: true,
      targetId: true,
      reason: true,
      reportId: true,
      createdAt: true,
      moderator: { select: { name: true, email: true } },
    },
  });

  return Promise.all(
    rows.map(async (a) => ({
      id: a.id,
      action: a.action,
      targetType: a.targetType,
      targetId: a.targetId,
      targetLabel: await describeTarget(a.targetType, a.targetId),
      reason: a.reason,
      reportId: a.reportId,
      createdAt: a.createdAt.toISOString(),
      moderator: a.moderator.name,
      moderatorEmail: a.moderator.email,
    }))
  );
}
