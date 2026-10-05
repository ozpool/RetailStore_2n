import { prisma, requireCatalog, requireServices } from "../lib/db";
import { CARDS, Scope } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";
import { IDEMPOTENCY_RETENTION_MS, pruneIdempotencyKeysOnce } from "../../src/lib/idempotency";

/**
 * Idempotency keys at the API boundary.
 *
 * WHY THIS EXISTS
 * A client whose response is lost cannot tell "never arrived" from "arrived and
 * the answer was lost", so it retries. Without a key, a retried hold is a 409
 * ALREADY_HELD and a retried checkout finds nothing left to check out — the
 * client never learns what its first request did. See ADR 0035.
 *
 * DIRECT TO THE API, NOT THROUGH THE BFF. The BFF forwards `cookie` and
 * `content-type` only, so a key sent to :3000 never reaches the API. That is a
 * known gap of this backend-only change, not something these assertions hide.
 *
 * THE ASSERTIONS THAT MATTER MOST ARE THE DATABASE ONES. A replayed response
 * proves the client was answered; only a row count proves the handler did not
 * run twice.
 */

const scope = new Scope("idem");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

let counter = 0;
/** A fresh key per use, unique across runs so a stale row can never answer. */
function freshKey(label: string): string {
  counter += 1;
  return `test-${label}-${Date.now().toString(36)}-${counter}`;
}

const key = (k: string) => ({ "Idempotency-Key": k });
const replayed = (h: Headers) => h.get("idempotent-replayed") === "true";

async function heldCount(userId: string, listingId: string) {
  return prisma.reservation.count({ where: { userId, listingId, status: "HELD" } });
}

async function userIdOf(email: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id;
}

void main(
  "idempotency",
  async (t) => {
    await requireServices({ api: true });
    await requireCatalog();

    const buyer = await scope.apiBuyer("buyer");
    const buyerId = await userIdOf(scope.emailFor("buyer"));

    /* ============================================================ *
     * 1. The problem: a retry without a key cannot get its answer.
     * ============================================================ */
    t.section("1 - without a key, a retried hold is refused");

    const plain = await scope.claimListing();
    const first = await buyer.post("/reservations", { listingId: plain.id, quantity: 1 });
    t.check(first.status === 201, "the first hold succeeds", `${first.status} ${first.text.slice(0, 120)}`);
    const retry = await buyer.post("/reservations", { listingId: plain.id, quantity: 1 });
    t.check(
      retry.status === 409 && retry.json?.code === "ALREADY_HELD",
      "the retry is a 409 ALREADY_HELD — the client never sees its hold",
      `${retry.status} ${retry.json?.code}`
    );
    t.check(
      (await prisma.idempotencyKey.count({ where: { userId: buyerId } })) === 0,
      "no key, no row: requests without the header are untouched"
    );
    await buyer.delete(`/reservations/${first.json.reservation.id}`);

    /* ============================================================ *
     * 2. With a key, the retry gets the first answer back.
     * ============================================================ */
    t.section("2 - a retried hold is answered from the first one");

    const listing = await scope.claimListing();
    const holdKey = freshKey("hold");
    const body = { listingId: listing.id, quantity: 1 };

    const a = await buyer.post("/reservations", body, key(holdKey));
    t.check(a.status === 201, "the keyed hold succeeds", `${a.status} ${a.text.slice(0, 120)}`);
    t.check(!replayed(a.headers), "and the first answer is not marked as a replay");

    const b = await buyer.post("/reservations", body, key(holdKey));
    t.check(b.status === 201, "the retry gets the same 201, not ALREADY_HELD", `${b.status} ${b.json?.code}`);
    t.check(replayed(b.headers), "marked Idempotent-Replayed: true", b.headers.get("idempotent-replayed"));
    t.check(
      b.json?.reservation?.id === a.json?.reservation?.id,
      "carrying the id of the hold the first request made",
      `${a.json?.reservation?.id} vs ${b.json?.reservation?.id}`
    );
    t.check((await heldCount(buyerId, listing.id)) === 1, "and exactly one hold exists in the database");

    const row = await prisma.idempotencyKey.findUniqueOrThrow({
      where: { userId_key: { userId: buyerId, key: holdKey } },
    });
    t.check(row.status === "COMPLETED" && row.responseStatus === 201, "the key is stored as COMPLETED with its 201",
      `${row.status} ${row.responseStatus}`);

    /* ============================================================ *
     * 3. Checkout: the case that cannot recover without a key.
     * ============================================================ */
    t.section("3 - a retried checkout returns the order it created");

    const checkoutKey = freshKey("checkout");
    const order1 = await buyer.post("/orders", {}, key(checkoutKey));
    t.check(order1.status === 201, "checkout succeeds", `${order1.status} ${order1.text.slice(0, 120)}`);
    const order2 = await buyer.post("/orders", {}, key(checkoutKey));
    t.check(order2.status === 201 && replayed(order2.headers), "the retry is a replayed 201",
      `${order2.status} ${order2.headers.get("idempotent-replayed")}`);
    t.check(order2.json?.order?.id === order1.json?.order?.id, "with the same order id",
      `${order1.json?.order?.id} vs ${order2.json?.order?.id}`);
    t.check((await prisma.order.count({ where: { buyerId } })) === 1, "and one order exists, not two");

    /* ============================================================ *
     * 4. Payment: the guard stays, the answer improves.
     * ============================================================ */
    t.section("4 - a retried payment is told how its first attempt went");

    const orderId = order1.json.order.id;
    const payKey = freshKey("pay");
    const pay1 = await buyer.post(`/orders/${orderId}/pay`, { cardNumber: CARDS.succeeds }, key(payKey));
    t.check(pay1.status === 200 && pay1.json?.outcome === "succeeded", "the payment succeeds",
      `${pay1.status} ${pay1.json?.outcome}`);
    const pay2 = await buyer.post(`/orders/${orderId}/pay`, { cardNumber: CARDS.succeeds }, key(payKey));
    t.check(pay2.status === 200 && pay2.json?.outcome === "succeeded" && replayed(pay2.headers),
      "the retry hears 'succeeded', replayed, instead of ALREADY_PAID",
      `${pay2.status} ${pay2.json?.outcome ?? pay2.json?.code}`);

    const otherKey = await buyer.post(`/orders/${orderId}/pay`, { cardNumber: CARDS.succeeds }, key(freshKey("pay2")));
    t.check(otherKey.status === 409 && otherKey.json?.code === "ALREADY_PAID",
      "a DIFFERENT key still meets the claim guard: 409 ALREADY_PAID",
      `${otherKey.status} ${otherKey.json?.code}`);
    const paid = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    t.check(paid.status === "PAID", "the order is paid once", paid.status);

    /* ============================================================ *
     * 5. A key is bound to its request.
     * ============================================================ */
    t.section("5 - reusing a key for a different request is refused");

    const otherBody = await buyer.post("/reservations", { listingId: listing.id, quantity: 2 }, key(holdKey));
    t.check(otherBody.status === 422 && otherBody.json?.code === "IDEMPOTENCY_KEY_REUSED",
      "same key, different body: 422 IDEMPOTENCY_KEY_REUSED", `${otherBody.status} ${otherBody.json?.code}`);
    const otherPath = await buyer.post("/orders", {}, key(holdKey));
    t.check(otherPath.status === 422 && otherPath.json?.code === "IDEMPOTENCY_KEY_REUSED",
      "same key, different endpoint: 422 as well", `${otherPath.status} ${otherPath.json?.code}`);

    /* ============================================================ *
     * 6. Keys belong to a user.
     * ============================================================ */
    t.section("6 - another account's identical key is its own");

    const rival = await scope.apiBuyer("rival");
    const rivalId = await userIdOf(scope.emailFor("rival"));
    const rivalListing = await scope.claimListing();
    const rivalHold = await rival.post("/reservations", { listingId: rivalListing.id, quantity: 1 }, key(holdKey));
    t.check(rivalHold.status === 201 && !replayed(rivalHold.headers),
      "the same key string from another user runs, rather than replaying someone else's answer",
      `${rivalHold.status} ${rivalHold.headers.get("idempotent-replayed")}`);
    t.check(rivalHold.json?.reservation?.listingId === rivalListing.id, "and answers for the rival's own listing");
    t.check((await heldCount(rivalId, rivalListing.id)) === 1, "with the rival's own hold in the database");

    /* ============================================================ *
     * 7. Malformed keys.
     * ============================================================ */
    t.section("7 - a malformed key is a 400, before anything runs");

    const spaced = await buyer.post("/orders", {}, key("has a space"));
    t.check(spaced.status === 400 && spaced.json?.code === "INVALID_IDEMPOTENCY_KEY", "a key with spaces",
      `${spaced.status} ${spaced.json?.code}`);
    const long = await buyer.post("/orders", {}, key("k".repeat(256)));
    t.check(long.status === 400 && long.json?.code === "INVALID_IDEMPOTENCY_KEY", "a key over 255 characters",
      `${long.status} ${long.json?.code}`);

    /* ============================================================ *
     * 8. Concurrent copies: the unique index decides.
     * ============================================================ */
    t.section("8 - five copies at once run the handler once");

    const racer = await scope.apiBuyer("racer");
    const racerId = await userIdOf(scope.emailFor("racer"));
    const raceListing = await scope.claimListing();
    const raceKey = freshKey("race");
    const replies = await Promise.all(
      Array.from({ length: 5 }, () =>
        racer.post("/reservations", { listingId: raceListing.id, quantity: 1 }, key(raceKey))
      )
    );
    const ran = replies.filter((r) => r.status === 201 && !replayed(r.headers));
    const others = replies.filter((r) => !(r.status === 201 && !replayed(r.headers)));
    t.check(ran.length === 1, "exactly one copy ran", replies.map((r) => `${r.status}${replayed(r.headers) ? "R" : ""}`));
    t.check(
      others.every((r) => (r.status === 201 && replayed(r.headers)) ||
        (r.status === 409 && r.json?.code === "IDEMPOTENCY_IN_PROGRESS" && !!r.headers.get("retry-after"))),
      "every other copy was replayed or told to retry later, with Retry-After",
      others.map((r) => `${r.status} ${r.json?.code ?? ""}`)
    );
    t.check((await heldCount(racerId, raceListing.id)) === 1, "and the database holds one reservation, not five");

    /* ============================================================ *
     * 9. A claim left by a dead process.
     * ============================================================ */
    t.section("9 - a live claim blocks, an expired one is taken over");

    const late = await scope.apiBuyer("late");
    const lateId = await userIdOf(scope.emailFor("late"));
    const lateListing = await scope.claimListing();
    const lateKey = freshKey("late");
    const lateBody = { listingId: lateListing.id, quantity: 1 };

    const done = await late.post("/reservations", lateBody, key(lateKey));
    t.check(done.status === 201, "a keyed hold to start from", `${done.status}`);
    await late.delete(`/reservations/${done.json.reservation.id}`);

    // Turn the finished row back into a claim, as if its process died mid-request.
    await prisma.idempotencyKey.update({
      where: { userId_key: { userId: lateId, key: lateKey } },
      data: { status: "IN_PROGRESS", responseStatus: null, completedAt: null,
        lockedUntil: new Date(Date.now() + 60_000) },
    });
    const blocked = await late.post("/reservations", lateBody, key(lateKey));
    t.check(blocked.status === 409 && blocked.json?.code === "IDEMPOTENCY_IN_PROGRESS",
      "while the lock holds: 409 IDEMPOTENCY_IN_PROGRESS", `${blocked.status} ${blocked.json?.code}`);
    const retryAfter = Number(blocked.headers.get("retry-after"));
    t.check(retryAfter > 0 && retryAfter <= 60, "with a Retry-After inside the lock", blocked.headers.get("retry-after"));

    await prisma.idempotencyKey.update({
      where: { userId_key: { userId: lateId, key: lateKey } },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    const takenOver = await late.post("/reservations", lateBody, key(lateKey));
    t.check(takenOver.status === 201 && !replayed(takenOver.headers),
      "once it has expired, the retry takes the claim over and runs", `${takenOver.status} ${takenOver.json?.code}`);
    t.check((await heldCount(lateId, lateListing.id)) === 1, "making the hold the dead request never answered for");
    const settled = await prisma.idempotencyKey.findUniqueOrThrow({
      where: { userId_key: { userId: lateId, key: lateKey } },
    });
    t.check(settled.status === "COMPLETED", "and the key ends COMPLETED", settled.status);

    /* ============================================================ *
     * 10. Errors that are answers, and keys that have aged out.
     * ============================================================ */
    t.section("10 - a 400 is replayed; a key past retention is fresh");

    const badKey = freshKey("bad");
    // quantity must be 1-99, so this fails validation before any listing is read.
    const INVALID_HOLD = { listingId: listing.id, quantity: 0 };
    const bad1 = await buyer.post("/reservations", INVALID_HOLD, key(badKey));
    t.check(bad1.status === 400, "an invalid hold is a 400", `${bad1.status}`);
    const bad2 = await buyer.post("/reservations", INVALID_HOLD, key(badKey));
    t.check(bad2.status === 400 && replayed(bad2.headers), "and its retry is the same 400, replayed",
      `${bad2.status} ${bad2.headers.get("idempotent-replayed")}`);

    await prisma.idempotencyKey.update({
      where: { userId_key: { userId: buyerId, key: badKey } },
      data: { createdAt: new Date(Date.now() - IDEMPOTENCY_RETENTION_MS - 60_000) },
    });
    const aged = await buyer.post("/reservations", INVALID_HOLD, key(badKey));
    t.check(aged.status === 400 && !replayed(aged.headers),
      "past 24 hours the key means nothing: the request runs again", aged.headers.get("idempotent-replayed"));

    /* ============================================================ *
     * 11. Retention.
     * ============================================================ */
    t.section("11 - the sweeper deletes expired keys and only those");

    const oldKey = freshKey("old");
    await prisma.idempotencyKey.create({
      data: {
        userId: buyerId, key: oldKey, method: "POST", path: "/reservations/", requestHash: "x",
        status: "COMPLETED", responseStatus: 201, lockedUntil: new Date(),
        createdAt: new Date(Date.now() - 2 * IDEMPOTENCY_RETENTION_MS),
      },
    });
    const pruned = await pruneIdempotencyKeysOnce();
    t.check(pruned.deleted >= 1, "the sweep deletes at least the expired row", pruned);
    t.check(
      (await prisma.idempotencyKey.count({ where: { userId: buyerId, key: oldKey } })) === 0,
      "the expired key is gone"
    );
    t.check(
      (await prisma.idempotencyKey.count({ where: { userId: buyerId, key: holdKey } })) === 1,
      "a key inside retention is kept"
    );
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
