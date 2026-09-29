import { prisma, requireServices } from "../lib/db";
import { main, wireInterrupt, cleanupOnInterrupt } from "../lib/harness";
import { readFileSync } from "fs";
import {
  acceptAsOffered,
  acceptCounter,
  activate,
  counterOffer,
  declinePlacement,
  endPlacement,
  livePlacements,
  placementDetail,
  placementQueue,
  placementsForSeller,
  requestPlacement,
  startPlacementSweeper,
  sweepPlacements,
  withdrawPlacement,
} from "../../src/lib/placement";
import {
  Condition,
  ListingStatus,
  NotificationType,
  PlacementSlot,
  PlacementStatus,
} from "../../src/generated/prisma/enums";

/**
 * Paid homepage placement, negotiated and then claimed.
 *
 * WHAT THIS SUITE IS FOR
 * One assertion in section 4 is the reason this file exists. Everything else is
 * bookkeeping whose failure is untidy; that one is the difference between a
 * homepage and a coin flip.
 *
 * Two moderators activate two agreements for the same slot in the same instant.
 * A read-then-write implementation passes its own check in both and writes
 * twice, and the homepage then has two heroes — which renders as whichever row
 * Postgres happens to return first, changing between requests, on a page
 * somebody has been charged for. The guard is a partial unique index and the
 * loser is TOLD it lost rather than erroring, so it can go live when the slot
 * frees.
 *
 * The parallel test is `Promise.all`, not two sequential calls. Sequential
 * calls pass against a broken implementation.
 *
 * See docs/adr/0034-paid-homepage-placement.md
 */

const TAG = `rs2.place.${Date.now()}`;
const DAY = 24 * 3600_000;

let sellerUserId = "";
let sellerId = "";
let otherSellerId = "";
let adminA = "";
let adminB = "";
let categoryId = "";
const listingIds: string[] = [];
const threadIds: string[] = [];

async function makeListing(opts: {
  title: string;
  status: ListingStatus;
  owner?: string;
}): Promise<string> {
  const n = listingIds.length + 1;
  const listing = await prisma.listing.create({
    data: {
      slug: `${TAG}-${n}`,
      title: opts.title,
      description: "Sound, honestly described, and photographed with its flaws.",
      sellerId: opts.owner ?? sellerId,
      categoryId,
      condition: Condition.GOOD,
      priceCents: 4500 + n * 100,
      quantity: 1,
      status: opts.status,
    },
    select: { id: true },
  });
  listingIds.push(listing.id);
  return listing.id;
}

/** Every notification raised for one thread, by type. */
async function notesFor(threadId: string) {
  return prisma.notification.groupBy({
    by: ["type"],
    where: { link: { contains: threadId } },
    _count: { _all: true },
  });
}

void main(
  "homepage placement",

  async (t) => {
    await requireServices({ api: false, db: true });

    /* ---- fixture ---- */

    const category = await prisma.category.findFirst({ select: { id: true } });
    if (!category) throw new Error("no categories — run `npm run seed` first");
    categoryId = category.id;

    const sellerUser = await prisma.user.create({
      data: {
        email: `${TAG}.seller@retailstore-2n.test`,
        name: "Placement Seller",
        passwordHash: "not-a-real-hash",
        emailVerified: true,
        isSeller: true,
      },
      select: { id: true },
    });
    sellerUserId = sellerUser.id;
    const profile = await prisma.sellerProfile.create({
      data: { userId: sellerUserId, shopName: "Ferrous & Fern" },
      select: { id: true },
    });
    sellerId = profile.id;

    const otherUser = await prisma.user.create({
      data: {
        email: `${TAG}.other@retailstore-2n.test`,
        name: "Other Seller",
        passwordHash: "not-a-real-hash",
        emailVerified: true,
        isSeller: true,
      },
      select: { id: true },
    });
    const otherProfile = await prisma.sellerProfile.create({
      data: { userId: otherUser.id, shopName: "Somebody Else" },
      select: { id: true },
    });
    otherSellerId = otherProfile.id;

    for (const label of ["a", "b"] as const) {
      const u = await prisma.user.create({
        data: {
          email: `${TAG}.admin-${label}@retailstore-2n.test`,
          name: `Moderator ${label}`,
          passwordHash: "not-a-real-hash",
          emailVerified: true,
          role: "ADMIN",
        },
        select: { id: true },
      });
      if (label === "a") adminA = u.id;
      else adminB = u.id;
    }

    const kettle = await makeListing({ title: "Enamel camping kettle", status: ListingStatus.ACTIVE });
    const skillet = await makeListing({ title: "Cast iron skillet", status: ListingStatus.ACTIVE });
    const draft = await makeListing({ title: "Unfinished draft", status: ListingStatus.DRAFT });
    const notMine = await makeListing({
      title: "Not my listing",
      status: ListingStatus.ACTIVE,
      owner: otherSellerId,
    });

    /* ---- 1. who may ask, and for what ---- */

    t.section("1. what makes a request valid");

    const noListing = await requestPlacement({
      sellerId,
      listingId: "00000000-0000-0000-0000-000000000000",
      slot: PlacementSlot.HERO,
      offeredCents: 4000,
      note: "A listing that does not exist.",
    });
    t.check(
      !noListing.requested && noListing.reason === "no-listing",
      "a listing that does not exist is refused"
    );

    const theirs = await requestPlacement({
      sellerId,
      listingId: notMine,
      slot: PlacementSlot.HERO,
      offeredCents: 4000,
      note: "Somebody else's item.",
    });
    t.check(
      !theirs.requested && theirs.reason === "not-yours",
      "another seller's listing is refused, so an id cannot probe the catalogue"
    );

    const isDraft = await requestPlacement({
      sellerId,
      listingId: draft,
      slot: PlacementSlot.HERO,
      offeredCents: 4000,
      note: "Not published yet.",
    });
    t.check(
      !isDraft.requested && isDraft.reason === "not-active",
      "a draft cannot be promoted — the slot would point at nothing buyable"
    );

    const badPos = await requestPlacement({
      sellerId,
      listingId: kettle,
      slot: PlacementSlot.HERO,
      position: 2,
      offeredCents: 4000,
      note: "The hero has one position.",
    });
    t.check(
      !badPos.requested && badPos.reason === "bad-position",
      "the hero has exactly one position, and position 2 is refused"
    );

    const shelfPos = await requestPlacement({
      sellerId,
      listingId: kettle,
      slot: PlacementSlot.PICKED_SHELF,
      position: 4,
      offeredCents: 1500,
      note: "The shelf has four.",
    });
    t.check(
      !shelfPos.requested && shelfPos.reason === "bad-position",
      "and the shelf's four positions are 0 to 3, so 4 is refused"
    );

    /* ---- 2. the negotiation ---- */

    t.section("2. asking, countering, agreeing");

    const asked = await requestPlacement({
      sellerId,
      listingId: kettle,
      slot: PlacementSlot.HERO,
      offeredCents: 4000,
      startsAt: new Date(Date.now() + DAY),
      endsAt: new Date(Date.now() + 8 * DAY),
      note: "It photographs well and it is the nicest thing I have listed.",
    });
    t.check(asked.requested, "a valid request is accepted", JSON.stringify(asked));
    if (!asked.requested) return;
    threadIds.push(asked.threadId);

    const withThread = await prisma.placementRequest.findUniqueOrThrow({
      where: { id: asked.id },
      select: { threadId: true, status: true, thread: { select: { subject: true, kind: true } } },
    });
    t.check(
      withThread.status === PlacementStatus.REQUESTED,
      "it starts in REQUESTED"
    );
    t.check(
      withThread.thread.kind === "PLACEMENT" &&
        withThread.thread.subject.startsWith("Homepage placement —"),
      "and it came with the thread that will carry the negotiation"
    );

    const dupe = await requestPlacement({
      sellerId,
      listingId: kettle,
      slot: PlacementSlot.PICKED_SHELF,
      offeredCents: 1000,
      note: "Asking twice for the same item.",
    });
    t.check(
      !dupe.requested && dupe.reason === "already-open",
      "a second open request for the same listing is refused"
    );

    const countered = await counterOffer({
      id: asked.id,
      adminUserId: adminA,
      agreedCents: 6000,
      note: "The hero is our most valuable slot, so $60 for the week.",
    });
    t.check(countered.changed, "a moderator can counter", JSON.stringify(countered));

    const afterCounter = await prisma.placementRequest.findUniqueOrThrow({
      where: { id: asked.id },
      select: { status: true, offeredCents: true, agreedCents: true },
    });
    t.check(afterCounter.status === PlacementStatus.COUNTERED, "the request is now COUNTERED");
    t.check(
      afterCounter.offeredCents === 4000 && afterCounter.agreedCents === 6000,
      "what was offered and what was countered are both kept",
      `offered ${afterCounter.offeredCents}, agreed ${afterCounter.agreedCents}`
    );

    const accepted = await acceptCounter({ id: asked.id, sellerUserId });
    t.check(accepted.changed, "the seller can accept the counter");
    t.check(
      (
        await prisma.placementRequest.findUniqueOrThrow({
          where: { id: asked.id },
          select: { status: true },
        })
      ).status === PlacementStatus.AGREED,
      "which reaches AGREED"
    );

    t.section("2b. one action raises one notification");

    const byType = await notesFor(asked.threadId);
    const decided =
      byType.find((r) => r.type === NotificationType.PLACEMENT_DECIDED)?._count._all ?? 0;
    const plainMessages =
      byType.find((r) => r.type === NotificationType.MESSAGE_RECEIVED)?._count._all ?? 0;
    t.check(
      decided > 0,
      "a placement decision is announced as PLACEMENT_DECIDED",
      `${decided} decision notification(s)`
    );
    t.check(
      plainMessages > 0,
      "and the opening request itself was an ordinary message",
      `${plainMessages} message notification(s)`
    );

    /* ---- 3. transitions refuse to run twice ---- */

    t.section("3. every transition is a conditional UPDATE");

    const counterAgain = await counterOffer({
      id: asked.id,
      adminUserId: adminB,
      agreedCents: 9000,
      note: "Too late — this is already agreed.",
    });
    t.check(
      !counterAgain.changed && counterAgain.reason === "wrong-state",
      "an AGREED request cannot be countered, and says wrong-state rather than overwriting"
    );

    const secondAsk = await requestPlacement({
      sellerId,
      listingId: skillet,
      slot: PlacementSlot.HERO,
      offeredCents: 5000,
      note: "Also for the hero, which is the interesting part.",
    });
    t.check(secondAsk.requested, "a second listing can ask for the same slot");
    if (!secondAsk.requested) return;
    threadIds.push(secondAsk.threadId);

    const declineRace = await Promise.all([
      declinePlacement({ id: secondAsk.id, adminUserId: adminA, note: "Not this one." }),
      declinePlacement({ id: secondAsk.id, adminUserId: adminB, note: "Also not this one." }),
    ]);
    const declineWins = declineRace.filter((r) => r.changed).length;
    t.check(
      declineWins === 1,
      "two moderators declining the same request produce exactly one decision",
      `${declineWins} succeeded`
    );

    /* ---- 4. THE ONE THAT MATTERS ---- */

    t.section("4. two agreements, one slot, activated in parallel");

    const heroes: string[] = [];
    for (const [n, title] of [
      [1, "First hero candidate"],
      [2, "Second hero candidate"],
    ] as const) {
      const listing = await makeListing({ title, status: ListingStatus.ACTIVE });
      const req = await requestPlacement({
        sellerId,
        listingId: listing,
        slot: PlacementSlot.HERO,
        offeredCents: 5000 + n,
        note: `Candidate ${n} for the hero slot.`,
      });
      if (!req.requested) throw new Error(`fixture: request ${n} failed`);
      threadIds.push(req.threadId);
      const ok = await acceptAsOffered({ id: req.id, adminUserId: adminA });
      if (!ok.changed) throw new Error(`fixture: agreement ${n} failed`);
      heroes.push(req.id);
    }

    t.check(heroes.length === 2, "two agreements both reached AGREED for HERO position 0");

    /**
     * Promise.all, deliberately. Sequential activation would pass against an
     * implementation with no constraint at all, because the second call would
     * see the first row already LIVE.
     */
    const race = await Promise.all([activate(heroes[0]!), activate(heroes[1]!)]);
    const won = race.filter((r) => r.activated).length;
    const lost = race.filter((r) => !r.activated && r.reason === "slot-taken").length;

    t.check(won === 1, "exactly one activation won", `${won} won`);
    t.check(
      lost === 1,
      "and the other was told the slot was taken, not handed an error",
      `${lost} reported slot-taken: ${JSON.stringify(race)}`
    );

    const liveCount = await prisma.placementRequest.count({
      where: { id: { in: heroes }, status: PlacementStatus.LIVE },
    });
    t.check(liveCount === 1, "one LIVE row in the database", `found ${liveCount}`);

    const loserStillAgreed = await prisma.placementRequest.count({
      where: { id: { in: heroes }, status: PlacementStatus.AGREED },
    });
    t.check(
      loserStillAgreed === 1,
      "and the loser is still AGREED, so it can go live when the slot frees"
    );

    /* ---- 5. the slot frees ---- */

    t.section("5. when the live one ends, the queued one can start");

    const liveRow = await prisma.placementRequest.findFirstOrThrow({
      where: { id: { in: heroes }, status: PlacementStatus.LIVE },
      select: { id: true },
    });
    const queued = heroes.find((h) => h !== liveRow.id)!;

    t.check(
      (await activate(queued)).activated === false,
      "the queued one still cannot activate while the slot is held"
    );

    t.check(await endPlacement(liveRow.id), "ending the live placement succeeds");
    t.check(
      !(await endPlacement(liveRow.id)),
      "ending it again is a no-op — a conditional UPDATE, not a blind write"
    );

    const nowActivated = await activate(queued);
    t.check(
      nowActivated.activated,
      "and now the queued placement goes live",
      JSON.stringify(nowActivated)
    );

    /* ---- 6. what the homepage sees ---- */

    t.section("6. the homepage only sees live placements on buyable listings");

    const live = await livePlacements();
    t.check(
      live.some((p) => p.id === queued),
      "a LIVE placement appears"
    );
    t.check(
      !live.some((p) => p.id === liveRow.id),
      "an ENDED one does not"
    );

    const queuedRow = await prisma.placementRequest.findUniqueOrThrow({
      where: { id: queued },
      select: { listingId: true },
    });
    await prisma.listing.update({
      where: { id: queuedRow.listingId },
      data: { status: ListingStatus.SOLD },
    });

    const afterSold = await livePlacements();
    t.check(
      !afterSold.some((p) => p.id === queued),
      "and a promoted listing that SELLS drops off immediately"
    );
    t.check(
      (
        await prisma.placementRequest.findUniqueOrThrow({
          where: { id: queued },
          select: { status: true },
        })
      ).status === PlacementStatus.LIVE,
      "while the agreement itself stays LIVE — no money was taken, so nothing is owed back"
    );

    await prisma.listing.update({
      where: { id: queuedRow.listingId },
      data: { status: ListingStatus.ACTIVE },
    });

    /* ---- 7. the sweeper ---- */

    t.section("7. the sweeper starts what is due and ends what is over");

    await prisma.placementRequest.updateMany({
      where: { id: queued },
      data: { status: PlacementStatus.LIVE, endsAt: new Date(Date.now() - DAY) },
    });

    const shelfListing = await makeListing({
      title: "Shelf candidate",
      status: ListingStatus.ACTIVE,
    });
    const shelfReq = await requestPlacement({
      sellerId,
      listingId: shelfListing,
      slot: PlacementSlot.PICKED_SHELF,
      position: 1,
      offeredCents: 1200,
      startsAt: new Date(Date.now() - DAY),
      endsAt: new Date(Date.now() + 7 * DAY),
      note: "Due to start yesterday, so the sweeper should pick it up.",
    });
    if (!shelfReq.requested) throw new Error("fixture: shelf request failed");
    threadIds.push(shelfReq.threadId);
    await acceptAsOffered({ id: shelfReq.id, adminUserId: adminA });

    const swept = await sweepPlacements();
    t.check(
      swept.ended >= 1,
      "the expired placement was ended",
      `ended ${swept.ended}`
    );
    t.check(
      swept.activated >= 1,
      "and the one whose start date had arrived went live",
      `activated ${swept.activated}, blocked ${swept.blocked}`
    );
    t.check(
      (
        await prisma.placementRequest.findUniqueOrThrow({
          where: { id: shelfReq.id },
          select: { status: true },
        })
      ).status === PlacementStatus.LIVE,
      "the shelf placement is LIVE without anybody pressing anything"
    );

    /* ---- 8. withdrawing, and scoping ---- */

    t.section("8. a seller can withdraw, and only their own");

    const toWithdraw = await makeListing({
      title: "Second thoughts",
      status: ListingStatus.ACTIVE,
    });
    const wReq = await requestPlacement({
      sellerId,
      listingId: toWithdraw,
      slot: PlacementSlot.PICKED_SHELF,
      position: 3,
      offeredCents: 900,
      note: "I may change my mind about this one.",
    });
    if (!wReq.requested) throw new Error("fixture: withdraw request failed");
    threadIds.push(wReq.threadId);
    await acceptAsOffered({ id: wReq.id, adminUserId: adminA });

    const notTheirs = await withdrawPlacement({
      id: wReq.id,
      sellerId: otherSellerId,
      sellerUserId: sellerUserId,
    });
    t.check(
      !notTheirs.changed && notTheirs.reason === "no-placement",
      "another seller cannot withdraw it, and gets the same answer as 'does not exist'"
    );

    const withdrawn = await withdrawPlacement({ id: wReq.id, sellerId, sellerUserId });
    t.check(withdrawn.changed, "the owner can withdraw even after agreeing");
    t.check(
      (
        await prisma.placementRequest.findUniqueOrThrow({
          where: { id: wReq.id },
          select: { status: true },
        })
      ).status === PlacementStatus.WITHDRAWN,
      "which is terminal"
    );

    t.check(
      (await placementDetail(wReq.id, otherSellerId)) === null,
      "and reading somebody else's placement returns null"
    );
    t.check((await placementDetail(wReq.id, sellerId)) !== null, "while the owner can read it");

    const mine = await placementsForSeller(sellerId);
    t.check(mine.length >= 5, "the seller sees their own requests", `got ${mine.length}`);
    t.check(
      (await placementsForSeller(otherSellerId)).length === 0,
      "and none of anybody else's"
    );

    const pending = await placementQueue({ pendingOnly: true });
    t.check(
      pending.every(
        (p) => p.status === "REQUESTED" || p.status === "COUNTERED" || p.status === "AGREED"
      ),
      "the moderator queue holds everything needing a moderator's hand",
      JSON.stringify([...new Set(pending.map((p) => p.status))])
    );
    /**
     * AGREED specifically, because leaving it out was a bug: the button that
     * makes a placement live only appears on an agreed row, so a filter that
     * hid them stalled every completed negotiation.
     */
    t.check(
      !pending.some((p) => p.status === "LIVE" || p.status === "DECLINED"),
      "and nothing already settled"
    );

    /* ---- 9. on a timer, with nobody pressing anything ---- */

    t.section("9. the sweeper runs itself");

    /**
     * WIRED, NOT JUST WRITTEN.
     *
     * This repository has shipped a sweeper that existed and was never invoked,
     * and the README claimed it ran. Reading the source is a blunt check and it
     * is the only one that fails when somebody deletes the call.
     */
    const bootstrap = readFileSync("src/index.ts", "utf8");
    t.check(
      /startPlacementSweeper\(\)/.test(bootstrap),
      "src/index.ts actually calls startPlacementSweeper()",
      "the sweeper is written but never started"
    );

    const timerListing = await makeListing({
      title: "Swept into place",
      status: ListingStatus.ACTIVE,
    });
    const timed = await requestPlacement({
      sellerId,
      listingId: timerListing,
      slot: PlacementSlot.PICKED_SHELF,
      position: 2,
      offeredCents: 1100,
      startsAt: new Date(Date.now() - DAY),
      endsAt: new Date(Date.now() + DAY),
      note: "Due to start yesterday, so a running sweeper should pick it up.",
    });
    if (!timed.requested) throw new Error("fixture: timed request failed");
    threadIds.push(timed.threadId);
    await acceptAsOffered({ id: timed.id, adminUserId: adminA });

    async function statusOf(id: string) {
      const row = await prisma.placementRequest.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      });
      return row.status;
    }

    /** Polls rather than sleeping a fixed time, so a slow machine does not fail. */
    async function waitForStatus(id: string, want: PlacementStatus, budgetMs = 8000) {
      const until = Date.now() + budgetMs;
      while (Date.now() < until) {
        if ((await statusOf(id)) === want) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      return false;
    }

    t.check(
      (await statusOf(timed.id)) === PlacementStatus.AGREED,
      "it is AGREED and nobody has activated it"
    );

    /** A fast interval so the assertion is about the timer, not about patience. */
    const stop = startPlacementSweeper(300);
    try {
      t.check(
        await waitForStatus(timed.id, PlacementStatus.LIVE),
        "the sweeper makes it LIVE on its own",
        `status is ${await statusOf(timed.id)}`
      );

      await prisma.placementRequest.update({
        where: { id: timed.id },
        data: { endsAt: new Date(Date.now() - 1000) },
      });

      t.check(
        await waitForStatus(timed.id, PlacementStatus.ENDED),
        "and ENDS it when the window closes, also on its own",
        `status is ${await statusOf(timed.id)}`
      );
    } finally {
      stop();
    }

    /**
     * The stop function has to work, or every suite that starts one leaks a
     * timer into the next.
     */
    await prisma.placementRequest.update({
      where: { id: timed.id },
      data: { status: PlacementStatus.AGREED, endsAt: new Date(Date.now() + DAY) },
    });
    await new Promise((r) => setTimeout(r, 900));
    t.check(
      (await statusOf(timed.id)) === PlacementStatus.AGREED,
      "and stopping it really stops it — nothing moved after three intervals"
    );
  },

  /* ---- cleanup ---- */
  async () => {
    for (const id of threadIds) {
      await prisma.outboxEvent.deleteMany({
        where: { aggregateType: "message_thread", aggregateId: id },
      });
      await prisma.notification.deleteMany({ where: { link: { contains: id } } });
    }
    await prisma.placementRequest.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  }
);

wireInterrupt();
cleanupOnInterrupt(async () => {
  await prisma.placementRequest.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
});
