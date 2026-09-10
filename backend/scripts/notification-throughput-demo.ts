import "dotenv/config";
import { randomUUID } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { prisma } from "../src/lib/prisma";
import { drain } from "../src/lib/relay";
import { notifyMany } from "../src/lib/notifications";
import { ensureTopics, kafka, TOPICS } from "../src/lib/kafka";
import { DeliveryChannel, NotificationType } from "../src/generated/prisma/enums";

/**
 * Measures what Kafka actually bought, and where it stops paying.
 *
 * WHAT IS BEING CLAIMED
 * Plan 0001 §2 justifies a broker on three things, and the second is
 * "independent consumer scaling — SMS is slow and email is not; they should not
 * share a throughput budget". That is a performance claim, and this repository
 * measures performance rather than asserting it. So: N events through the real
 * email consumer group, at several consumer counts, reporting the lag
 * distribution and the throughput at each.
 *
 * AND WHERE IT STOPS. A consumer group cannot usefully run more consumers than
 * the topic has partitions — the extras are assigned nothing and idle. The main
 * topic has 12 partitions (ADR 0025), so consumer 13 does no work at all. That
 * is the unflattering half of the result and it is measured here rather than
 * left as a footnote.
 *
 * THE TOPIC IS PRE-LOADED BEFORE THE CLOCK STARTS, AND THAT IS DELIBERATE
 * The relay is drained fully first, so every event is already on the broker
 * when the consumers start. The number this prints is therefore consumer-side
 * drain time, not end-to-end latency from the emitting call site — because the
 * thing being varied is consumers per group, and leaving the relay in the
 * measurement would mix its polling interval into every row.
 *
 * The relay's own publish rate is measured and printed separately, so the two
 * halves are both visible instead of being averaged into one misleading figure.
 *
 * HOW THE PARTITION CEILING IS PROVEN
 * Not from the throughput curve. On a machine with few cores, throughput
 * flattens because the consumers are contending for CPU, which looks identical
 * to flattening because they ran out of partitions — and concluding the latter
 * from the former would be exactly the kind of measurement this script exists
 * to avoid.
 *
 * Instead the broker is asked. `describeGroups` reports each member and the
 * partitions assigned to it, so "3 of 15 consumers were assigned nothing" is
 * the broker's own answer and is true regardless of how fast the hardware is.
 *
 *   npx tsx scripts/notification-throughput-demo.ts
 *   npx tsx scripts/notification-throughput-demo.ts --events 2000 --consumers 1,4
 *
 * REQUIREMENTS
 *   KAFKA_BROKERS      a reachable broker. There is nothing to measure without one.
 *   a compiled build   the consumers are `node dist/worker.js`, which is what
 *                      production runs. `npm run build` first.
 *
 * See docs/adr/0025-kafka-topics-and-partitioning.md
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

const EVENTS = Number(arg("events", "10000"));
/**
 * Distinct recipients, and this number is not cosmetic.
 *
 * The partition key is userId. With one user every event hashes to one
 * partition, every consumer but one idles, and the script would "prove" that
 * Kafka does not scale. 500 spreads across all 12.
 */
const USERS = Number(arg("users", "500"));
const CONSUMER_COUNTS = arg("consumers", "1,3,6,12,15")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
const GROUP = "email-worker";
const TAG = `rs2.throughput.${Date.now()}`;

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

const W = 72;
const rule = (c = "-") => console.log(c.repeat(W));

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

function ms(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}s` : `${n.toFixed(0)}ms`;
}

const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

/* ------------------------------------------------------------------ *
 * The load
 * ------------------------------------------------------------------ */

let userIds: string[] = [];

async function seedUsers(): Promise<void> {
  const rows = Array.from({ length: USERS }, (_, i) => ({
    email: `${TAG}.${i}@retailstore-2n.test`,
    name: `Throughput ${i}`,
    passwordHash: "not-a-real-hash",
    // Verified, or the email consumer records a permanent failure instead of
    // doing the work this is trying to measure.
    emailVerified: true,
  }));

  for (let i = 0; i < rows.length; i += 200) {
    await prisma.user.createMany({ data: rows.slice(i, i + 200) });
  }
  const created = await prisma.user.findMany({
    where: { email: { startsWith: TAG } },
    select: { id: true },
  });
  userIds = created.map((u) => u.id);
}

/** Writes `n` notifications and their outbox events, in the real transaction. */
async function enqueue(n: number): Promise<void> {
  const BATCH = 250;
  for (let written = 0; written < n; written += BATCH) {
    const size = Math.min(BATCH, n - written);
    await notifyMany(
      Array.from({ length: size }, (_, k) => ({
        userId: userIds[(written + k) % userIds.length],
        type: NotificationType.ORDER_SHIPPED,
        title: "Your order shipped",
        body: `Throughput probe ${written + k}`,
        link: null,
        aggregateType: "Order",
        aggregateId: randomUUID(),
      }))
    );
  }
}

/* ------------------------------------------------------------------ *
 * The consumers
 * ------------------------------------------------------------------ */

const running: ChildProcess[] = [];

function startWorkers(count: number) {
  const entry = path.join(process.cwd(), "dist", "worker.js");

  for (let i = 0; i < count; i += 1) {
    const child = spawn(process.execPath, [entry, GROUP], {
      env: {
        ...process.env,
        NOTIFY_TRANSPORT: "kafka",
        // The provider is a console sink. Its cost IS included in these
        // numbers — what is excluded is the network to a real SMTP server.
        MAIL_TRANSPORT: "console",
      },
      // Ignored rather than inherited: the console mail transport prints a line
      // per message, and N of those would be the slowest part of the run.
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", () => {});
    running.push(child);
  }
}

/**
 * Stops the consumers and waits for the broker to agree that they are gone.
 *
 * A SIGKILLed consumer does not leave its group — it stops answering, and the
 * coordinator keeps it as a member until the session timeout expires. So the
 * next run starts against a group that still contains the last run's corpses,
 * they are counted as members, and some of them still "own" partitions.
 *
 * That is not a hypothetical either: the first version killed after 1.5s and
 * reported four members for a single consumer.
 */
async function stopWorkers(): Promise<void> {
  for (const c of running) c.kill("SIGTERM");

  // SIGTERM is handled — the worker disconnects, which leaves the group
  // cleanly. Give it time to actually do that before resorting to SIGKILL.
  const exits = running.map(
    (c) =>
      new Promise<void>((resolve) => {
        if (c.exitCode !== null) return resolve();
        c.once("exit", () => resolve());
      })
  );
  await Promise.race([Promise.all(exits), sleep(15_000)]);

  for (const c of running) if (c.exitCode === null) c.kill("SIGKILL");
  running.length = 0;

  await waitForGroupEmpty();
}

/** Blocks until the group has no members, or gives up loudly. */
async function waitForGroupEmpty(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { members } = await assignment();
    if (members === 0) return;
    if (Date.now() > deadline) {
      console.log(
        `  WARNING: ${members} stale member(s) still in ${GROUP} — the next` +
          " run's assignment figures will be wrong."
      );
      return;
    }
    await sleep(2000);
  }
}

/* ------------------------------------------------------------------ *
 * Measurement
 * ------------------------------------------------------------------ */

type Run = {
  consumers: number;
  settled: number;
  wallMs: number;
  lags: number[];
  assigned: number;
  members: number;
  timedOut: boolean;
};

/** Deliveries this run settled, and when each finished. */
async function settledSince(t0: Date) {
  return prisma.notificationDelivery.findMany({
    where: {
      channel: DeliveryChannel.EMAIL,
      createdAt: { gte: t0 },
      completedAt: { not: null },
    },
    select: { completedAt: true },
  });
}

/**
 * How many consumers the broker gave a slice of the MAIN topic to.
 *
 * WHY THIS IS NOT `describeGroups`
 * That is the obvious call and it was the first thing tried. This client
 * returns `memberAssignment: null` for every member, so it can say how many
 * members there are and not which partitions they hold — which is the only
 * part that matters here.
 *
 * So the broker's own CLI is asked instead, and its per-partition output is
 * read: every partition row names the CONSUMER-ID that owns it, and the number
 * of DISTINCT owners of main-topic partitions is the answer.
 *
 * AND WHY IT IS THE MAIN TOPIC SPECIFICALLY, WHICH IS THE SUBTLE PART.
 * Every worker subscribes to the main topic AND all three retry rungs, so the
 * group has 12 + 6 + 6 + 6 = 30 partitions to hand out. A group can therefore
 * hold 30 members before anyone is completely idle — which means "12 is the
 * ceiling on consumers per group" is too loose a statement.
 *
 * What is true is narrower and is what this measures: past 12 members, some
 * hold NO main-topic partition, and those contribute nothing to the throughput
 * in this table however busy they look.
 */
async function assignment(): Promise<{ assigned: number; members: number }> {
  const container = arg("kafka-container", "");
  const name = container || detectKafkaContainer();
  if (!name) return { assigned: 0, members: 0 };

  const describe = (extra: string[]) =>
    new Promise<string>((resolve) => {
      const child = spawn(
        "docker",
        [
          "exec",
          name,
          "/opt/kafka/bin/kafka-consumer-groups.sh",
          "--bootstrap-server",
          "localhost:9092",
          "--describe",
          "--group",
          GROUP,
          ...extra,
        ],
        { stdio: ["ignore", "pipe", "ignore"] }
      );
      let out = "";
      child.stdout.on("data", (d) => {
        out += String(d);
      });
      child.on("close", () => resolve(out));
      child.on("error", () => resolve(""));
    });

  // One row per member, with how many partitions it holds in total.
  const members = (await describe(["--members"]))
    .split("\n")
    .filter((l) => l.includes(GROUP) && !l.includes("CONSUMER-ID")).length;

  // One row per partition, naming its owner. Distinct owners of MAIN.
  const owners = new Set<string>();
  for (const line of (await describe([])).split("\n")) {
    if (!line.includes(TOPICS.main)) continue;
    const cols = line.trim().split(/\s+/);
    const consumerId = cols[6];
    if (consumerId && consumerId !== "-") owners.add(consumerId);
  }

  return { assigned: owners.size, members };
}

function detectKafkaContainer(): string {
  try {
    const { execFileSync } = require("child_process") as typeof import("child_process");
    const out = execFileSync(
      "docker",
      ["ps", "--filter", "name=kafka", "--format", "{{.Names}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
  } catch {
    return "";
  }
}

async function measure(consumers: number): Promise<Run> {
  await enqueue(EVENTS);

  // Everything on the broker before the clock starts — see the header.
  const publishStart = Date.now();
  const published = await drain();
  const publishMs = Date.now() - publishStart;
  if (published > 0) {
    console.log(
      `  relay published ${published} in ${ms(publishMs)} ` +
        `(${Math.round((published / publishMs) * 1000)}/sec)`
    );
  }

  const t0 = new Date();
  startWorkers(consumers);

  let settled = 0;
  let assigned = { assigned: 0, members: 0 };
  const deadline = Date.now() + Math.max(120_000, EVENTS * 60);
  let lastProgress = Date.now();
  let sampledAssignment = false;

  for (;;) {
    await sleep(1000);
    const rows = await settledSince(t0);

    if (rows.length > settled) {
      settled = rows.length;
      lastProgress = Date.now();
    }

    // Sampled once, while the group is actually working and stable.
    if (!sampledAssignment && settled > EVENTS * 0.1) {
      assigned = await assignment();
      sampledAssignment = true;
    }

    if (settled >= EVENTS) break;
    if (Date.now() > deadline) break;
    // Stalled: nothing new for 30s means it is not going to finish.
    if (Date.now() - lastProgress > 30_000) break;
  }

  const rows = await settledSince(t0);
  const wallMs =
    rows.length === 0
      ? 0
      : Math.max(...rows.map((r) => r.completedAt!.getTime())) - t0.getTime();
  const lags = rows
    .map((r) => r.completedAt!.getTime() - t0.getTime())
    .sort((a, b) => a - b);

  if (!sampledAssignment) assigned = await assignment();
  await stopWorkers();

  return {
    consumers,
    settled: rows.length,
    wallMs,
    lags,
    assigned: assigned.assigned,
    members: assigned.members,
    timedOut: rows.length < EVENTS,
  };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function cleanup() {
  if (userIds.length === 0) return;
  await prisma.notificationDelivery.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.outboxEvent.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  /* ---- preflight ---- */
  if (!process.env.KAFKA_BROKERS?.trim()) {
    console.error(
      "\n  KAFKA_BROKERS is not set, and there is nothing to measure without a broker.\n" +
        "    docker compose --profile messaging up -d kafka\n" +
        "    KAFKA_BROKERS=localhost:9092 npx tsx scripts/notification-throughput-demo.ts\n"
    );
    process.exit(2);
  }

  /**
   * THE DEMO'S OWN TRANSPORT HAS TO BE kafka, AND THIS IS NOT A FORMALITY.
   *
   * `drain()` publishes through whatever transport this process is configured
   * for. Left on the default, it hands every event straight to the consumer
   * functions IN THIS PROCESS — so the run completes, prints a plausible relay
   * rate, and measures nothing at all. The first run of this script did exactly
   * that: 400 events delivered inline, and a table of zeros.
   */
  if ((process.env.NOTIFY_TRANSPORT ?? "inline").toLowerCase() !== "kafka") {
    console.error(
      `\n  NOTIFY_TRANSPORT is "${process.env.NOTIFY_TRANSPORT ?? "inline"}".\n` +
        "  On the inline transport the relay delivers in THIS process and the\n" +
        "  broker is never involved, so there is nothing to measure:\n\n" +
        "    NOTIFY_TRANSPORT=kafka KAFKA_BROKERS=localhost:9092 \\\n" +
        "      npx tsx scripts/notification-throughput-demo.ts\n"
    );
    process.exit(2);
  }

  const entry = path.join(process.cwd(), "dist", "worker.js");
  if (!fs.existsSync(entry)) {
    console.error(
      `\n  ${entry} does not exist. The consumers are the compiled build,\n` +
        "  because that is what production runs:\n\n    npm run build\n"
    );
    process.exit(2);
  }

  await ensureTopics("retailstore-2n-throughput-admin");

  /* ---- the partition count, read rather than assumed ---- */
  const admin = kafka("retailstore-2n-throughput-admin").admin();
  await admin.connect();
  /**
   * An ARRAY, not `{ topics: [...] }`. The KafkaJS-compatible surface differs
   * from KafkaJS here, and the shape was found by asking the client rather
   * than by trusting the docs — it threw on the first run.
   */
  const meta = (await admin.fetchTopicMetadata({ topics: [TOPICS.main] })) as unknown as Array<{
    name: string;
    partitions: unknown[];
  }>;
  const partitions = meta[0]?.partitions.length ?? 0;
  await admin.disconnect();

  console.log("");
  console.log("=".repeat(W));
  console.log("NOTIFICATION THROUGHPUT, AND THE PARTITION CEILING");
  console.log("=".repeat(W));
  console.log(`  topic         ${TOPICS.main}`);
  console.log(`  partitions    ${partitions}`);
  console.log(`  group         ${GROUP}  (the real email consumer)`);
  console.log(`  events/run    ${EVENTS}`);
  console.log(`  recipients    ${USERS}  (distinct userIds — the partition key)`);
  console.log(`  consumers     ${CONSUMER_COUNTS.join(", ")}`);
  console.log(`  provider      console mail sink (no SMTP network)`);
  console.log("=".repeat(W));

  await seedUsers();
  console.log(`  seeded ${userIds.length} recipients`);

  /**
   * A warm-up pass, because the group's committed offset may be behind
   * whatever earlier runs and test suites left on the topic. Without it the
   * first measured run pays for that history and reports a lag that has
   * nothing to do with its own events.
   */
  console.log("  draining any backlog left on the topic by earlier runs...");
  await enqueue(1);
  await drain();
  startWorkers(1);
  let quiet = 0;
  let seenBefore = -1;
  for (let i = 0; i < 60 && quiet < 5; i += 1) {
    await sleep(1000);
    const n = await prisma.notificationDelivery.count({
      where: { channel: DeliveryChannel.EMAIL },
    });
    quiet = n === seenBefore ? quiet + 1 : 0;
    seenBefore = n;
  }
  await stopWorkers();
  console.log("  drained.");

  /* ---- the runs ---- */
  const runs: Run[] = [];
  for (const c of CONSUMER_COUNTS) {
    console.log("");
    rule();
    console.log(`  ${c} consumer(s) in ${GROUP}`);
    const run = await measure(c);
    runs.push(run);
    console.log(
      `  settled ${run.settled}/${EVENTS} in ${ms(run.wallMs)}` +
        (run.timedOut ? "  — DID NOT FINISH" : "")
    );
  }

  /* ---- report ---- */
  console.log("");
  console.log("=".repeat(W));
  console.log("RESULT");
  console.log("=".repeat(W));
  console.log(
    `  ${"consumers".padEnd(11)}${"p50".padStart(9)}${"p95".padStart(9)}` +
      `${"p99".padStart(9)}${"events/sec".padStart(13)}${"assigned".padStart(11)}`
  );
  rule();
  for (const r of runs) {
    const rate = r.wallMs > 0 ? Math.round((r.settled / r.wallMs) * 1000) : 0;
    const assignedCol = r.members > 0 ? `${r.assigned}/${r.members}` : "?";
    console.log(
      `  ${String(r.consumers).padEnd(11)}` +
        `${ms(pct(r.lags, 50)).padStart(9)}` +
        `${ms(pct(r.lags, 95)).padStart(9)}` +
        `${ms(pct(r.lags, 99)).padStart(9)}` +
        `${String(rate).padStart(13)}` +
        `${assignedCol.padStart(11)}`
    );
  }
  rule();

  /* ---- the honest reading ---- */
  const best = runs.reduce((a, b) => {
    const ra = a.wallMs > 0 ? a.settled / a.wallMs : 0;
    const rb = b.wallMs > 0 ? b.settled / b.wallMs : 0;
    return rb > ra ? b : a;
  });
  const one = runs.find((r) => r.consumers === 1);

  if (one && one.wallMs > 0 && best.consumers !== 1) {
    const gain = (best.settled / best.wallMs) / (one.settled / one.wallMs);
    console.log(
      `  Best at ${best.consumers} consumers — ${gain.toFixed(1)}x the throughput of one.`
    );
  }

  const over = runs.filter((r) => r.consumers > partitions && r.members > 0);
  for (const r of over) {
    const idle = r.members - r.assigned;
    if (idle > 0) {
      console.log(
        `  At ${r.consumers} consumers the broker assigned partitions to ${r.assigned} of ` +
          `${r.members}.`
      );
      console.log(
        `  ${idle} did no work at all: ${partitions} partitions is the ceiling, and this is`
      );
      console.log(`  the broker's own answer rather than an inference from the curve.`);
    }
  }

  /**
   * The caveats, printed rather than left for the reader to discover.
   *
   * A throughput number without the shape of the machine under it is not a
   * measurement, it is a boast.
   */
  console.log("");
  console.log(`  Measured on ${require("os").cpus().length} CPUs. Consumers are separate`);
  console.log("  processes, so past roughly that many they contend for cores — the");
  console.log("  flattening in this table is partly hardware and partly partitions,");
  console.log("  and only the 'assigned' column separates the two.");
  console.log("");
  console.log("  The clock starts once every event is already on the broker, so");
  console.log("  these are consumer-side figures. The relay's publish rate is");
  console.log("  printed per run above, separately and on purpose.");
  console.log("=".repeat(W));

  await cleanup();
  await prisma.$disconnect();
  process.exit(runs.some((r) => r.timedOut) ? 1 : 0);
}

void main().catch(async (err) => {
  console.error(err);
  await stopWorkers();
  await cleanup();
  await prisma.$disconnect();
  process.exit(1);
});
