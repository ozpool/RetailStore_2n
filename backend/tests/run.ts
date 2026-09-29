import { spawn } from "child_process";
import path from "path";
import { API, WEB, disconnect, prisma } from "./lib/db";
import { purgeStaleTestData } from "./lib/fixtures";

/**
 * Runs every suite and reports one total.
 *
 * Each suite runs as its own process. That costs a second of startup per suite
 * and buys isolation: a suite that hangs or crashes cannot take the others with
 * it, and a Playwright browser that fails to close cannot leak into the next
 * run.
 *
 *   npm test                 everything
 *   npm test -- api          only the API suites
 *   npm test -- reviews      any suite whose name contains "reviews"
 *   npm run test:api         shorthand
 */

type Suite = { name: string; file: string; kind: "api" | "browser"; slow?: boolean };

const SUITES: Suite[] = [
  // Fast first: an API failure is usually the real cause of a browser failure,
  // and finding it in ten seconds beats finding it in four minutes.
  // First: no API, no browser, ~1s, and it covers the write path every other
  // suite's notifications now go through.
  { name: "outbox", file: "api/outbox.ts", kind: "api" },
  { name: "retry-ladder", file: "api/retry-ladder.ts", kind: "api" },
  { name: "email-delivery", file: "api/email-delivery.ts", kind: "api" },
  { name: "push-delivery", file: "api/push-delivery.ts", kind: "api" },
  { name: "sms-delivery", file: "api/sms-delivery.ts", kind: "api" },
  { name: "operations", file: "api/operations.ts", kind: "api" },
  { name: "payouts", file: "api/payouts.ts", kind: "api" },
  { name: "payout-routes", file: "api/payout-routes.ts", kind: "api" },
  { name: "returns", file: "api/returns.ts", kind: "api" },
  { name: "messaging", file: "api/messaging.ts", kind: "api" },
  { name: "placement", file: "api/placement.ts", kind: "api" },
  { name: "placement-routes", file: "api/placement-routes.ts", kind: "api" },
  { name: "promoted-homepage", file: "api/promoted-homepage.ts", kind: "api" },
  { name: "return-routes", file: "api/return-routes.ts", kind: "api" },
  { name: "wishlist", file: "api/wishlist.ts", kind: "api" },
  { name: "reviews", file: "api/reviews.ts", kind: "api" },
  { name: "checkout-bff", file: "api/checkout-bff.ts", kind: "api" },
  { name: "addresses-sales", file: "api/addresses-and-sales.ts", kind: "api" },
  { name: "notifications", file: "api/notifications.ts", kind: "api" },
  { name: "refunds", file: "api/refunds.ts", kind: "api" },
  { name: "passwords", file: "api/passwords.ts", kind: "api" },
  { name: "refresh", file: "api/refresh.ts", kind: "api" },
  { name: "ratelimit", file: "api/ratelimit.ts", kind: "api" },
  { name: "cache", file: "api/cache.ts", kind: "api" },
  { name: "storage", file: "api/storage.ts", kind: "api" },
  { name: "uploads", file: "api/uploads.ts", kind: "api" },
  { name: "admin", file: "api/admin.ts", kind: "api" },
  { name: "identity", file: "api/identity.ts", kind: "api" },
  { name: "identity-stale", file: "api/identity-stale-session.ts", kind: "api" },
  // Waits ~60s for the reconciliation sweeper.
  { name: "payment-safety", file: "payment-safety.ts", kind: "api", slow: true },

  { name: "browser-catalog", file: "browser/catalog.ts", kind: "browser" },
  { name: "browser-checkout", file: "browser/checkout.ts", kind: "browser" },
  { name: "browser-fulfilment", file: "browser/fulfilment.ts", kind: "browser" },
  { name: "browser-admin", file: "browser/admin-and-notifications.ts", kind: "browser" },
  { name: "browser-dashboard", file: "browser/admin-dashboard.ts", kind: "browser" },
  { name: "browser-placement", file: "browser/placement.ts", kind: "browser" },
  { name: "browser-wishlist", file: "browser/wishlist.ts", kind: "browser" },
  { name: "browser-reviews", file: "browser/reviews.ts", kind: "browser" },
  { name: "browser-identity", file: "browser/identity.ts", kind: "browser" },
  // Waits ~30s for a hold to expire on its own.
  { name: "browser-cart-badge", file: "browser/cart-badge.ts", kind: "browser", slow: true },
];

function runOne(suite: Suite): Promise<{ code: number; passed: number; failed: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
       path.join(import.meta.dirname, suite.file)],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env }
    );

    let out = "";
    child.stdout.on("data", (d) => {
      const text = String(d);
      out += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (d) => {
      const text = String(d);
      out += text;
      process.stderr.write(text);
    });

    child.on("close", (code) => {
      const m = out.match(/(\d+) passed, (\d+) failed/);
      resolve({
        code: code ?? 1,
        passed: m ? Number(m[1]) : 0,
        failed: m ? Number(m[2]) : code === 0 ? 0 : 1,
      });
    });
  });
}

async function preflight() {
  const problems: string[] = [];
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    problems.push("Postgres is unreachable — check DATABASE_URL and that the container is up");
  }
  try {
    const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) problems.push(`API at ${API} returned ${r.status}`);
  } catch {
    problems.push(`API not running at ${API} — start it with: npm run dev`);
  }
  try {
    await fetch(WEB, { signal: AbortSignal.timeout(8000) });
  } catch {
    problems.push(`Frontend not running at ${WEB} — start it with: npm run dev in frontend/`);
  }

  if (problems.length) {
    console.error("\nCannot run the suite:\n");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nThese are end-to-end tests; they drive the real stack.\n");
    process.exit(2);
  }

  await warnIfSlow();
}

/**
 * Warns when the frontend is already slow before a single test has run.
 *
 * A Next dev server that has been up for hours accumulates compilation state —
 * it has been observed at 1.3 GB serving warm pages in five seconds. Under that,
 * browser suites fail on `waitFor` timeouts and hydration warnings that have
 * nothing to do with the code, and a whole run took 2.6x its usual time before
 * anyone noticed why.
 *
 * A confusing mid-run failure becomes one sentence up front. Deliberately a
 * warning rather than a hard stop: slow is not broken, and refusing to run would
 * be worse than running slowly.
 */
async function warnIfSlow() {
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    try {
      await fetch(`${WEB}/search`, { signal: AbortSignal.timeout(30_000) });
      samples.push(Date.now() - started);
    } catch {
      samples.push(30_000);
    }
  }
  const median = samples.sort((a, b) => a - b)[1];

  if (median > 1500) {
    console.warn(
      `\n  Frontend is slow: ${median}ms to serve /search (warm).\n` +
        "  Browser suites may fail on timeouts that are not code bugs.\n" +
        "  Restart the frontend dev server, or run against a production build:\n" +
        "    cd frontend && npm run build && npm start\n"
    );
  }
}

async function main() {
  const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const selected = filters.length
    ? SUITES.filter((s) =>
        filters.some((f) => s.name.includes(f) || s.kind === f || s.file.includes(f))
      )
    : SUITES;

  if (selected.length === 0) {
    console.error(`No suite matches ${filters.join(", ")}.`);
    console.error(`Available: ${SUITES.map((s) => s.name).join(", ")}`);
    process.exit(2);
  }

  await preflight();

  // A crashed earlier run can leave accounts behind. They are all under a
  // reserved prefix, so this can never touch a real one.
  const purged = await purgeStaleTestData();
  if (purged > 0) console.log(`Removed ${purged} leftover test account(s) from an earlier run.\n`);

  const started = Date.now();
  const results: Array<{ suite: Suite; passed: number; failed: number; code: number; ms: number }> = [];

  for (const suite of selected) {
    const t0 = Date.now();
    const r = await runOne(suite);
    results.push({ suite, ...r, ms: Date.now() - t0 });
    console.log("");
  }

  const totalPassed = results.reduce((a, r) => a + r.passed, 0);
  const totalFailed = results.reduce((a, r) => a + r.failed, 0);

  console.log("=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));
  for (const r of results) {
    const mark = r.failed === 0 && r.code === 0 ? "ok  " : "FAIL";
    console.log(
      `  ${mark}  ${r.suite.name.padEnd(20)} ${String(r.passed).padStart(3)} passed` +
        `${r.failed ? `, ${r.failed} failed` : ""}` +
        `   ${(r.ms / 1000).toFixed(0)}s`
    );
  }
  console.log("-".repeat(70));
  console.log(
    `  ${totalPassed} passed, ${totalFailed} failed across ${results.length} suites` +
      `   ${((Date.now() - started) / 1000).toFixed(0)}s total`
  );
  console.log("=".repeat(70));

  await disconnect();
  process.exit(totalFailed === 0 && results.every((r) => r.code === 0) ? 0 : 1);
}

void main();
