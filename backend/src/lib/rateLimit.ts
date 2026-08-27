import { disconnectRedis, getRedis, isRedisConfigured, redisUrl } from "./redis";

// Re-exported because this module was the only Redis consumer when it was
// written, and call sites (and the suite) still ask it whether the store is
// shared. The connection itself now lives in ./redis, shared with the cache.
export { isRedisConfigured };

/**
 * Fixed-window rate limiting, shared across instances when Redis is configured.
 *
 * WHY THIS IS NOT JUST A MAP ANY MORE
 * The counters guard eleven endpoints and several are security controls, not
 * politeness: `admin-stepup` at 8 per fifteen minutes is the only reason a
 * six-digit TOTP cannot be brute-forced. Held in-process, every limit silently
 * multiplies by the number of replicas — three instances turn that 8 into 24,
 * which is a different security posture arrived at by accident.
 *
 * See docs/adr/0018-redis-for-shared-ephemeral-state.md
 *
 * WHAT LIVES HERE, AND WHAT DOES NOT
 * Counters that expire. Nothing else. Redis is never a source of truth in this
 * codebase — everything that must survive a restart is in Postgres, and keeping
 * that line sharp is what stops this becoming a second database.
 */

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

export type RateLimitOptions = {
  /**
   * What to do when the shared store cannot be reached.
   *
   * Default is to fail OPEN: allow the request and log loudly, matching how the
   * breached-password check already behaves. A defence in depth should not take
   * the site down when it is unavailable.
   *
   * Pass true for limits where unlimited attempts are worse than an outage.
   * `admin-stepup` is the one that qualifies: unbounded guessing at the admin
   * panel beats nobody opening it for ten minutes.
   */
  failClosed?: boolean;
};

/* ------------------------------------------------------------------ *
 * In-memory fallback
 *
 * Kept, not deleted. With no REDIS_URL the suite and a single-instance
 * deployment need no extra service — and the startup banner says which is in
 * use, so nobody has to guess whether their limits are actually shared.
 * ------------------------------------------------------------------ */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

/** Keeps the map from growing without bound in a long-running process. */
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function checkInMemory(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (bucket.count >= limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count++;
  return { allowed: true, retryAfterSeconds: 0 };
}

/* ------------------------------------------------------------------ *
 * Redis
 * ------------------------------------------------------------------ */

/**
 * INCREMENT AND EXPIRE IN ONE ROUND TRIP.
 *
 * The obvious version is INCR followed by EXPIRE, which is two commands. A
 * dropped connection between them leaves a key with NO TTL — a counter that
 * never resets, locking the user out permanently. Evaluated server-side, the
 * two cannot come apart.
 *
 * Returns the new count and the milliseconds remaining, so one call decides
 * both whether to allow and what to tell the caller about retrying.
 */
const INCR_AND_EXPIRE = `
  local n = redis.call('INCR', KEYS[1])
  if n == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  return { n, redis.call('PTTL', KEYS[1]) }
`;

/** Checked at startup so the banner can say which store is in use. */
export async function assertRateLimitStore(): Promise<string> {
  if (!isRedisConfigured()) {
    return "in-memory (per-process; limits multiply by the number of instances)";
  }
  const c = await getRedis();
  await c.ping();
  return `redis (${redisUrl()}) — shared across instances`;
}

/* ------------------------------------------------------------------ *
 * The check
 * ------------------------------------------------------------------ */

/**
 * Records an attempt and says whether it is allowed.
 *
 * ASYNC, because the counter may not be in this process. Every call site awaits
 * it. A version that kept the synchronous signature would have to guess, and a
 * rate limiter that guesses is not one.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  opts: RateLimitOptions = {}
): Promise<RateLimitResult> {
  if (!isRedisConfigured()) {
    return checkInMemory(key, limit, windowMs);
  }

  try {
    const c = await getRedis();
    const reply = (await c.eval(INCR_AND_EXPIRE, {
      keys: [`ratelimit:${key}`],
      arguments: [String(windowMs)],
    })) as [number, number];

    const count = Number(reply[0]);
    const ttlMs = Number(reply[1]);

    if (count > limit) {
      return {
        allowed: false,
        // PTTL answers -1 for a key with no expiry and -2 if it vanished
        // between the INCR and the read. Neither should happen, and falling
        // back to the window keeps the advice sane if it does.
        retryAfterSeconds: Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : windowMs) / 1000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (err) {
    /**
     * The store is unreachable. There is no good answer, only two bad ones.
     *
     * Loud either way: a rate limiter running blind is something an operator
     * needs to know about, and silence here is how a security control goes
     * missing for a week without anyone noticing.
     */
    console.error(
      `[rate-limit] shared store unreachable for "${key}" ` +
        `(${(err as Error).message}) — ${opts.failClosed ? "REFUSING" : "allowing"} the request`
    );

    if (opts.failClosed) {
      return { allowed: false, retryAfterSeconds: 30 };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/**
 * Forgets a key's counter, as though the window had never started.
 *
 * WHAT THIS IS FOR
 * Turning "throttled, not locked" from a claim into a fact. Login counts failed
 * attempts, so somebody who mistypes their password four times and then gets it
 * right should not carry four attempts around for the rest of the window —
 * their next mistake would refuse them at five rather than ten.
 *
 * Only ever called after the thing being guarded has SUCCEEDED. Clearing on
 * failure would make the limit decorative.
 *
 * Never throws. A counter that fails to clear is a user with a smaller
 * allowance than intended for a few minutes; a request that fails because a
 * counter would not clear is a user who cannot log in at all.
 */
export async function clearRateLimit(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;

  if (!isRedisConfigured()) {
    for (const key of keys) buckets.delete(key);
    return;
  }

  try {
    const c = await getRedis();
    await c.del(keys.map((k) => `ratelimit:${k}`));
  } catch (err) {
    console.error(`[rate-limit] could not clear ${keys.join(", ")}: ${(err as Error).message}`);
  }
}

/** Test-only: drops the in-memory buckets so a suite can start clean. */
export function __resetInMemoryLimits() {
  buckets.clear();
  lastSweep = 0;
}

/**
 * Closes the shared connection so a process can exit without a lingering socket.
 *
 * Named for the rate limiter for historical reasons and kept that way: it is
 * what the suite and the shutdown path already call. It now closes the
 * connection the cache uses too, which is correct — there is only one.
 */
export async function disconnectRateLimitStore() {
  await disconnectRedis();
}
