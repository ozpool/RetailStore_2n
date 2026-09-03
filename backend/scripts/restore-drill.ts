import "dotenv/config";
import { execFileSync } from "node:child_process";
import { Client } from "pg";

/**
 * Destroys a table, then gets it back. End to end, with the row counts printed.
 *
 *   docker compose --profile tools run --rm base-backup     # once, first
 *   npx tsx scripts/restore-drill.ts
 *
 * WHY THIS SCRIPT EXISTS
 * A backup that has never been restored is not a backup, it is a hope.
 * Retention settings and a green "backup succeeded" line prove a file was
 * written; they say nothing about whether anything can be rebuilt from it. The
 * only evidence is a restore, and the only way a restore is trustworthy is if
 * it is boring — rehearsed often enough that nobody is improvising during an
 * incident.
 *
 * WHAT IT ACTUALLY DOES
 *   1. Creates a table and fills it with rows. Real, committed, archived.
 *   2. Notes the time, and forces the WAL segment holding all this into
 *      object storage.
 *   3. DROPS THE TABLE.
 *   4. Restores to the instant before the drop, into a second database.
 *   5. Counts the rows in both, and shows one has them and the other does not.
 *
 * ON ITS OWN TABLE, NOT `orders`
 * The mechanism does not care which table it is — recovery replays the whole
 * cluster to a moment, so dropping `orders` would be recovered identically.
 * A dedicated table means the drill is repeatable and leaves the database it
 * ran against untouched, which is what makes it something you run weekly
 * rather than once.
 *
 * See docs/adr/0020-replication-and-backups.md
 */

const LIVE = process.env.PRIMARY_URL ?? "postgresql://retailstore_2n:retailstore_2n@localhost:5433/retailstore_2n";
const RESTORED = process.env.RESTORED_URL ?? "postgresql://retailstore_2n:retailstore_2n@localhost:5435/retailstore_2n";
const ROWS = Number(process.env.DRILL_ROWS ?? 500);

const W = 74;
const rule = (c = "-") => console.log(c.repeat(W));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(ok: boolean, label: string, detail?: unknown) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

function compose(args: string[], opts: { quiet?: boolean } = {}): string {
  return execFileSync("docker", ["compose", ...args], {
    cwd: new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    encoding: "utf8",
    stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
    env: process.env,
  });
}

async function connect(url: string, label: string, timeoutMs = 120_000): Promise<Client> {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    try {
      await c.connect();
      // A recovering database accepts connections before it has promoted, and
      // answers queries as a read-only standby. Waiting for the promotion is
      // the difference between reading the past and reading a half-replayed
      // version of it.
      const { rows } = await c.query("SELECT pg_is_in_recovery() AS recovering");
      if (rows[0].recovering === false) return c;
      lastError = "still replaying";
      await c.end();
    } catch (err) {
      lastError = (err as Error).message.split("\n")[0];
      try { await c.end(); } catch { /* never connected */ }
    }
    await sleep(2000);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs / 1000}s: ${lastError}`);
}

async function main() {
  console.log("=".repeat(W));
  console.log("RESTORE DRILL — destroy a table, then get it back");
  console.log("=".repeat(W));

  const live = new Client({ connectionString: LIVE });
  await live.connect();

  /* ---- is there anything to restore FROM? ---- */
  const bases = compose(
    ["--profile", "tools", "run", "--rm", "--entrypoint", "mc", "base-backup",
     "-q", "ls", `backups/${process.env.S3_BACKUP_BUCKET ?? "retailstore-2n-backups"}/base/`],
    { quiet: true }
  ).trim();

  if (!bases) {
    console.error(
      "\n  No base backup exists, so there is nothing to recover onto.\n" +
        "  WAL archiving alone restores nothing — recovery replays the log ONTO a copy.\n\n" +
        "    docker compose --profile tools run --rm base-backup\n"
    );
    await live.end();
    process.exit(2);
  }
  console.log(`  base backups available : ${bases.split("\n").length}`);

  /* ============================================================ *
   * 1. Something worth losing.
   * ============================================================ */
  console.log("\n[1 — create something worth losing]");

  await live.query("CREATE SCHEMA IF NOT EXISTS restore_drill");
  await live.query("DROP TABLE IF EXISTS restore_drill.canary");
  await live.query(`
    CREATE TABLE restore_drill.canary (
      id bigserial PRIMARY KEY,
      note text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
  await live.query(
    `INSERT INTO restore_drill.canary (note)
     SELECT 'drill row ' || g FROM generate_series(1, $1) g`,
    [ROWS]
  );

  const before = Number(
    (await live.query("SELECT count(*) AS n FROM restore_drill.canary")).rows[0].n
  );
  check(before === ROWS, `${before} rows committed`, `expected ${ROWS}`);

  /* ============================================================ *
   * 2. The recovery point.
   *
   * Postgres's clock, not this script's: recovery_target_time is compared
   * against commit timestamps in the WAL, and a machine whose clock is a
   * few seconds off would silently recover to the wrong instant.
   * ============================================================ */
  console.log("\n[2 — mark the moment, and get it into object storage]");

  const target = (await live.query("SELECT now() AS t")).rows[0].t as Date;
  console.log(`  recovery target : ${target.toISOString()}`);

  // A commit is only recoverable once the segment holding it has been
  // archived. Forcing the switch is what makes this drill take seconds
  // instead of up to archive_timeout.
  await live.query("SELECT pg_switch_wal()");
  await sleep(3000);

  const archiver = (
    await live.query(
      "SELECT archived_count, failed_count, last_archived_wal FROM pg_stat_archiver"
    )
  ).rows[0];
  check(Number(archiver.failed_count) === 0, "the archive has no failures", `failed=${archiver.failed_count}`);
  check(!!archiver.last_archived_wal, "and a segment has landed", archiver.last_archived_wal);

  /* ============================================================ *
   * 3. Destroy it.
   * ============================================================ */
  console.log("\n[3 — destroy it]");

  await sleep(1000);
  await live.query("DROP TABLE restore_drill.canary");
  console.log("  DROP TABLE restore_drill.canary");

  // The drop needs archiving too, or recovery would stop before it and the
  // drill would prove nothing about rolling past a mistake.
  await live.query("SELECT pg_switch_wal()");
  await sleep(3000);

  let liveStillGone = false;
  try {
    await live.query("SELECT count(*) FROM restore_drill.canary");
  } catch (err) {
    liveStillGone = (err as Error).message.includes("does not exist");
  }
  check(liveStillGone, "the table is gone from the live database");

  /* ============================================================ *
   * 4. Recover to one second before.
   * ============================================================ */
  console.log("\n[4 — recover to the moment before]");

  // Any previous drill's container would otherwise be reused, and a database
  // that is already running is never restored — it just answers.
  compose(["--profile", "tools", "rm", "-sf", "restore"], { quiet: true });

  const targetSql = target.toISOString().replace("T", " ").replace("Z", "+00");
  console.log(`  restoring to ${targetSql}`);
  console.log("");

  process.env.RECOVERY_TARGET_TIME = targetSql;
  compose(["--profile", "tools", "up", "-d", "restore"]);

  const restored = await connect(RESTORED, "the restored database");

  /* ============================================================ *
   * 5. Count both.
   * ============================================================ */
  console.log("\n[5 — count both]");

  const after = Number(
    (await restored.query("SELECT count(*) AS n FROM restore_drill.canary")).rows[0].n
  );

  check(after === before, `the restored database has all ${after} rows back`, `expected ${before}`);

  // Recovery replays the whole cluster, so the application's own tables have
  // to be intact too — a restore that produced only the drill table would mean
  // something far stranger had happened.
  const listings = Number(
    (await restored.query("SELECT count(*) AS n FROM listings")).rows[0].n
  );
  const liveListings = Number(
    (await live.query("SELECT count(*) AS n FROM listings")).rows[0].n
  );
  check(
    listings > 0 && listings === liveListings,
    "and the whole database came with it, not just that table",
    `listings: restored=${listings} live=${liveListings}`
  );

  const recovering = (await restored.query("SELECT pg_is_in_recovery() AS r")).rows[0].r;
  check(recovering === false, "the restored database was promoted, not left replaying");

  /* ---- report ---- */
  console.log("");
  rule("=");
  console.log(`  ${"".padEnd(34)}${"LIVE".padStart(12)}${"RESTORED".padStart(14)}`);
  rule();
  console.log(
    `  ${"restore_drill.canary rows".padEnd(34)}${"gone".padStart(12)}${String(after).padStart(14)}`
  );
  console.log(
    `  ${"listings".padEnd(34)}${String(liveListings).padStart(12)}${String(listings).padStart(14)}`
  );
  rule();

  if (failures === 0) {
    console.log(`  ${before} rows were dropped and recovered from object storage.`);
    console.log("");
    console.log("  This is what a replica cannot do. A standby would have copied the");
    console.log("  DROP faithfully, in milliseconds, and been just as empty.");
  } else {
    console.log(`  ${failures} check(s) failed — this backup strategy is not proven.`);
  }
  rule("=");
  console.log("");
  console.log(`  The restored database is still up on 5435. Inspect it, then:`);
  console.log(`    docker compose --profile tools rm -sf restore`);

  await live.end();
  await restored.end();
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(`\n  drill failed: ${(err as Error).message}\n`);
  process.exit(1);
});
