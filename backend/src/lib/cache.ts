import { createHash } from "crypto";
import { getRedis, isRedisConfigured } from "./redis";

/**
 * Read-through caching for derived data.
 *
 * WHAT BELONGS IN HERE
 * Only values that can be recomputed from Postgres in one query. Search
 * results, listing pages, rating aggregates, unread counts, dashboard metrics.
 * If losing this store would lose anything — money, a session, account access —
 * it is not cacheable and does not come near this module. Postgres remains the
 * only source of truth, and keeping that line sharp is the whole reason a cache
 * is safe to add at all.
 *
 * See docs/adr/0018-redis-for-shared-ephemeral-state.md
 *
 * ─────────────────────────────────────────────────────────────────────
 * CACHE THE SERIALIZED RESPONSE, NOT THE PRISMA ROW
 *
 * Everything here round-trips through JSON, and JSON has no Date. A Prisma row
 * cached and read back returns `createdAt` as a string, so the first request
 * gets a Date, the second gets a string, and `.toISOString()` throws on a cache
 * hit — a bug that cannot reproduce on a cold cache and therefore never appears
 * in development. Cache what the route is about to send: it is already plain
 * JSON, so the round trip is lossless by construction.
 * ─────────────────────────────────────────────────────────────────────
 *
 * NO IN-MEMORY FALLBACK, DELIBERATELY — AND UNLIKE lib/rateLimit.ts
 *
 * The rate limiter keeps a Map for when Redis is absent, because a limit of
 * roughly the right size beats no limit at all. The opposite is true here. A
 * per-process cache cannot be invalidated by the instance that did the write,
 * so an edit on instance A leaves stale copies on B and C with nothing to clear
 * them — precisely the incoherence Redis was introduced to remove. Without
 * REDIS_URL every call simply loads from Postgres, which is slower and always
 * correct.
 */

/**
 * Bumped when the SHAPE of anything cached changes.
 *
 * A serializer that gains or renames a field makes every stored value quietly
 * wrong, and the entries outlive the deploy that broke them. Changing this
 * retires the whole generation at once: new keys miss, old keys are orphaned
 * and expire on their own. That is deliberately cheaper than FLUSHDB, which
 * would also take out the rate-limit counters sharing this Redis.
 *
 * One global version rather than one per namespace, because the namespaces are
 * not independent: a cached search result *contains* serialized listings, so a
 * change to the listing serializer has to invalidate both.
 */
export const CACHE_VERSION = 1;

export type CacheOptions = {
  /**
   * How long a value may still be served while a refresh runs, beyond its TTL.
   *
   * See `cached` for why this exists. Defaults to the TTL, capped at 60s.
   */
  staleSeconds?: number;

  /**
   * TTL for a `null` result. Defaults to the TTL, capped at 15s.
   *
   * Misses are cached for the reason in rule 06 of the data plan: without it a
   * crawler walking unknown slugs never touches a cached key, so every one of
   * its requests reaches Postgres. The cache is at 100% hit rate on real
   * traffic and the database is still on fire.
   *
   * Shorter than a hit because the common cause of a miss is a thing that does
   * not exist *yet*, and a newly published listing should not 404 for a minute.
   */
  negativeTtlSeconds?: number;
};

/* ------------------------------------------------------------------ *
 * Observability
 *
 * Counters, not a library. scripts/cache-demo.ts reads these to print a hit
 * rate beside the latency numbers, and a hit rate is the only way to tell a
 * cache that is working from a cache that is merely present.
 * ------------------------------------------------------------------ */

const stats = { hits: 0, misses: 0, stale: 0, errors: 0 };

export function cacheStats() {
  const total = stats.hits + stats.misses;
  return {
    ...stats,
    lookups: total,
    hitRate: total === 0 ? null : stats.hits / total,
    enabled: isRedisConfigured(),
  };
}

/** Test and demo only: zeroes the counters so a run starts clean. */
export function __resetCacheStats() {
  stats.hits = 0;
  stats.misses = 0;
  stats.stale = 0;
  stats.errors = 0;
}

/* ------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------ */

/**
 * What is actually stored: the value plus its SOFT expiry.
 *
 * The key's real TTL is longer than `e` by the stale window. Between the two,
 * the value is expired but still returnable — which is what makes a refresh
 * something one request does in the background rather than something every
 * concurrent request does at once.
 */
type Envelope<T> = { v: T; e: number };

function isEnvelope(x: unknown): x is Envelope<unknown> {
  return typeof x === "object" && x !== null && "v" in x && "e" in x;
}

function namespaced(key: string): string {
  return `cache:v${CACHE_VERSION}:${key}`;
}

function decode<T>(raw: string | null): Envelope<T> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isEnvelope(parsed) ? (parsed as Envelope<T>) : null;
  } catch {
    // Unparseable means a shape from before a version bump, or a truncated
    // write. Treated as a miss: the value is recomputed and overwritten.
    return null;
  }
}

function ttlFor(value: unknown, ttlSeconds: number, opts: CacheOptions): number {
  if (value !== null && value !== undefined) return ttlSeconds;
  return opts.negativeTtlSeconds ?? Math.min(ttlSeconds, 15);
}

/**
 * The stale window, derived from the TTL actually being written.
 *
 * NOT from the nominal TTL, which is a distinction that matters for cached
 * misses. A negative entry with a 15s TTL and a window computed from its
 * caller's 300s would live 75 seconds and stay servable-as-stale for 60 of
 * them — so a listing published a moment later would keep returning a stale
 * 404 for a minute, which is exactly what the short negative TTL exists to
 * prevent.
 */
function staleFor(liveSeconds: number, opts: CacheOptions): number {
  return opts.staleSeconds ?? Math.min(liveSeconds, 60);
}

async function write<T>(key: string, value: T, ttlSeconds: number, opts: CacheOptions) {
  const live = ttlFor(value, ttlSeconds, opts);
  const envelope: Envelope<T> = { v: value, e: Date.now() + live * 1000 };
  const c = await getRedis();
  await c.set(namespaced(key), JSON.stringify(envelope), {
    // The key outlives its soft expiry by the stale window, so there is
    // something to serve while one request refreshes it.
    EX: live + staleFor(live, opts),
  });
}

/* ------------------------------------------------------------------ *
 * Stampede control
 * ------------------------------------------------------------------ */

const LOCK_TTL_MS = 10_000;

/**
 * Tries to become the one request that refreshes a key.
 *
 * When a popular key expires, every request in flight misses simultaneously and
 * they all query Postgres together — a load spike that arrives *because* the
 * cache was working. One request takes this lock and recomputes; the rest serve
 * the stale value and return immediately.
 *
 * NX with a TTL, not a plain SET: a refresh that crashes must release the lock
 * on its own, or one failure freezes that key at its stale value until the
 * whole entry expires.
 */
async function claimRefresh(key: string): Promise<boolean> {
  try {
    const c = await getRedis();
    const got = await c.set(`cache:lock:${key}`, "1", { NX: true, PX: LOCK_TTL_MS });
    return got === "OK";
  } catch {
    // Cannot take the lock, so cannot claim to hold it. The caller serves stale,
    // which is the safe answer when the coordination layer is unavailable.
    return false;
  }
}

async function releaseRefresh(key: string) {
  try {
    const c = await getRedis();
    await c.del(`cache:lock:${key}`);
  } catch {
    // The TTL releases it. Nothing to do and nothing worth logging.
  }
}

/* ------------------------------------------------------------------ *
 * The read path
 * ------------------------------------------------------------------ */

/**
 * Returns the cached value, or loads and caches it.
 *
 * FAIL-OPEN, ALWAYS
 * Every Redis error here is swallowed and turned into a load from Postgres. A
 * cache that can fail a request is worse than no cache, because it converts an
 * optional dependency into a required one — and the whole argument for Redis
 * being safe to add rests on it being optional.
 *
 * Errors thrown by `load` are NOT swallowed. Those are real failures and belong
 * to the caller.
 *
 *   const body = await cached(`listing:${slug}`, 120, () => buildListing(slug));
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
  opts: CacheOptions = {}
): Promise<T> {
  if (!isRedisConfigured()) return load();

  let hit: Envelope<T> | null = null;
  try {
    const c = await getRedis();
    hit = decode<T>(await c.get(namespaced(key)));
  } catch (err) {
    stats.errors++;
    console.error(`[cache] read failed for "${key}": ${(err as Error).message}`);
    return load();
  }

  // Fresh.
  if (hit && hit.e > Date.now()) {
    stats.hits++;
    return hit.v;
  }

  // Stale but present. One request refreshes; everyone else gets this value now.
  if (hit) {
    stats.stale++;
    stats.hits++;

    if (await claimRefresh(key)) {
      // Deliberately not awaited: the point is that this request does not pay
      // for the refresh. Errors are caught here because a rejected floating
      // promise is an unhandled rejection, which would take the process down —
      // a failed cache refresh must never be fatal.
      void (async () => {
        try {
          await write(key, await load(), ttlSeconds, opts);
        } catch (err) {
          console.error(`[cache] refresh failed for "${key}": ${(err as Error).message}`);
        } finally {
          await releaseRefresh(key);
        }
      })();
    }

    return hit.v;
  }

  // Nothing to serve. Load synchronously — there is no stale value to hide
  // behind, so the lock would only make this request wait for another one.
  stats.misses++;
  const value = await load();

  try {
    await write(key, value, ttlSeconds, opts);
  } catch (err) {
    stats.errors++;
    console.error(`[cache] write failed for "${key}": ${(err as Error).message}`);
  }

  return value;
}

/**
 * The same, for many keys at once.
 *
 * One MGET instead of N round trips, and `load` is called once with only the
 * ids that missed. This exists for the rating aggregates: a catalogue page
 * renders twenty-four cards, and twenty-four sequential GETs would spend more
 * time on the network than the `groupBy` it replaces.
 *
 * No stale-while-revalidate here. Batch lookups are keyed per entity and there
 * is no single hot key to stampede on — the complexity would buy nothing.
 *
 *   const ratings = await cachedMany("rating", ids, 300, loadRatings);
 */
export async function cachedMany<T>(
  prefix: string,
  ids: string[],
  ttlSeconds: number,
  load: (missing: string[]) => Promise<Map<string, T>>,
  opts: CacheOptions = {}
): Promise<Map<string, T>> {
  if (ids.length === 0) return new Map();
  if (!isRedisConfigured()) return load(ids);

  const unique = [...new Set(ids)];
  const found = new Map<string, T>();
  let missing = unique;

  try {
    const c = await getRedis();
    const raw = await c.mGet(unique.map((id) => namespaced(`${prefix}:${id}`)));

    missing = [];
    let hits = 0;
    unique.forEach((id, i) => {
      const envelope = decode<T | null>(raw[i] ?? null);
      // Batch entries have no stale window, so soft expiry is the only expiry.
      if (!envelope || envelope.e <= Date.now()) {
        missing.push(id);
        return;
      }
      hits++;
      /**
       * A stored null is a cached NEGATIVE — this id was looked up and does not
       * exist. It is a hit, and it is deliberately left out of the returned map
       * rather than mapped to null.
       *
       * Otherwise the same absent id is reported two different ways depending on
       * cache state: absent from the map on the first call, present-but-null on
       * the second. Callers doing `map.get(id) ?? DEFAULT` would survive that;
       * callers doing `map.has(id)` would not, and the bug would only appear on
       * a warm cache.
       */
      if (envelope.v !== null) found.set(id, envelope.v);
    });

    stats.hits += hits;
    stats.misses += missing.length;
  } catch (err) {
    stats.errors++;
    console.error(`[cache] batch read failed for "${prefix}": ${(err as Error).message}`);
    return load(unique);
  }

  if (missing.length === 0) return found;

  const loaded = await load(missing);
  for (const [id, value] of loaded) found.set(id, value);

  try {
    const c = await getRedis();
    // A pipeline, because MSET cannot carry a TTL and a key with no expiry is
    // a cache entry that never refreshes.
    const tx = c.multi();
    const live = ttlFor(null, ttlSeconds, opts);
    for (const id of missing) {
      const value = loaded.get(id);
      const ttl = value === undefined ? live : ttlSeconds;
      const envelope: Envelope<T | null> = { v: value ?? null, e: Date.now() + ttl * 1000 };
      tx.set(namespaced(`${prefix}:${id}`), JSON.stringify(envelope), { EX: ttl });
    }
    await tx.exec();
  } catch (err) {
    stats.errors++;
    console.error(`[cache] batch write failed for "${prefix}": ${(err as Error).message}`);
  }

  return found;
}

/* ------------------------------------------------------------------ *
 * Invalidation
 * ------------------------------------------------------------------ */

/**
 * Drops keys after a write.
 *
 * ALWAYS CALLED AFTER THE DATABASE COMMIT, NEVER BEFORE
 * Commit first, then invalidate. Doing it the other way round leaves a window
 * where a concurrent read repopulates the cache from the pre-commit state and
 * the stale value outlives the write that was supposed to clear it.
 *
 * NEVER THROWS
 * A failed DEL must not fail the write that already succeeded. The damage is
 * bounded by the TTL, which is why every entry has one — including the ones
 * that are precisely invalidated.
 *
 * ONE KEY AT A TIME, NO PATTERNS
 * There is no invalidateByPrefix, on purpose. It would need KEYS or SCAN, and
 * KEYS is O(n) across the whole keyspace — a routine listing edit would walk
 * every rate-limit counter in Redis. Set-shaped caches like search results are
 * expired by a short TTL instead, because the keys a new listing dirties cannot
 * be enumerated anyway.
 */
export async function invalidate(...keys: string[]): Promise<void> {
  if (!isRedisConfigured() || keys.length === 0) return;

  try {
    const c = await getRedis();
    await c.del(keys.map(namespaced));
  } catch (err) {
    stats.errors++;
    console.error(`[cache] invalidation failed for ${keys.join(", ")}: ${(err as Error).message}`);
  }
}

/** Invalidates entries written by `cachedMany`. */
export async function invalidateMany(prefix: string, ids: string[]): Promise<void> {
  await invalidate(...ids.map((id) => `${prefix}:${id}`));
}

/* ------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------ */

/**
 * A stable key for a query with parameters.
 *
 * Sorted, so `?category=chairs&sort=new` and `?sort=new&category=chairs` are
 * one cache entry rather than two — the same page requested two ways is the
 * same page. Absent values are dropped so an unset filter cannot fork the key
 * space between "" and undefined.
 *
 * Hashed because the raw querystring is unbounded user input: it would put
 * arbitrary bytes in a key name and let a caller inflate memory with junk
 * parameters. A fixed-width digest cannot.
 */
export function queryKey(
  prefix: string,
  params: Record<string, string | number | boolean | undefined | null>
): string {
  const canonical = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&");

  return `${prefix}:${createHash("sha1").update(canonical).digest("hex").slice(0, 16)}`;
}
