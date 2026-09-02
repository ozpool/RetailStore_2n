import { API, requireServices } from "../lib/db";
import { Scope } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * The cache seam.
 *
 * WHY THIS SUITE CALLS THE LIBRARY DIRECTLY
 * Same reason tests/api/ratelimit.ts does: none of the properties that matter
 * are visible in a response. Whether a TTL was set, whether twenty concurrent
 * readers caused one database load or twenty, whether an unreachable Redis
 * degrades or fails — a correct-looking 200 is returned in every one of those
 * cases, including the broken ones.
 *
 * The loader in most sections counts its own calls. That count is the actual
 * assertion: a cache that returns the right value while still querying Postgres
 * every time is not a cache, and it is indistinguishable from one that works
 * unless something is counting.
 *
 * See docs/adr/0018-redis-for-shared-ephemeral-state.md
 */

const scope = new Scope("cache");
wireInterrupt();
cleanupOnInterrupt(async () => {
  await scope.cleanup();
  const { disconnectRedis } = await import("../../src/lib/redis");
  await disconnectRedis();
});

/** Unique per run, so a suite never inherits an entry from the last one. */
const stamp = Date.now();
const key = (name: string) => `test:${name}:${stamp}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A loader that records how often it actually ran. */
function counted<T>(value: T | (() => T)) {
  const box = { calls: 0 };
  return {
    box,
    load: async () => {
      box.calls++;
      return typeof value === "function" ? (value as () => T)() : value;
    },
  };
}

/** Restores REDIS_URL after a section has pointed it somewhere hostile. */
async function withRedisUrl<T>(url: string | undefined, fn: () => Promise<T>): Promise<T> {
  const { disconnectRedis } = await import("../../src/lib/redis");
  const before = process.env.REDIS_URL;

  await disconnectRedis();
  if (url === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = url;

  try {
    return await fn();
  } finally {
    await disconnectRedis();
    if (before === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = before;
  }
}

void main(
  "cache seam",
  async (t) => {
    await requireServices({ api: true, web: true, db: true });

    const {
      cached,
      cachedMany,
      invalidate,
      invalidateMany,
      queryKey,
      cacheStats,
      __resetCacheStats,
      CACHE_VERSION,
    } = await import("../../src/lib/cache");

    const redisUrl = process.env.REDIS_URL?.trim();

    /* ============================================================ *
     * 1. Key construction.
     *
     * Pure, so it runs with or without Redis.
     * ============================================================ */
    t.section("1 - query keys");

    t.check(
      queryKey("search", { category: "chairs", sort: "new" }) ===
        queryKey("search", { sort: "new", category: "chairs" }),
      "the same filters in a different order are ONE entry, not two"
    );

    t.check(
      queryKey("search", { category: "chairs" }) !==
        queryKey("search", { category: "tables" }),
      "different filters are different entries"
    );

    t.check(
      queryKey("search", { category: "chairs", q: "" }) ===
        queryKey("search", { category: "chairs" }),
      "an unset filter does not fork the key space — \"\" and absent are the same page"
    );

    t.check(
      queryKey("search", { q: "x".repeat(5000) }).length < 40,
      "the key is a fixed-width digest, so unbounded user input cannot inflate it",
      queryKey("search", { q: "x".repeat(5000) }).length
    );

    /* ============================================================ *
     * 2. No Redis: every call loads.
     *
     * Deliberately NOT an in-memory fallback, unlike the rate limiter. A
     * per-process cache cannot be invalidated by the instance that wrote,
     * which is the incoherence Redis exists to remove.
     * ============================================================ */
    t.section("2 - with no shared store, nothing is cached");

    await withRedisUrl(undefined, async () => {
      const { box, load } = counted("value");
      await cached(key("nostore"), 60, load);
      await cached(key("nostore"), 60, load);

      t.check(box.calls === 2, "both calls reached the loader", box.calls);
      t.check(cacheStats().enabled === false, "and it reports itself as disabled");
    });

    /* ============================================================ *
     * 3. Redis.
     * ============================================================ */
    if (!redisUrl) {
      t.section("3 - redis");
      t.note("REDIS_URL is not set — the shared-store sections are skipped.");
      t.note("Run them with: REDIS_URL=redis://localhost:6379 npm test -- cache");
      return;
    }

    const { createClient } = await import("redis");

    t.section("3 - a hit does not reach the database");

    await withRedisUrl(redisUrl, async () => {
      __resetCacheStats();
      const k = key("hit");
      const { box, load } = counted({ title: "Cast iron skillet", priceCents: 3200 });

      const first = await cached(k, 60, load);
      const second = await cached(k, 60, load);

      t.check(box.calls === 1, "the loader ran once for two reads", box.calls);
      t.check(
        JSON.stringify(first) === JSON.stringify(second),
        "and both reads returned the same value"
      );

      const stats = cacheStats();
      t.check(stats.hits === 1 && stats.misses === 1, "counted as one miss then one hit",
        `hits=${stats.hits} misses=${stats.misses}`);
      t.check(stats.hitRate === 0.5, "hit rate is reported", stats.hitRate);
    });

    /* ---- the key must expire ---- */
    t.section("4 - entries expire, and outlive their soft expiry by the stale window");

    await withRedisUrl(redisUrl, async () => {
      const k = key("ttl");
      await cached(k, 30, counted("v").load, { staleSeconds: 20 });

      const probe = createClient({ url: redisUrl });
      await probe.connect();
      const ttl = await probe.ttl(`cache:v${CACHE_VERSION}:${k}`);
      await probe.quit();

      t.check(ttl > 0, "the key carries a TTL — a cache entry that never expires is a leak", ttl);
      t.check(
        ttl > 30 && ttl <= 50,
        "and it outlives the 30s soft expiry by the 20s stale window, so there is " +
          "something to serve while a refresh runs",
        `ttl=${ttl}`
      );
    });

    /* ============================================================ *
     * 5. Stale-while-revalidate, and the stampede it prevents.
     *
     * THE FAILURE THIS GUARDS AGAINST
     * When a hot key expires, every request in flight misses at the same
     * moment and they all query Postgres together — a load spike that
     * arrives precisely BECAUSE the cache was working.
     * ============================================================ */
    t.section("5 - a stale key is refreshed once, not once per reader");

    await withRedisUrl(redisUrl, async () => {
      const k = key("stampede");
      let n = 0;
      const load = async () => {
        n++;
        // Slow enough that the other readers are genuinely concurrent.
        await sleep(120);
        return `load-${n}`;
      };

      // Prime with a 1s soft expiry and a long stale window.
      const primed = await cached(k, 1, load, { staleSeconds: 30 });
      t.check(primed === "load-1", "primed", primed);

      await sleep(1200); // now stale, but still within the stale window

      const readers = await Promise.all(
        Array.from({ length: 20 }, () => cached(k, 1, load, { staleSeconds: 30 }))
      );

      t.check(
        readers.every((r) => r === "load-1"),
        "all 20 concurrent readers got the stale value IMMEDIATELY — none of them waited"
      );

      // Let the single background refresh land.
      await sleep(400);
      t.check(n === 2, "and exactly one refresh ran, not twenty", `loads=${n}`);

      const after = await cached(k, 1, load, { staleSeconds: 30 });
      t.check(after === "load-2", "the refreshed value is what subsequent reads get", after);
    });

    /* ============================================================ *
     * 6. Negative caching.
     *
     * Without it a crawler walking unknown slugs never touches a cached
     * key, so every one of its requests reaches Postgres — a 100% hit rate
     * on real traffic while the database is still on fire.
     * ============================================================ */
    t.section("6 - a miss is cached too, but for less time");

    await withRedisUrl(redisUrl, async () => {
      const k = key("negative");
      const { box, load } = counted(null);

      const first = await cached<null>(k, 300, load);
      const second = await cached<null>(k, 300, load);

      t.check(first === null && second === null, "null is returned faithfully, not treated as absent");
      t.check(box.calls === 1, "and the second read did NOT reach the loader", box.calls);

      const probe = createClient({ url: redisUrl });
      await probe.connect();
      const ttl = await probe.ttl(`cache:v${CACHE_VERSION}:${k}`);
      await probe.quit();

      t.check(
        ttl > 0 && ttl <= 30,
        "a cached miss lives far less than the 300s a hit would — a listing " +
          "published a moment from now must not 404 for five minutes",
        `ttl=${ttl}`
      );
    });

    /* ============================================================ *
     * 7. Invalidation.
     * ============================================================ */
    t.section("7 - invalidation drops the entry");

    await withRedisUrl(redisUrl, async () => {
      const k = key("invalidate");
      let v = "before";
      const load = async () => v;

      t.check((await cached(k, 300, load)) === "before", "cached");

      v = "after";
      t.check((await cached(k, 300, load)) === "before", "still served from cache");

      await invalidate(k);
      t.check((await cached(k, 300, load)) === "after", "and after invalidation the write is visible");
    });

    /* ============================================================ *
     * 8. Batch reads.
     *
     * This is what the rating aggregates need: a catalogue page renders
     * twenty-four cards, and twenty-four sequential GETs would cost more
     * than the groupBy being replaced.
     * ============================================================ */
    t.section("8 - cachedMany loads only what missed");

    await withRedisUrl(redisUrl, async () => {
      const prefix = key("batch");
      const ids = ["a", "b", "c", "d", "e"];
      const asked: string[][] = [];

      const load = async (missing: string[]) => {
        asked.push([...missing].sort());
        return new Map(missing.map((id) => [id, { avg: 4, count: 2 }]));
      };

      const first = await cachedMany(prefix, ids.slice(0, 3), 300, load);
      t.check(first.size === 3, "first call returned all three", first.size);
      t.check(
        JSON.stringify(asked[0]) === JSON.stringify(["a", "b", "c"]),
        "and asked the loader for all three",
        JSON.stringify(asked[0])
      );

      const second = await cachedMany(prefix, ids, 300, load);
      t.check(second.size === 5, "second call returned all five", second.size);
      t.check(
        JSON.stringify(asked[1]) === JSON.stringify(["d", "e"]),
        "but asked the loader for ONLY the two that missed",
        JSON.stringify(asked[1])
      );

      const third = await cachedMany(prefix, ids, 300, load);
      t.check(third.size === 5 && asked.length === 2,
        "and a fully warm batch does not call the loader at all", asked.length);

      await invalidateMany(prefix, ["a", "b"]);
      await cachedMany(prefix, ids, 300, load);
      t.check(
        JSON.stringify(asked[2]) === JSON.stringify(["a", "b"]),
        "invalidateMany drops exactly the named entries",
        JSON.stringify(asked[2])
      );
    });

    /* ---- duplicate ids ---- */
    await withRedisUrl(redisUrl, async () => {
      const prefix = key("batch-dupes");
      const asked: string[] = [];
      const load = async (missing: string[]) => {
        asked.push(...missing);
        return new Map(missing.map((id) => [id, 1]));
      };

      await cachedMany(prefix, ["x", "x", "x", "y"], 300, load);
      t.check(asked.length === 2, "a repeated id is looked up once, not once per occurrence", asked.length);
    });

    /* ============================================================ *
     * 9. When Redis is unreachable.
     *
     * A cache that can fail a request is worse than no cache: it turns an
     * optional dependency into a required one, and the entire argument for
     * adding Redis rests on it staying optional.
     * ============================================================ */
    t.section("9 - an unreachable store degrades, it does not fail");

    // A port with nothing on it. Not an unresolvable hostname, which would be
    // testing DNS rather than the failure policy.
    const DEAD = "redis://127.0.0.1:6399";

    await withRedisUrl(DEAD, async () => {
      const { box, load } = counted("still works");

      const value = await cached(key("deadstore"), 60, load);
      t.check(value === "still works", "the read fell through to the loader and returned normally");
      t.check(box.calls === 1, "which ran exactly once", box.calls);

      // Must not throw either.
      await invalidate(key("deadstore"));
      t.check(true, "and invalidation against a dead store is a no-op, not an exception");
    });

    await withRedisUrl(DEAD, async () => {
      const load = async (missing: string[]) => new Map(missing.map((id) => [id, id.toUpperCase()]));
      const batch = await cachedMany(key("deadbatch"), ["p", "q"], 60, load);
      t.check(batch.get("p") === "P" && batch.size === 2,
        "batch reads fall through too");
    });

    /* ============================================================ *
     * 10. A failing loader is not the cache's problem.
     * ============================================================ */
    t.section("10 - loader errors propagate");

    await withRedisUrl(redisUrl, async () => {
      let threw = false;
      try {
        await cached(key("boom"), 60, async () => {
          throw new Error("database is down");
        });
      } catch (err) {
        threw = (err as Error).message === "database is down";
      }
      t.check(threw, "a real failure reaches the caller rather than being swallowed as a miss");

      const probe = createClient({ url: redisUrl });
      await probe.connect();
      const exists = await probe.exists(`cache:v${CACHE_VERSION}:${key("boom")}`);
      await probe.quit();

      t.check(exists === 0, "and nothing was written — an error is not a cacheable value", exists);
    });

    /* ============================================================ *
     * 11. The real endpoints.
     *
     * Sections 1-10 prove the seam behaves. This proves it is actually
     * WIRED — that the routes populate the keys they are supposed to, and
     * that the write paths drop them.
     *
     * The invalidation half is the part worth having. A cache that is never
     * invalidated still returns correct-looking data for its whole TTL, so
     * a missing invalidate() cannot be caught by reading a response; it can
     * only be caught by writing and then reading again.
     * ============================================================ */
    t.section("11 - the routes populate and drop their keys");

    const { listingKey, unreadKey } = await import("../../src/lib/cacheKeys");
    const probe = createClient({ url: redisUrl });
    await probe.connect();
    const live = async (k: string) => (await probe.exists(`cache:v${CACHE_VERSION}:${k}`)) === 1;

    try {
      /* ---- the category shelf ---- */
      await probe.del(`cache:v${CACHE_VERSION}:catalog:categories`);
      await fetch(`${API}/catalog/categories`);
      t.check(await live("catalog:categories"), "GET /catalog/categories fills its key");

      /* ---- a listing, and the write that must clear it ---- */
      const { seller, listing } = await scope.ownListing("owner", { priceCents: 4200 });

      await fetch(`${API}/catalog/listings/${listing.slug}`);
      t.check(await live(listingKey(listing.slug)), "GET a listing detail fills its key");

      const edit = await seller.patch(`/api/seller/listings/${listing.id}`, {
        priceCents: 5100,
      });
      t.check(edit.status === 200, "the seller repriced it", edit.status);
      t.check(
        !(await live(listingKey(listing.slug))),
        "and the edit DROPPED the cached page — not left it to expire"
      );

      // The assertion that actually matters: the loop, end to end.
      const after = await fetch(`${API}/catalog/listings/${listing.slug}`).then((r) => r.json());
      t.check(
        after.listing.priceCents === 5100,
        "so the very next read shows the new price rather than the cached one",
        after.listing.priceCents
      );

      /* ---- the unread badge ---- */
      const buyer = await scope.buyer("bell");
      const { prisma } = await import("../lib/db");
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: scope.emailFor("bell") },
        select: { id: true },
      });

      await buyer.get("/api/notifications/count");
      t.check(await live(unreadKey(user.id)), "GET /notifications/count fills its key");

      await buyer.post("/api/notifications/read-all");
      t.check(
        !(await live(unreadKey(user.id))),
        "and marking everything read drops it, so the badge cannot stick"
      );
    } finally {
      await probe.quit();
    }
  },
  async (t) => {
    const { disconnectRedis } = await import("../../src/lib/redis");
    await disconnectRedis();
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
