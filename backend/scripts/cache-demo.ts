import "dotenv/config";
import { prisma } from "../src/lib/prisma";

/**
 * Measures what the read-through cache actually does.
 *
 * WHAT IS BEING CLAIMED
 * GET /catalog/listings/:slug makes six ORM calls — the listing, its rating, its
 * star breakdown, which reviewers actually bought it, four related listings, and
 * their ratings. On a cache hit it makes none. This script fires the same load
 * twice, cold and warm, and prints both sides.
 *
 * SIX ORM CALLS ARE NOT SIX QUERIES
 * Measured at the database it lands between eight and twelve round trips per
 * page, because Prisma loads each `include`d relation as its own query rather
 * than joining — the listing, then its category, seller, images and reviews
 * separately, and the same again for the four related listings.
 *
 * That gap is the reason this measures Postgres rather than counting call sites
 * in the route. "Six" is true about the code and wrong about the load.
 *
 * The spread between runs is not noise either: every page also renders four
 * RELATED listings, and their rating aggregates are cached under the same keys
 * the listing pages use. Pages overlap, so partway through a cold run the
 * ratings are already warm from someone else's "related" strip and the
 * per-request count falls. Real behaviour, and the reason the figure is a range.
 *
 *   npx tsx scripts/cache-demo.ts
 *   npx tsx scripts/cache-demo.ts --requests 300 --concurrency 16
 *   npx tsx scripts/cache-demo.ts --hot            one page, hammered
 *
 * ONE REQUEST PER DISTINCT PAGE, BY DEFAULT
 * The first version of this script fired every request at a single listing, and
 * reported 0.1 database queries per request. That number was an artefact: the
 * first request populated the key and the other 119 hit it, so the "cold" column
 * was measuring a warm cache for 99% of its requests.
 *
 * Each request now asks for a different listing, so a flushed cache means every
 * single one is a genuine miss and the per-request query count is the real cost
 * of the endpoint.
 *
 * `--hot` restores the old behaviour deliberately, because it measures something
 * else worth seeing: the stampede when many concurrent readers miss the same key
 * at once.
 *
 * HOW DATABASE QUERIES ARE COUNTED
 * From `pg_stat_database.xact_commit`, not from instrumenting the app. Every
 * Prisma query outside an explicit transaction is its own implicit transaction,
 * so the delta across a burst is the number of statements the API actually sent.
 *
 * Counting it in Postgres rather than in the API matters: an app-side counter
 * measures what the code *believes* it did, and the whole question here is
 * whether the queries reached the database at all.
 *
 * The counter is database-wide, so anything else touching Postgres during the
 * run inflates it. The script measures the idle rate first and reports it, so a
 * noisy environment is visible rather than silently folded into the result.
 *
 * See docs/adr/0018-redis-for-shared-ephemeral-state.md
 */

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const TARGET = arg("target", "http://localhost:4000").replace(/\/$/, "");
const REQUESTS = Number(arg("requests", "120"));
const CONCURRENCY = Number(arg("concurrency", "8"));
const HOT = process.argv.includes("--hot");

/* ------------------------------------------------------------------ *
 * Measurement
 * ------------------------------------------------------------------ */

/** Transactions committed against this database so far. */
async function commits(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ xact_commit: bigint }>>`
    SELECT xact_commit FROM pg_stat_database WHERE datname = current_database()
  `;
  return Number(rows[0].xact_commit);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for Postgres to publish its statistics before reading them.
 *
 * WHY THIS IS NOT PARANOIA
 * A backend accumulates counters locally and flushes them to shared memory at
 * most once a second, so `xact_commit` read immediately after a request does
 * not include that request. Without this delay the script reported 3
 * transactions for a page that runs six queries, and once reported *minus one*
 * — an impossible number, which is the only reason the undercount was noticed
 * rather than published.
 *
 * 1500ms, comfortably past the ~1s reporting interval, at each snapshot.
 */
async function settle() {
  await sleep(1500);
}

/**
 * Commits per second with no load applied.
 *
 * Reported rather than subtracted. Subtracting an estimate from a measurement
 * and presenting the result as measured is how a number stops being one — if
 * this is high enough to matter, the answer is to quiet the environment, not to
 * adjust the arithmetic.
 */
async function idleRate(): Promise<number> {
  await settle();
  const before = await commits();
  await sleep(4000);
  await settle();
  const after = await commits();
  // Minus the commits this function's own queries caused.
  return Math.max(0, (after - before - 2) / 4);
}

type Phase = { latencies: number[]; queries: number; failures: number };

/** Walks the URL list, CONCURRENCY at a time, timing each request. */
async function burst(urls: string[]): Promise<Phase> {
  const latencies: number[] = [];
  let failures = 0;
  let next = 0;

  await settle();
  const before = await commits();

  async function worker() {
    while (next < urls.length) {
      const url = urls[next++];
      const started = performance.now();
      try {
        const res = await fetch(url);
        // The body has to be consumed, or the timing measures headers arriving
        // rather than the response being delivered.
        await res.text();
        if (!res.ok) failures++;
        else latencies.push(performance.now() - started);
      } catch {
        failures++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await settle();
  const after = await commits();

  return { latencies, queries: after - before, failures };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

/* ------------------------------------------------------------------ *
 * Cache control
 * ------------------------------------------------------------------ */

/**
 * Deletes the cache keys and NOTHING ELSE.
 *
 * Not FLUSHDB. The rate-limit counters live in the same Redis, and wiping them
 * mid-measurement would reset security-relevant windows early — see ADR 0018 on
 * why they are there in the first place. SCAN with a prefix, in batches.
 */
async function flushCache(url: string): Promise<number> {
  const { createClient } = await import("redis");
  const client = createClient({ url });
  client.on("error", () => {});
  await client.connect();

  let cursor = "0";
  let deleted = 0;
  do {
    const reply = await client.scan(cursor, { MATCH: "cache:*", COUNT: 500 });
    cursor = String(reply.cursor);
    if (reply.keys.length > 0) {
      await client.del(reply.keys);
      deleted += reply.keys.length;
    }
  } while (cursor !== "0");

  await client.quit();
  return deleted;
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

const W = 72;
const rule = (c = "-") => console.log(c.repeat(W));

function row(label: string, cold: string, warm: string) {
  console.log(`  ${label.padEnd(26)}${cold.padStart(14)}${warm.padStart(14)}`);
}

function ms(n: number): string {
  return `${n.toFixed(1)}ms`;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const redisUrl = process.env.REDIS_URL?.trim();

  /* ---- preflight ---- */
  const health = await fetch(`${TARGET}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`\n  ${TARGET} is not answering. Start the API first.\n`);
    process.exit(2);
  }

  if (!redisUrl) {
    console.error(
      "\n  REDIS_URL is not set here, so there is no cache to measure and no\n" +
        "  way to clear one. Set it to the same value the API is using:\n\n" +
        "    REDIS_URL=redis://localhost:6379 npx tsx scripts/cache-demo.ts\n"
    );
    process.exit(2);
  }

  /* ---- choose subjects ---- *
   * Listings that actually have reviews, so the rating and breakdown queries
   * are exercised rather than short-circuiting on an empty set. */
  const listings = await prisma.listing.findMany({
    where: { status: "ACTIVE", deletedAt: null, reviews: { some: {} } },
    orderBy: { createdAt: "asc" },
    take: REQUESTS,
    select: { slug: true },
  });

  if (listings.length === 0) {
    console.error("\n  No active listing with reviews. Run: npx prisma db seed\n");
    process.exit(2);
  }

  const urls = HOT
    ? Array.from({ length: REQUESTS }, () => `${TARGET}/catalog/listings/${listings[0].slug}`)
    : listings.map((l) => `${TARGET}/catalog/listings/${l.slug}`);

  const distinct = new Set(urls).size;

  console.log("=".repeat(W));
  console.log("READ-THROUGH CACHE, MEASURED");
  console.log("=".repeat(W));
  console.log(`  endpoint     GET /catalog/listings/:slug`);
  console.log(`  uncached     6 ORM calls — listing, rating, breakdown, verified`);
  console.log(`               buyers, related listings, their ratings — which`);
  console.log(`               Prisma expands into ~12 round trips, one per`);
  console.log(`               included relation rather than a join`);
  console.log(
    `  load         ${urls.length} requests across ${distinct} distinct ` +
      `page${distinct === 1 ? "" : "s"}, ${CONCURRENCY} at a time`
  );
  if (HOT) {
    console.log(`               --hot: one page hammered, so the cold column`);
    console.log(`               shows the stampede, not the per-page cost`);
  } else if (distinct < REQUESTS) {
    console.log(`               (only ${distinct} listings have reviews; asked ${REQUESTS})`);
  }
  console.log(`  store        redis (${redisUrl})`);

  const idle = await idleRate();
  console.log(
    `  background   ${idle.toFixed(1)} commits/sec with no load` +
      (idle > 5 ? "  <-- HIGH, the query counts below are inflated" : "")
  );
  console.log("=".repeat(W));

  /* ---- warm the connection pool ---- *
   * Without this the first phase pays for pool setup and TCP handshakes, and
   * "cold cache" gets credited with work that has nothing to do with caching. */
  await fetch(urls[0]).then((r) => r.text());

  /* ---- COLD ---- */
  const dropped = await flushCache(redisUrl);
  const cold = await burst(urls);

  /* ---- WARM ---- *
   * No flush. The burst above left every entry populated. */
  const warm = await burst(urls);

  /* ---- report ---- */
  const cs = [...cold.latencies].sort((a, b) => a - b);
  const ws = [...warm.latencies].sort((a, b) => a - b);

  console.log("");
  console.log(`  (cleared ${dropped} cache key${dropped === 1 ? "" : "s"} before the cold run)`);
  console.log("");
  row("", "COLD", "WARM");
  rule();
  row("p50", ms(pct(cs, 50)), ms(pct(ws, 50)));
  row("p95", ms(pct(cs, 95)), ms(pct(ws, 95)));
  row("p99", ms(pct(cs, 99)), ms(pct(ws, 99)));
  row("slowest", ms(cs[cs.length - 1] ?? 0), ms(ws[ws.length - 1] ?? 0));
  rule();
  row("db transactions", String(cold.queries), String(warm.queries));
  row(
    "per request",
    (cold.queries / urls.length).toFixed(1),
    (warm.queries / urls.length).toFixed(1)
  );
  rule();

  if (cold.failures || warm.failures) {
    console.log(`  FAILURES: ${cold.failures} cold, ${warm.failures} warm — result is not usable.`);
    rule();
  }

  if (HOT) {
    const missed = Math.max(1, Math.round(cold.queries / 6));
    console.log(`  Only ~${missed} of ${urls.length} cold requests actually missed — the first`);
    console.log(`  populated the key for the rest. That is what --hot measures.`);
    console.log(`  Drop the flag for the true per-page cost.`);
    rule();
  }

  const p95Cold = pct(cs, 95);
  const p95Warm = pct(ws, 95);

  if (p95Warm > 0 && p95Cold > p95Warm) {
    console.log(`  p95 is ${(p95Cold / p95Warm).toFixed(1)}x faster warm.`);
  }
  if (cold.queries > warm.queries) {
    console.log(`  ${cold.queries} database transactions became ${warm.queries}.`);

    /**
     * A handful of warm transactions is the idle rate, not the endpoint.
     *
     * Said out loud rather than rounded to zero. The counter is database-wide
     * and the settle windows are ~3s per phase, so anything else connected —
     * a Studio session, a dev server's health probe — lands in this column.
     */
    if (warm.queries === 0) {
      console.log(`  The database was not touched at all.`);
    } else if (idle > 0 && warm.queries <= Math.ceil(idle * 4)) {
      console.log(
        `  That ${warm.queries} is within the ${idle.toFixed(1)}/sec idle rate over ~4s of`
      );
      console.log(`  measurement windows — it is background noise, not the endpoint.`);
    }
  }

  /**
   * The honest caveat, printed rather than left for the reader to work out.
   *
   * A cold run against a warm cache measures nothing, and the difference
   * between the two phases here is entirely the cache — same process, same
   * pool, same query plans, same load.
   */
  console.log("");
  console.log("  Same process, same connection pool, same load. The only");
  console.log("  difference between the columns is whether the cache was primed.");
  console.log("=".repeat(W));

  await prisma.$disconnect();
  process.exit(cold.failures || warm.failures ? 1 : 0);
}

void main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
