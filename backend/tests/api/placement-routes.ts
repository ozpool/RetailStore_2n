import { prisma, requireServices } from "../lib/db";
import { PASSWORD, Scope } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";
import { currentCode, freshCode } from "../lib/totp";
import { PlacementStatus, UserRole } from "../../src/generated/prisma/enums";

/**
 * Placement and messaging, over HTTP.
 *
 * WHY SEPARATELY FROM `placement.ts` AND `messaging.ts`
 * Those two prove the state machine and the transaction below HTTP, and neither
 * touches a route. This one drives the whole negotiation the way two people do
 * — seller asks, moderator counters, seller accepts, moderator activates — and
 * is the only place the authorisation is exercised. Four parties can reach
 * these endpoints and three of them must be turned away from any given
 * request.
 *
 * IT IS ALSO THE REGRESSION TEST FOR A MOUNT. `sellerMessaging` is mounted at
 * `/seller` alongside payouts, verification and sales. An unscoped `use()` in
 * it would break every sibling route with a 500, and the last time that
 * happened in this directory nothing in the feature's own tests noticed.
 */

const scope = new Scope("placeroutes");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

void main(
  "placement endpoints",
  async (t) => {
    await requireServices({ api: true, web: true });

    const { seller, listing } = await scope.ownListing("shop", {
      priceCents: 24_500,
      title: "A promotable sideboard",
    });
    const rival = await scope.seller("rival");
    const buyer = await scope.buyer("buyer");

    /* ============================================================ *
     * 1. The mount still works for its neighbours.
     * ============================================================ */
    t.section("1. the new router did not lock its neighbours out");

    const sales = await seller.get("/api/seller/sales");
    t.check(sales.status === 200, "GET /seller/sales still answers 200", sales.status);
    const verification = await seller.get("/api/seller/verification");
    t.check(
      verification.status === 200,
      "GET /seller/verification still answers 200 — the door an unverified seller needs",
      verification.status
    );
    const listings = await seller.get("/api/seller/listings");
    t.check(listings.status === 200, "GET /seller/listings still answers 200", listings.status);

    /* ============================================================ *
     * 2. Who may ask.
     * ============================================================ */
    t.section("2. authorisation on the seller side");

    const anonymous = await fetch("http://localhost:3000/api/seller/placements", {
      method: "GET",
    });
    t.check(
      anonymous.status === 401,
      "a signed-out request is refused",
      String(anonymous.status)
    );

    const asBuyer = await buyer.get("/api/seller/placements");
    t.check(
      asBuyer.status === 403 || asBuyer.status === 401,
      "somebody who is not a seller is refused",
      asBuyer.status
    );

    const slots = await seller.get("/api/seller/placements/slots");
    t.check(slots.status === 200, "the slot list loads", slots.status);
    t.check(
      Array.isArray(slots.json.slots) && slots.json.slots.length === 2,
      "two slots are offered",
      JSON.stringify(slots.json.slots)
    );
    t.check(
      typeof slots.json.disclosure === "string" && slots.json.disclosure.includes("Promoted"),
      "and the API itself states that paid placements are labelled",
      slots.json.disclosure
    );

    /* ============================================================ *
     * 3. Asking.
     * ============================================================ */
    t.section("3. a seller asks");

    const badPosition = await seller.post("/api/seller/placements", {
      listingId: listing.id,
      slot: "HERO",
      position: 2,
      offeredCents: 4000,
      note: "The hero has exactly one position.",
    });
    t.check(
      badPosition.status === 400 && badPosition.json.field === "position",
      "an impossible position is a 400 naming the field",
      `${badPosition.status} ${JSON.stringify(badPosition.json)}`
    );

    const backwards = await seller.post("/api/seller/placements", {
      listingId: listing.id,
      slot: "HERO",
      offeredCents: 4000,
      startsAt: new Date(Date.now() + 5 * 86400_000).toISOString(),
      endsAt: new Date(Date.now() + 86400_000).toISOString(),
      note: "The dates are the wrong way round.",
    });
    t.check(
      backwards.status === 400 && backwards.json.field === "endsAt",
      "an end date before the start is refused",
      `${backwards.status} ${JSON.stringify(backwards.json)}`
    );

    const rivalAsk = await rival.post("/api/seller/placements", {
      listingId: listing.id,
      slot: "HERO",
      offeredCents: 9999,
      note: "Trying to promote a listing that is not mine at all.",
    });
    t.check(
      rivalAsk.status === 404,
      "another seller asking for YOUR listing gets 404, not 403",
      `${rivalAsk.status} ${JSON.stringify(rivalAsk.json)}`
    );

    const asked = await seller.post("/api/seller/placements", {
      listingId: listing.id,
      slot: "HERO",
      offeredCents: 4000,
      startsAt: new Date(Date.now() + 86400_000).toISOString(),
      endsAt: new Date(Date.now() + 8 * 86400_000).toISOString(),
      note: "It photographs well and it is the best thing in my shop.",
    });
    t.check(asked.status === 201, "a valid request is created", `${asked.status} ${asked.text?.slice(0, 120)}`);
    const placementId: string = asked.json.id;
    const threadId: string = asked.json.threadId;
    t.check(!!placementId && !!threadId, "and comes back with both ids", JSON.stringify(asked.json));

    const again = await seller.post("/api/seller/placements", {
      listingId: listing.id,
      slot: "PICKED_SHELF",
      offeredCents: 1200,
      note: "Asking a second time for the same listing.",
    });
    t.check(
      again.status === 409 && again.json.code === "ALREADY_OPEN",
      "a second open request for the same listing is 409 ALREADY_OPEN",
      `${again.status} ${JSON.stringify(again.json)}`
    );

    /* ============================================================ *
     * 4. The thread the request created.
     * ============================================================ */
    t.section("4. the negotiation is readable by its seller and nobody else");

    const threads = await seller.get("/api/seller/messages");
    t.check(threads.status === 200, "the seller's thread list loads", threads.status);
    t.check(
      threads.json.threads.some((x: { id: string }) => x.id === threadId),
      "and contains the placement thread"
    );

    const mine = await seller.get(`/api/seller/messages/${threadId}`);
    t.check(mine.status === 200, "the seller can open it", mine.status);
    t.check(
      mine.json.thread.messages.length === 1,
      "with the opening message on it",
      `${mine.json.thread?.messages?.length} message(s)`
    );

    const theirs = await rival.get(`/api/seller/messages/${threadId}`);
    t.check(
      theirs.status === 404,
      "another seller gets 404 — an id must not reveal that a thread exists",
      theirs.status
    );

    const rivalReply = await rival.post(`/api/seller/messages/${threadId}/reply`, {
      body: "Butting into somebody else's conversation.",
    });
    t.check(rivalReply.status === 404, "and cannot reply into it", rivalReply.status);

    const empty = await seller.post(`/api/seller/messages/${threadId}/reply`, { body: "   " });
    t.check(
      empty.status === 400,
      "an empty message is refused before anything is written",
      empty.status
    );

    /* ============================================================ *
     * 5. The moderator side.
     * ============================================================ */
    t.section("5. the admin routes are behind the admin session");

    const notAdmin = await seller.get("/api/admin/placements");
    t.check(
      notAdmin.status === 401 || notAdmin.status === 403,
      "a seller cannot read the placement queue",
      notAdmin.status
    );

    /**
     * A real moderator, enrolled and stepped up over HTTP.
     *
     * Not by writing a role in the database and calling the library: these
     * routes are behind an admin SESSION cookie, and the only way to hold one
     * is to enrol an authenticator and step up. `return-routes` records the
     * same lesson.
     */
    const moderator = await scope.buyer("moderator");
    await prisma.user.update({
      where: { email: scope.emailFor("moderator") },
      data: { role: UserRole.ADMIN },
    });

    const setup = await moderator.post("/api/admin/totp/setup", { password: PASSWORD });
    t.check(setup.status === 200, "the moderator starts TOTP enrolment", setup.status);
    const secret: string = setup.json.secret;
    t.check(
      (await moderator.post("/api/admin/totp/confirm", { code: currentCode(secret) })).status === 200,
      "and confirms it"
    );
    const stepUp = await moderator.post("/api/admin/session", {
      password: PASSWORD,
      code: await freshCode(secret),
    });
    t.check(stepUp.status === 200, "and opens the panel", `${stepUp.status} ${JSON.stringify(stepUp.json)}`);

    const queue = await moderator.get("/api/admin/placements?pending=1");
    t.check(queue.status === 200, "the placement queue loads for a moderator", queue.status);
    t.check(
      queue.json.placements.some((p: { id: string }) => p.id === placementId),
      "and holds the pending request"
    );

    /* ============================================================ *
     * 6. Counter, accept, activate.
     * ============================================================ */
    t.section("6. the negotiation, end to end over HTTP");

    const noReason = await moderator.post(`/api/admin/placements/${placementId}/decline`, {});
    t.check(
      noReason.status === 400 && noReason.json.field === "note",
      "declining without a reason is refused — the seller reads it",
      `${noReason.status} ${JSON.stringify(noReason.json)}`
    );

    const countered = await moderator.post(`/api/admin/placements/${placementId}/counter`, {
      agreedCents: 6000,
      note: "The hero is our most valuable slot, so $60 for the week.",
    });
    t.check(
      countered.status === 200 && countered.json.status === PlacementStatus.COUNTERED,
      "the moderator counters",
      `${countered.status} ${JSON.stringify(countered.json)}`
    );

    const activateTooEarly = await moderator.post(
      `/api/admin/placements/${placementId}/activate`,
      {}
    );
    t.check(
      activateTooEarly.status === 409 && activateTooEarly.json.code === "WRONG_STATE",
      "a countered request cannot be made live",
      `${activateTooEarly.status} ${JSON.stringify(activateTooEarly.json)}`
    );

    const rivalAccept = await rival.post(`/api/seller/placements/${placementId}/accept`, {});
    t.check(rivalAccept.status === 404, "another seller cannot accept the counter", rivalAccept.status);

    const accepted = await seller.post(`/api/seller/placements/${placementId}/accept`, {
      note: "That works, thank you.",
    });
    t.check(
      accepted.status === 200 && accepted.json.status === PlacementStatus.AGREED,
      "the seller accepts, reaching AGREED",
      `${accepted.status} ${JSON.stringify(accepted.json)}`
    );

    const live = await moderator.post(`/api/admin/placements/${placementId}/activate`, {});
    t.check(
      live.status === 200 && live.json.status === "LIVE",
      "the moderator makes it live",
      `${live.status} ${JSON.stringify(live.json)}`
    );

    /* ============================================================ *
     * 7. What the seller sees afterwards.
     * ============================================================ */
    t.section("7. both sides can read the settled terms");

    const settled = await seller.get(`/api/seller/placements/${placementId}`);
    t.check(settled.status === 200, "the seller can read their placement", settled.status);
    t.check(
      settled.json.placement.agreedCents === 6000 &&
        settled.json.placement.offeredCents === 4000,
      "and both numbers survived the negotiation",
      JSON.stringify({
        offered: settled.json.placement?.offeredCents,
        agreed: settled.json.placement?.agreedCents,
      })
    );
    t.check(
      settled.json.placement.status === PlacementStatus.LIVE,
      "with the status it actually has",
      settled.json.placement?.status
    );

    const notMine = await rival.get(`/api/seller/placements/${placementId}`);
    t.check(notMine.status === 404, "and a rival cannot read it", notMine.status);

    const adminThread = await moderator.get(`/api/admin/messages/${threadId}`);
    t.check(adminThread.status === 200, "the moderator can read the thread", adminThread.status);
    t.check(
      adminThread.json.thread.messages.length >= 3,
      "which now reads as a negotiation, not a status log",
      `${adminThread.json.thread?.messages?.length} message(s)`
    );

    const closed = await moderator.post(`/api/admin/messages/${threadId}/close`, {});
    t.check(closed.status === 200, "the moderator can close it", closed.status);
    const intoClosed = await seller.post(`/api/seller/messages/${threadId}/reply`, {
      body: "One more question now that it is closed.",
    });
    t.check(
      intoClosed.status === 409 && intoClosed.json.code === "THREAD_CLOSED",
      "and a closed thread refuses a reply with 409 THREAD_CLOSED",
      `${intoClosed.status} ${JSON.stringify(intoClosed.json)}`
    );

    /* ============================================================ *
     * 8. Ending it.
     * ============================================================ */
    t.section("8. ending a live placement");

    const ended = await moderator.post(`/api/admin/placements/${placementId}/end`, {});
    t.check(ended.status === 200 && ended.json.status === "ENDED", "it can be ended", ended.status);
    const endedTwice = await moderator.post(`/api/admin/placements/${placementId}/end`, {});
    t.check(
      endedTwice.status === 409,
      "and ending it twice is a 409, not a second write",
      endedTwice.status
    );
  },

  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
