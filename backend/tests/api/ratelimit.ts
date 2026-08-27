import { requireServices } from "../lib/db";
import { PASSWORD, Scope } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * Rate limiting, and what horizontal scaling does to it.
 *
 * WHY THIS SUITE IS DIFFERENT FROM THE OTHERS
 * Most suites drive the API over HTTP. Several assertions here call the limiter
 * directly, because the properties that matter are not observable through a
 * response: whether a TTL was actually set, what happens when the shared store
 * is unreachable, and whether two callers can both slip past the same counter.
 *
 * The endpoint-level check is still here — a limiter nothing is wired to is a
 * library, not a control.
 *
 * See docs/adr/0018-redis-for-shared-ephemeral-state.md
 */

const scope = new Scope("ratelimit");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

/** Unique per run, so a suite never inherits a window from the last one. */
const stamp = Date.now();
const key = (name: string) => `test:${name}:${stamp}`;

/** Restores REDIS_URL after a section has pointed it somewhere hostile. */
async function withRedisUrl<T>(url: string | undefined, fn: () => Promise<T>): Promise<T> {
  const { disconnectRateLimitStore } = await import("../../src/lib/rateLimit");
  const before = process.env.REDIS_URL;

  await disconnectRateLimitStore();
  if (url === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = url;

  try {
    return await fn();
  } finally {
    await disconnectRateLimitStore();
    if (before === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = before;
  }
}

void main(
  "rate limiting",
  async (t) => {
    await requireServices({ api: true, web: true });

    const {
      checkRateLimit,
      isRedisConfigured,
      __resetInMemoryLimits,
    } = await import("../../src/lib/rateLimit");

    const redisUrl = process.env.REDIS_URL?.trim();

    /* ============================================================ *
     * 1. The in-memory fallback still works.
     *
     * Kept so development and this suite need no extra service. Two
     * implementations means two things to keep honest.
     * ============================================================ */
    t.section("1 - in-memory, when no shared store is configured");

    await withRedisUrl(undefined, async () => {
      __resetInMemoryLimits();
      t.check(!isRedisConfigured(), "reports itself as unshared");

      const k = key("memory");
      const verdicts: boolean[] = [];
      for (let i = 0; i < 12; i++) {
        verdicts.push((await checkRateLimit(k, 10, 60_000)).allowed);
      }

      const allowed = verdicts.filter(Boolean).length;
      t.check(allowed === 10, "exactly the limit is allowed", allowed);
      t.check(verdicts[9] === true && verdicts[10] === false,
        "and it cuts off at the right attempt, not one either side");

      const refused = await checkRateLimit(k, 10, 60_000);
      t.check(refused.retryAfterSeconds > 0 && refused.retryAfterSeconds <= 60,
        "a refusal says when to come back, within the window",
        refused.retryAfterSeconds);
    });

    /* ============================================================ *
     * 2. Redis.
     * ============================================================ */
    t.section("2 - redis, when it is configured");

    if (!redisUrl) {
      t.note("REDIS_URL is not set — the shared-store sections are skipped.");
      t.note("Run them with: REDIS_URL=redis://localhost:6379 npm test -- ratelimit");
    } else {
      await withRedisUrl(redisUrl, async () => {
        t.check(isRedisConfigured(), "reports itself as shared");

        const k = key("redis");
        const verdicts: boolean[] = [];
        for (let i = 0; i < 12; i++) {
          verdicts.push((await checkRateLimit(k, 10, 60_000)).allowed);
        }
        const allowed = verdicts.filter(Boolean).length;
        t.check(allowed === 10, "exactly the limit is allowed", allowed);

        /**
         * THE COUNTER MUST EXPIRE.
         *
         * INCR and EXPIRE as two commands can come apart — a dropped connection
         * between them leaves a key with no TTL, which is a counter that never
         * resets and a user locked out permanently. They are one Lua script for
         * this reason, and this is the assertion that would catch a regression
         * back to two.
         */
        const { createClient } = await import("redis");
        const probe = createClient({ url: redisUrl });
        await probe.connect();
        const ttl = await probe.pTTL(`ratelimit:${k}`);
        await probe.quit();

        t.check(ttl > 0, "the key carries a TTL — it is not immortal", `pttl=${ttl}`);
        t.check(ttl <= 60_000, "and one no longer than the window asked for", `pttl=${ttl}`);
      });

      /* ---- atomicity ---- */
      t.section("3 - two callers cannot both slip past the same counter");

      await withRedisUrl(redisUrl, async () => {
        const k = key("concurrent");
        const LIMIT = 10;

        // Fifty at once. A read-then-write limiter lets more than LIMIT through
        // here; INCR is atomic, so exactly LIMIT do.
        const results = await Promise.all(
          Array.from({ length: 50 }, () => checkRateLimit(k, LIMIT, 60_000))
        );
        const allowed = results.filter((r) => r.allowed).length;

        t.check(allowed === LIMIT,
          `exactly ${LIMIT} of 50 simultaneous calls were allowed`, allowed);
      });

      /* ============================================================ *
       * 4. When the store is unreachable.
       *
       * There is no good answer, only two bad ones, and which one applies
       * depends on what the limit is protecting.
       * ============================================================ */
      t.section("4 - when redis is unreachable");

      // A port with nothing on it. Not a hostname that fails to resolve, which
      // would test DNS rather than the failure policy.
      const DEAD = "redis://127.0.0.1:6399";

      await withRedisUrl(DEAD, async () => {
        const open = await checkRateLimit(key("failopen"), 1, 60_000);
        t.check(open.allowed === true,
          "by default the request is ALLOWED — a defence in depth does not take the site down");
      });

      await withRedisUrl(DEAD, async () => {
        const closed = await checkRateLimit(key("failclosed"), 1, 60_000, {
          failClosed: true,
        });
        t.check(closed.allowed === false,
          "but a fail-closed limit REFUSES — unlimited guessing at the admin panel " +
            "is worse than nobody opening it");
        t.check(closed.retryAfterSeconds > 0,
          "and still says when to try again", closed.retryAfterSeconds);
      });
    }

    /* ============================================================ *
     * 5. Wired to a real endpoint.
     * ============================================================ */
    t.section("5 - the limit applies over HTTP");

    const buyer = await scope.buyer("subject");

    /**
     * /auth/password/change allows 10 per 15 minutes per user.
     *
     * Not politeness: the endpoint verifies the CURRENT password, so uncapped it
     * is a password oracle for anyone holding a stolen session. Every attempt
     * below uses a deliberately wrong password, which is exactly what the
     * attacker this limit exists for would send.
     */
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) {
      const res = await buyer.post("/api/auth/password/change", {
        currentPassword: `guess-${i}`,
        newPassword: "a replacement long enough to pass 1",
      });
      statuses.push(res.status);
    }

    const reached = statuses.filter((s) => s !== 429).length;
    const refused = statuses.filter((s) => s === 429).length;

    t.check(reached === 10, "ten attempts reached the password check", reached);
    t.check(refused === 3, "and the rest were refused", refused);
    t.check(statuses[9] !== 429 && statuses[10] === 429,
      "cutting off exactly at the limit",
      `#10=${statuses[9]} #11=${statuses[10]}`);

    // The real password still works afterwards: the limit throttles attempts,
    // it does not lock the account.
    t.check(
      (await buyer.get("/api/auth/me")).status === 200,
      "the account is throttled, not locked — the session still works"
    );

    /* ============================================================ *
     * 6. Login.
     *
     * The one that was missing. Every other credential control raises the
     * COST of guessing a password; only this caps the number of attempts.
     * ============================================================ */
    t.section("6 - login caps password guessing");

    const { web } = await import("../lib/api");

    /**
     * Its own account, not the one section 5 uses.
     *
     * This section deliberately exhausts the login limit for whatever address
     * it targets, and the limit is keyed on the address rather than the user
     * id. Pointing it at a shared fixture account entangles two sections that
     * have nothing to do with each other — and if either fails partway, the
     * other's diagnosis is a 429 about the wrong thing.
     */
    await scope.buyer("guessee");
    const victim = scope.emailFor("guessee");

    const attempts: number[] = [];
    for (let i = 0; i < 13; i++) {
      const res = await web().post("/api/auth/login", {
        email: victim,
        password: `wrong-guess-${i}`,
      });
      attempts.push(res.status);
    }

    const guessed = attempts.filter((s) => s === 401).length;
    const blocked = attempts.filter((s) => s === 429).length;

    t.check(guessed === 10, "ten guesses reached the password check", guessed);
    t.check(blocked === 3, "and the rest never got that far", blocked);
    t.check(
      attempts[9] === 401 && attempts[10] === 429,
      "cutting off exactly at the limit",
      `#10=${attempts[9]} #11=${attempts[10]}`
    );

    /**
     * THE REFUSAL MUST NOT LEAK WHETHER THE ACCOUNT EXISTS.
     *
     * The counter is keyed on the submitted address rather than on a user row,
     * so an address with no account throttles identically. If it did not, a 429
     * would confirm the address is real — turning a defence into an enumeration
     * oracle, which is the exact mistake /password/forgot avoids by answering
     * the same way to everything.
     */
    const ghost = `rs2.cache.nobody.${Date.now()}@retailstore-2n.test`;
    const ghostStatuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await web().post("/api/auth/login", { email: ghost, password: "whatever-1234" });
      ghostStatuses.push(res.status);
    }
    t.check(
      ghostStatuses.filter((s) => s === 401).length === 10 &&
        ghostStatuses.filter((s) => s === 429).length === 2,
      "an address with no account is throttled exactly the same way",
      `401s=${ghostStatuses.filter((s) => s === 401).length} 429s=${ghostStatuses.filter((s) => s === 429).length}`
    );

    /**
     * AND THE COUNTER CLEARS ON SUCCESS.
     *
     * Without this, someone who mistypes twice and then signs in carries those
     * attempts for the rest of the window — so their next mistake refuses them
     * early, for a reason they cannot see. It is what makes "throttled, not
     * locked" true rather than merely claimed.
     */
    const mistyper = await scope.buyer("mistyper");
    const mistypedEmail = scope.emailFor("mistyper");

    for (let i = 0; i < 4; i++) {
      await web().post("/api/auth/login", { email: mistypedEmail, password: `oops-${i}` });
    }

    const gotIn = await web().post("/api/auth/login", {
      email: mistypedEmail,
      password: PASSWORD,
    });
    t.check(gotIn.status === 200, "the right password still works after four misses", gotIn.status);

    // Nine more wrong guesses. If the earlier four still counted, this would
    // start refusing partway through.
    const afterSuccess: number[] = [];
    for (let i = 0; i < 9; i++) {
      const res = await web().post("/api/auth/login", {
        email: mistypedEmail,
        password: `again-${i}`,
      });
      afterSuccess.push(res.status);
    }
    t.check(
      afterSuccess.every((s) => s === 401),
      "and the successful login reset the count — none of the next nine were refused",
      `429s=${afterSuccess.filter((s) => s === 429).length}`
    );

    // The session issued before the throttling still works.
    t.check(
      (await mistyper.get("/api/auth/me")).status === 200,
      "an existing session is unaffected by the throttle"
    );
  },
  async (t) => {
    const { disconnectRateLimitStore } = await import("../../src/lib/rateLimit");
    await disconnectRateLimitStore();
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
