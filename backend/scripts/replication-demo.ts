import "dotenv/config";
import { Client } from "pg";

/**
 * Proves the standby is a real standby, and measures how far behind it is.
 *
 *   docker compose --profile ha up -d postgres-replica
 *   npx tsx scripts/replication-demo.ts
 *
 * WHAT NEEDS PROVING
 * A second Postgres that starts without error is not a standby. It could be an
 * empty database that nobody is streaming to, and it would look identical from
 * the outside: healthy, accepting connections, answering queries. Four things
 * have to be true, and this checks each one rather than inferring it from the
 * absence of an error.
 *
 *   1. The replica is in recovery and the primary is not.
 *   2. The primary can see the replica streaming, by name.
 *   3. The replica refuses writes.
 *   4. A row committed on the primary appears on the replica, and how long
 *      that actually takes.
 *
 * WHAT THIS IS NOT
 * A backup test. Replication copies `DROP TABLE orders` faithfully and in
 * milliseconds; that is it working correctly. Surviving a mistake needs
 * point-in-time recovery, which is separate.
 *
 * See docs/adr/0020-replication-and-backups.md
 */

const PRIMARY = process.env.PRIMARY_URL ?? "postgresql://retailstore_2n:retailstore_2n@localhost:5433/retailstore_2n";
const REPLICA = process.env.REPLICA_URL ?? "postgresql://retailstore_2n:retailstore_2n@localhost:5434/retailstore_2n";

const W = 72;
const rule = (c = "-") => console.log(c.repeat(W));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;

function check(ok: boolean, label: string, detail?: unknown) {
  const suffix = detail === undefined ? "" : ` — ${String(detail)}`;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${suffix}`);
  if (!ok) failures++;
}

async function one<T>(c: Client, sql: string, params: unknown[] = []): Promise<T> {
  const res = await c.query(sql, params as never[]);
  return res.rows[0] as T;
}

async function main() {
  console.log("=".repeat(W));
  console.log("STREAMING REPLICATION");
  console.log("=".repeat(W));
  console.log(`  primary   ${PRIMARY.replace(/:[^:@]*@/, ":***@")}`);
  console.log(`  replica   ${REPLICA.replace(/:[^:@]*@/, ":***@")}`);
  console.log("=".repeat(W));

  const primary = new Client({ connectionString: PRIMARY });
  const replica = new Client({ connectionString: REPLICA });

  try {
    await primary.connect();
  } catch (err) {
    console.error(`\n  Cannot reach the primary: ${(err as Error).message}\n`);
    process.exit(2);
  }

  try {
    await replica.connect();
  } catch (err) {
    console.error(
      `\n  Cannot reach the replica: ${(err as Error).message}\n\n` +
        "  Start it with:  docker compose --profile ha up -d postgres-replica\n"
    );
    await primary.end();
    process.exit(2);
  }

  /* ============================================================ *
   * 1. Which one is which.
   * ============================================================ */
  console.log("\n[1 - the roles are what they claim to be]");

  const p = await one<{ recovery: boolean }>(primary, "SELECT pg_is_in_recovery() AS recovery");
  const r = await one<{ recovery: boolean }>(replica, "SELECT pg_is_in_recovery() AS recovery");

  check(p.recovery === false, "the primary is not in recovery — it accepts writes");
  check(r.recovery === true, "the replica IS in recovery — it is replaying, not serving alone");

  /* ============================================================ *
   * 2. The primary can see it.
   *
   * This is the assertion that catches an "empty second database that
   * nobody is streaming to" — a replica that exists and is connected to
   * nothing looks healthy from its own side.
   * ============================================================ */
  console.log("\n[2 - the primary sees the standby streaming]");

  const senders = await primary.query<{
    application_name: string;
    state: string;
    sync_state: string;
    sent_lsn: string;
    replay_lsn: string;
    lag_bytes: string;
  }>(`
    SELECT application_name, state, sync_state,
           sent_lsn::text, replay_lsn::text,
           (pg_current_wal_lsn() - replay_lsn)::text AS lag_bytes
    FROM pg_stat_replication
  `);

  check(senders.rowCount === 1, "exactly one standby is connected", senders.rowCount);

  if (senders.rowCount) {
    const s = senders.rows[0];
    check(s.state === "streaming", "and its state is streaming", s.state);
    console.log(`        sync mode     ${s.sync_state}`);
    console.log(`        sent / replay ${s.sent_lsn} / ${s.replay_lsn}`);
    console.log(`        behind by     ${s.lag_bytes} bytes of WAL`);

    /**
     * ASYNCHRONOUS, AND THAT IS THE DEFAULT FOR A REASON.
     *
     * With `synchronous_commit = remote_apply` the primary would wait for the
     * standby before acknowledging every commit — so checkout latency would
     * depend on the replica, and the replica going down would stop the site
     * taking money. Asynchronous means a crash can lose the last few
     * milliseconds of commits. That is the trade, and losing the tail of a
     * transaction log is what point-in-time recovery is for.
     */
    check(s.sync_state === "async", "asynchronous — a slow replica cannot stall checkout");
  }

  const slots = await primary.query<{ slot_name: string; active: boolean }>(
    "SELECT slot_name, active FROM pg_replication_slots"
  );
  check(
    slots.rows.some((x) => x.active),
    "a replication slot is active — the primary is holding WAL for this standby",
    slots.rows.map((x) => `${x.slot_name}=${x.active ? "active" : "inactive"}`).join(", ") || "none"
  );

  /* ============================================================ *
   * 3. It refuses writes.
   *
   * Not politeness — it is what stops a misconfigured connection string
   * silently sending writes somewhere they will be overwritten by the
   * next WAL record.
   * ============================================================ */
  console.log("\n[3 - the replica is read-only]");

  let refused = "";
  try {
    await replica.query("CREATE TABLE should_not_exist (id int)");
  } catch (err) {
    refused = (err as Error).message;
  }
  check(
    refused.includes("read-only"),
    "a write to the replica is refused by the server, not by convention",
    refused.split("\n")[0] || "it was ACCEPTED"
  );

  /* ============================================================ *
   * 4. A committed row actually arrives, and how fast.
   *
   * In its own schema. Prisma manages `public`, so a probe table there
   * would show up as schema drift on the next migrate.
   * ============================================================ */
  console.log("\n[4 - a committed row arrives, and how long it takes]");

  await primary.query("CREATE SCHEMA IF NOT EXISTS replication_probe");
  await primary.query(`
    CREATE TABLE IF NOT EXISTS replication_probe.beat (
      id bigserial PRIMARY KEY,
      written_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);

  // Let the DDL itself replicate before timing anything, or the first
  // measurement includes creating the table on the replica.
  await sleep(500);

  const samples: number[] = [];

  for (let i = 0; i < 5; i++) {
    const started = process.hrtime.bigint();
    const { id } = await one<{ id: string }>(
      primary,
      "INSERT INTO replication_probe.beat DEFAULT VALUES RETURNING id"
    );

    // Poll rather than sleep-and-check-once: the answer is single-digit
    // milliseconds on a local network and a fixed sleep would measure the
    // sleep instead.
    let arrived = false;
    while (process.hrtime.bigint() - started < 10_000_000_000n) {
      const hit = await one<{ n: string }>(
        replica,
        "SELECT count(*) AS n FROM replication_probe.beat WHERE id = $1",
        [id]
      );
      if (Number(hit.n) === 1) {
        arrived = true;
        break;
      }
    }

    if (!arrived) {
      check(false, `row ${id} never reached the replica within 10s`);
      break;
    }
    samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
  }

  if (samples.length === 5) {
    const sorted = [...samples].sort((a, b) => a - b);
    check(true, "all five rows arrived on the replica");
    console.log(`        median        ${sorted[2].toFixed(1)}ms`);
    console.log(`        slowest       ${sorted[4].toFixed(1)}ms`);
    console.log(
      `        each          ${samples.map((s) => `${s.toFixed(1)}ms`).join(", ")}`
    );
  }

  const lag = await one<{ replay_lag: string | null }>(
    replica,
    `SELECT (now() - pg_last_xact_replay_timestamp())::text AS replay_lag`
  );
  console.log(`        replay lag    ${lag.replay_lag ?? "no replayed transaction yet"}`);

  // Tidied up. The schema stays — it is empty, costs nothing, and re-creating
  // it on every run would replicate DDL noise for no reason.
  await primary.query("TRUNCATE replication_probe.beat");

  rule("=");
  if (failures === 0) {
    console.log("  The standby is streaming, read-only, and seconds behind at worst.");
    console.log("");
    console.log("  It is NOT a backup. Replication would copy `DROP TABLE orders`");
    console.log("  faithfully and in milliseconds. That needs point-in-time recovery.");
  } else {
    console.log(`  ${failures} check(s) failed — this is not a working standby.`);
  }
  rule("=");

  await primary.end();
  await replica.end();
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
