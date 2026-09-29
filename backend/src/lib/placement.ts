import { prisma } from "./prisma";
import { invalidate } from "./cache";
import { unreadKey } from "./cacheKeys";
import { isUniqueViolation } from "./pgErrors";
import { openThreadTx, postMessageTx } from "./messaging";
import {
  ListingStatus,
  MessageAuthor,
  NotificationType,
  PlacementSlot,
  PlacementStatus,
  ThreadKind,
} from "../generated/prisma/enums";

/**
 * Sellers asking to appear on the homepage, and the platform answering.
 *
 * NO MONEY MOVES ANYWHERE IN THIS FILE. `agreedCents` is what both sides
 * settled on, and settlement happens outside the application — there is no
 * seller-to-platform charge and ADR 0034 records why that boundary was drawn
 * rather than crossed.
 *
 * WHAT IS ACTUALLY LOAD-BEARING HERE
 * Exactly one thing: two listings must never hold the same live slot. Every
 * other transition is bookkeeping that a wrong answer makes untidy; that one
 * makes the homepage non-deterministic. It is guarded by a partial unique index
 * created in the migration, not by a check in this file:
 *
 *     CREATE UNIQUE INDEX placement_live_slot
 *       ON placement_requests (slot, position) WHERE status = 'LIVE';
 *
 * So `activate()` is an UPDATE that either commits or raises a unique
 * violation, and the violation is the ordinary losing outcome of a race rather
 * than an error. Same discipline as stock (ADR 0012), payment (ADR 0013) and
 * payouts (ADR 0030).
 *
 * See docs/adr/0034-paid-homepage-placement.md
 */

/** How many positions each slot has. The hero is one banner; the shelf is four cards. */
const SLOT_POSITIONS: Record<PlacementSlot, number> = {
  [PlacementSlot.HERO]: 1,
  [PlacementSlot.PICKED_SHELF]: 4,
};

export function positionsFor(slot: PlacementSlot): number {
  return SLOT_POSITIONS[slot];
}

/** States from which the seller still owns the next move. */
const SELLER_CAN_WITHDRAW: PlacementStatus[] = [
  PlacementStatus.REQUESTED,
  PlacementStatus.COUNTERED,
  PlacementStatus.AGREED,
];

/** States an admin can still answer — the transition guard for counter/decline. */
const AWAITING_ADMIN: PlacementStatus[] = [PlacementStatus.REQUESTED, PlacementStatus.COUNTERED];

/**
 * States that need a moderator to DO something, which is a wider set than the
 * ones they can answer.
 *
 * `AGREED` belongs here and the omission was a real bug, found by driving the
 * panel in a browser: an agreed placement is waiting to be made live, the
 * button to do it only appears on an agreed row, and the queue's default filter
 * hid exactly those rows. The negotiation completed and then stalled somewhere
 * nobody looks.
 */
const NEEDS_ADMIN: PlacementStatus[] = [
  PlacementStatus.REQUESTED,
  PlacementStatus.COUNTERED,
  PlacementStatus.AGREED,
];

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function period(startsAt: Date | null, endsAt: Date | null): string {
  if (!startsAt || !endsAt) return "dates to be agreed";
  const d = (x: Date) => x.toISOString().slice(0, 10);
  return `${d(startsAt)} to ${d(endsAt)}`;
}

function slotName(slot: PlacementSlot, position: number): string {
  return slot === PlacementSlot.HERO
    ? "the homepage hero banner"
    : `the "Picked for you" shelf, position ${position + 1}`;
}

/* ------------------------------------------------------------------ *
 * Asking
 * ------------------------------------------------------------------ */

export type RequestOutcome =
  | { requested: true; id: string; threadId: string }
  | {
      requested: false;
      reason: "no-listing" | "not-yours" | "not-active" | "bad-position" | "already-open";
    };

/**
 * A seller asks for a slot.
 *
 * The request and the thread carrying its negotiation are one transaction. A
 * request with no thread cannot be answered and a thread with no request is
 * noise in the moderator queue, so neither is allowed to exist alone.
 */
export async function requestPlacement(input: {
  sellerId: string;
  listingId: string;
  slot: PlacementSlot;
  position?: number;
  offeredCents: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
  note: string;
}): Promise<RequestOutcome> {
  const position = input.position ?? 0;
  if (position < 0 || position >= positionsFor(input.slot)) {
    return { requested: false, reason: "bad-position" };
  }

  const listing = await prisma.listing.findFirst({
    where: { id: input.listingId, deletedAt: null },
    select: { id: true, sellerId: true, status: true, title: true },
  });
  if (!listing) return { requested: false, reason: "no-listing" };

  /**
   * 404-shaped rather than 403-shaped at the route, the same policy as sales,
   * payouts and returns: an id must not be usable to ask whether somebody
   * else's listing exists.
   */
  if (listing.sellerId !== input.sellerId) return { requested: false, reason: "not-yours" };

  /**
   * A draft or sold listing cannot be promoted. Promoting something nobody can
   * buy spends a slot on a 404, and the homepage filters on ACTIVE anyway — so
   * the request would be honoured and invisible.
   */
  if (listing.status !== ListingStatus.ACTIVE) return { requested: false, reason: "not-active" };

  /**
   * One open conversation per listing. Without this a seller can open twenty
   * requests for the same item and the moderator queue becomes unusable — and
   * unlike the live-slot claim this is a courtesy rather than a correctness
   * guard, so it is a read-then-write and says so.
   */
  const open = await prisma.placementRequest.count({
    where: {
      listingId: listing.id,
      status: { in: [...AWAITING_ADMIN, PlacementStatus.AGREED, PlacementStatus.LIVE] },
    },
  });
  if (open > 0) return { requested: false, reason: "already-open" };

  const seller = await prisma.sellerProfile.findUnique({
    where: { id: input.sellerId },
    select: { userId: true },
  });
  if (!seller) return { requested: false, reason: "not-yours" };

  const created = await prisma.$transaction(async (tx) => {
    const thread = await openThreadTx(tx, {
      sellerId: input.sellerId,
      kind: ThreadKind.PLACEMENT,
      subject: `Homepage placement — ${listing.title}`,
      body:
        `I'd like ${slotName(input.slot, position)} for "${listing.title}", ` +
        `${period(input.startsAt ?? null, input.endsAt ?? null)}, and I'm offering ` +
        `${money(input.offeredCents)}.\n\n${input.note.trim()}`,
      author: MessageAuthor.SELLER,
      authorUserId: seller.userId,
    });

    const placement = await tx.placementRequest.create({
      data: {
        listingId: listing.id,
        sellerId: input.sellerId,
        slot: input.slot,
        position,
        offeredCents: input.offeredCents,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        threadId: thread.threadId,
      },
      select: { id: true },
    });

    return { id: placement.id, threadId: thread.threadId, recipientIds: thread.recipientIds };
  });

  await invalidate(...created.recipientIds.map(unreadKey));
  return { requested: true, id: created.id, threadId: created.threadId };
}

/* ------------------------------------------------------------------ *
 * Answering
 * ------------------------------------------------------------------ */

export type DecideOutcome =
  | { changed: true; status: PlacementStatus }
  | { changed: false; reason: "no-placement" | "wrong-state" | "bad-position" };

/**
 * Every transition below is a conditional `UPDATE` with the permitted `status`
 * values in the `WHERE`. A count of zero means somebody else moved it first,
 * which the caller reports as "wrong-state" rather than retrying — two
 * moderators answering one request must not both succeed, and the second one
 * needs to reload rather than overwrite.
 */
async function transition(
  id: string,
  from: PlacementStatus[],
  to: PlacementStatus,
  data: Record<string, unknown>,
  message: { author: MessageAuthor; authorUserId: string; body: string }
): Promise<DecideOutcome> {
  const placement = await prisma.placementRequest.findUnique({
    where: { id },
    select: { threadId: true },
  });
  if (!placement) return { changed: false, reason: "no-placement" };

  const result = await prisma.$transaction(async (tx) => {
    const moved = await tx.placementRequest.updateMany({
      where: { id, status: { in: from } },
      data: { ...data, status: to },
    });
    if (moved.count !== 1) return null;

    /**
     * PLACEMENT_DECIDED rather than MESSAGE_RECEIVED, so one action produces
     * one notification. The message body carries the terms, which is what makes
     * the thread readable as a negotiation rather than as a status log.
     */
    return postMessageTx(tx, {
      threadId: placement.threadId,
      author: message.author,
      authorUserId: message.authorUserId,
      body: message.body,
      notificationType: NotificationType.PLACEMENT_DECIDED,
    });
  });

  if (result === null) return { changed: false, reason: "wrong-state" };
  await invalidate(...result.recipientIds.map(unreadKey));
  return { changed: true, status: to };
}

/** A moderator proposes different terms. Back with the seller. */
export async function counterOffer(input: {
  id: string;
  adminUserId: string;
  agreedCents: number;
  slot?: PlacementSlot;
  position?: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
  note: string;
}): Promise<DecideOutcome> {
  const current = await prisma.placementRequest.findUnique({
    where: { id: input.id },
    select: { slot: true, position: true, startsAt: true, endsAt: true },
  });
  if (!current) return { changed: false, reason: "no-placement" };

  const slot = input.slot ?? current.slot;
  const position = input.position ?? (input.slot ? 0 : current.position);
  if (position < 0 || position >= positionsFor(slot)) {
    return { changed: false, reason: "bad-position" };
  }

  const startsAt = input.startsAt ?? current.startsAt;
  const endsAt = input.endsAt ?? current.endsAt;

  return transition(
    input.id,
    AWAITING_ADMIN,
    PlacementStatus.COUNTERED,
    { agreedCents: input.agreedCents, slot, position, startsAt, endsAt },
    {
      author: MessageAuthor.ADMIN,
      authorUserId: input.adminUserId,
      body:
        `We can offer ${slotName(slot, position)}, ${period(startsAt, endsAt)}, ` +
        `at ${money(input.agreedCents)}.\n\n${input.note.trim()}`,
    }
  );
}

/** A moderator accepts what the seller offered, unchanged. */
export async function acceptAsOffered(input: {
  id: string;
  adminUserId: string;
  note?: string;
}): Promise<DecideOutcome> {
  const current = await prisma.placementRequest.findUnique({
    where: { id: input.id },
    select: { offeredCents: true, slot: true, position: true, startsAt: true, endsAt: true },
  });
  if (!current) return { changed: false, reason: "no-placement" };

  return transition(
    input.id,
    [PlacementStatus.REQUESTED],
    PlacementStatus.AGREED,
    { agreedCents: current.offeredCents, decidedById: input.adminUserId, decidedAt: new Date() },
    {
      author: MessageAuthor.ADMIN,
      authorUserId: input.adminUserId,
      body:
        `Agreed at ${money(current.offeredCents)} for ${slotName(current.slot, current.position)}, ` +
        `${period(current.startsAt, current.endsAt)}.` +
        (input.note ? `\n\n${input.note.trim()}` : ""),
    }
  );
}

/** The seller accepts the moderator's counter. */
export async function acceptCounter(input: {
  id: string;
  sellerUserId: string;
  note?: string;
}): Promise<DecideOutcome> {
  const current = await prisma.placementRequest.findUnique({
    where: { id: input.id },
    select: { agreedCents: true, slot: true, position: true, startsAt: true, endsAt: true },
  });
  if (!current) return { changed: false, reason: "no-placement" };

  return transition(
    input.id,
    [PlacementStatus.COUNTERED],
    PlacementStatus.AGREED,
    { decidedAt: new Date() },
    {
      author: MessageAuthor.SELLER,
      authorUserId: input.sellerUserId,
      body:
        `That works — ${money(current.agreedCents ?? 0)} for ` +
        `${slotName(current.slot, current.position)}, ${period(current.startsAt, current.endsAt)}.` +
        (input.note ? `\n\n${input.note.trim()}` : ""),
    }
  );
}

/** A moderator says no. Terminal. */
export async function declinePlacement(input: {
  id: string;
  adminUserId: string;
  note: string;
}): Promise<DecideOutcome> {
  return transition(
    input.id,
    AWAITING_ADMIN,
    PlacementStatus.DECLINED,
    { decidedById: input.adminUserId, decidedAt: new Date() },
    {
      author: MessageAuthor.ADMIN,
      authorUserId: input.adminUserId,
      body: `We're not able to offer that placement.\n\n${input.note.trim()}`,
    }
  );
}

/** The seller pulls the request. Terminal, and allowed even after AGREED. */
export async function withdrawPlacement(input: {
  id: string;
  sellerId: string;
  sellerUserId: string;
  note?: string;
}): Promise<DecideOutcome> {
  const owned = await prisma.placementRequest.findFirst({
    where: { id: input.id, sellerId: input.sellerId },
    select: { id: true },
  });
  if (!owned) return { changed: false, reason: "no-placement" };

  return transition(
    input.id,
    SELLER_CAN_WITHDRAW,
    PlacementStatus.WITHDRAWN,
    {},
    {
      author: MessageAuthor.SELLER,
      authorUserId: input.sellerUserId,
      body: `I'd like to withdraw this request.${input.note ? `\n\n${input.note.trim()}` : ""}`,
    }
  );
}

/* ------------------------------------------------------------------ *
 * Going live — the only transition that can lose a race
 * ------------------------------------------------------------------ */

export type ActivateOutcome =
  | { activated: true }
  /**
   * `slot-taken` is NOT an error. It is the partial unique index doing the job
   * it was created for: somebody else's agreement is already live in this slot,
   * so this one stays AGREED and can be activated when that one ends.
   */
  | { activated: false; reason: "no-placement" | "wrong-state" | "slot-taken" };

export async function activate(id: string): Promise<ActivateOutcome> {
  const placement = await prisma.placementRequest.findUnique({
    where: { id },
    select: { threadId: true, slot: true, position: true, agreedCents: true, endsAt: true },
  });
  if (!placement) return { activated: false, reason: "no-placement" };

  try {
    const moved = await prisma.placementRequest.updateMany({
      where: { id, status: PlacementStatus.AGREED },
      data: { status: PlacementStatus.LIVE },
    });
    if (moved.count !== 1) return { activated: false, reason: "wrong-state" };
  } catch (err) {
    /**
     * The index raises Postgres's own 23505 rather than Prisma's P2002, because
     * it is a constraint Prisma does not know about — which is exactly why
     * `isUniqueViolation` had to learn both codes.
     */
    if (isUniqueViolation(err)) return { activated: false, reason: "slot-taken" };
    throw err;
  }

  return { activated: true };
}

/** The period ran out, or a moderator pulled it early. */
export async function endPlacement(id: string): Promise<boolean> {
  const ended = await prisma.placementRequest.updateMany({
    where: { id, status: PlacementStatus.LIVE },
    data: { status: PlacementStatus.ENDED },
  });
  return ended.count === 1;
}

/* ------------------------------------------------------------------ *
 * What the homepage reads
 * ------------------------------------------------------------------ */

export type LivePlacement = {
  id: string;
  slot: PlacementSlot;
  position: number;
  listingId: string;
  slug: string;
};

/**
 * The live placements, and ONLY for listings somebody can still buy.
 *
 * A promoted listing that sells drops off the homepage the moment it does. The
 * agreement stays LIVE until its period ends, which is only tenable because no
 * money was taken for it — if the charge is ever built, this is the case that
 * needs a policy first (ADR 0034).
 */
export async function livePlacements(): Promise<LivePlacement[]> {
  const rows = await prisma.placementRequest.findMany({
    where: {
      status: PlacementStatus.LIVE,
      listing: { status: ListingStatus.ACTIVE, deletedAt: null },
    },
    select: {
      id: true,
      slot: true,
      position: true,
      listingId: true,
      listing: { select: { slug: true } },
    },
    orderBy: [{ slot: "asc" }, { position: "asc" }],
  });

  return rows.map((r) => ({
    id: r.id,
    slot: r.slot,
    position: r.position,
    listingId: r.listingId,
    slug: r.listing.slug,
  }));
}

/* ------------------------------------------------------------------ *
 * The sweeper's two jobs (wired in phase 7)
 * ------------------------------------------------------------------ */

/**
 * Starts what is due and ends what is over.
 *
 * Activation is attempted one at a time rather than in bulk, because each one
 * can individually lose the slot claim and a bulk `updateMany` would either
 * take the whole batch or none of it. A slot already held is left AGREED and
 * retried on the next pass, which is how a queued placement starts the moment
 * the one in front of it ends.
 */
export async function sweepPlacements(now = new Date()): Promise<{
  activated: number;
  blocked: number;
  ended: number;
}> {
  const ended = await prisma.placementRequest.updateMany({
    where: { status: PlacementStatus.LIVE, endsAt: { not: null, lte: now } },
    data: { status: PlacementStatus.ENDED },
  });

  const due = await prisma.placementRequest.findMany({
    where: {
      status: PlacementStatus.AGREED,
      startsAt: { not: null, lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  let activated = 0;
  let blocked = 0;
  for (const row of due) {
    const outcome = await activate(row.id);
    if (outcome.activated) activated++;
    else if (!outcome.activated && outcome.reason === "slot-taken") blocked++;
  }

  return { activated, blocked, ended: ended.count };
}

/**
 * Every minute.
 *
 * A placement has a start date, and a seller who bought a window starting
 * Monday expects it on Monday rather than whenever somebody next opens the
 * panel. A minute is the smallest unit the dates are meaningful in, and the
 * sweep is two indexed queries against a table with a handful of rows in the
 * states it looks at.
 *
 * IN-PROCESS, ON EVERY REPLICA, and that is safe rather than wasteful — the
 * same reasoning as the other five (ADR 0032). Ending is one conditional
 * `updateMany`, and activating is a claim against the partial unique index, so
 * N replicas sweeping at once produce one winner per slot and the losers report
 * `slot-taken`. Nothing is done twice and nothing is done N times.
 *
 * NOT A CronJob, unlike payouts. That one is scheduled because it MOVES MONEY
 * TO A THIRD PARTY and wanted an exit code and a record; this one changes a
 * status on a row we own. The distinction is the one ADR 0032 drew, and it is
 * worth keeping: a CronJob per sweeper would serialise work that currently
 * parallelises.
 */
export function startPlacementSweeper(intervalMs = 60_000) {
  async function tick() {
    try {
      const { activated, blocked, ended } = await sweepPlacements();
      /**
       * Silent when nothing happened, which is almost always. `blocked` is in
       * the line because a nonzero value is NOT a fault — it is a placement
       * queued behind a live one — and a reader who sees it needs to know that
       * without going to look it up.
       */
      if (activated > 0 || ended > 0 || blocked > 0) {
        console.log(
          `Placements: ${activated} live, ${ended} ended, ${blocked} waiting for a slot`
        );
      }
    } catch (err) {
      console.error("Placement sweeper failed", err);
    }
  }

  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

const placementSelect = {
  id: true,
  slot: true,
  position: true,
  offeredCents: true,
  agreedCents: true,
  startsAt: true,
  endsAt: true,
  status: true,
  threadId: true,
  createdAt: true,
  decidedAt: true,
  listing: { select: { id: true, title: true, slug: true, status: true } },
} as const;

export async function placementsForSeller(sellerId: string) {
  return prisma.placementRequest.findMany({
    where: { sellerId },
    select: placementSelect,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

/** The moderator queue: everything needing a moderator's hand, oldest first. */
export async function placementQueue(opts: { pendingOnly?: boolean } = {}) {
  return prisma.placementRequest.findMany({
    where: opts.pendingOnly ? { status: { in: NEEDS_ADMIN } } : {},
    select: { ...placementSelect, seller: { select: { id: true, shopName: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    take: 100,
  });
}

export async function placementDetail(id: string, sellerId?: string) {
  return prisma.placementRequest.findFirst({
    where: { id, ...(sellerId ? { sellerId } : {}) },
    select: { ...placementSelect, seller: { select: { id: true, shopName: true } } },
  });
}
