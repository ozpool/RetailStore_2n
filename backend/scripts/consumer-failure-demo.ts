import "dotenv/config";
import { randomUUID } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { prisma } from "../src/lib/prisma";
import { drain } from "../src/lib/relay";
import { notifyMany } from "../src/lib/notifications";
import { ensureTopics } from "../src/lib/kafka";
import { DeliveryChannel, NotificationType } from "../src/generated/prisma/enums";

/**
 * Kills a consumer mid-batch and counts what that cost.
 *
 * WHAT IS BEING CLAIMED
 * ADR 0026 says the pipeline is at-least-once with an idempotent ledger, and
 * that the two numbers which follow from that are both zero:
 *
 *   duplicate deliveries   0   the unique constraint refuses the second claim
 *   lost events            0   the offset was never committed, so it redelivers
 *
 * Those are the two halves of one trade. The worker commits its offset AFTER
 * the handler returns, so a consumer that dies between sending and committing
 * redelivers — a DUPLICATE rather than a LOSS. That is only survivable because
 * the ledger deduplicates, and this script is what shows both sides holding at
 * once rather than one being traded for the other.
 *
 * WHY SIGKILL AND NOT SIGTERM
 * SIGTERM is handled: the worker disconnects, leaves its group, and commits
 * what it finished. Nothing interesting happens. SIGKILL is the case the design
 * is actually defending against — a segfault, an OOM kill, a yanked cable — and
 * it is the one where an offset committed a moment too early loses somebody's
 * notification silently.
 *
 * HOW A DUPLICATE WOULD BE DETECTED
 * Not by trusting the constraint that is supposed to prevent it. The count is
 * `deliveries - distinct(eventId, channel)` over this run's rows: if the
 * constraint were dropped tomorrow this script would report the duplicates it
 * allows, rather than reporting zero because a unique index made the query
 * impossible to fail.
 *
 *   npx tsx scripts/consumer-failure-demo.ts
 *   npx tsx scripts/consumer-failure-demo.ts --events 4000 --consumers 4
 *
 * See docs/adr/0026-delivery-idempotency.md
 */

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const EVENTS = Number(arg("events", "3000"));
const CONSUMERS = Number(arg("consumers", "4"));
const USERS = Number(arg("users", "200"));
const GROUP = "email-worker";
const TAG = `rs2.kill.${Date.now()}`;

const W = 72;
const rule = (c = "-") => console.log(c.repeat(W));
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

let userIds: string[] = [];
const running: ChildProcess[] = [];

function startWorkers(count: number): ChildProcess[] {
  const entry = path.join(process.cwd(), "dist", "worker.js");
  const started: ChildProcess[] = [];
  for (let i = 0; i < count; i += 1) {
    const child = spawn(process.execPath, [entry, GROUP], {
      env: { ...process.env, NOTIFY_TRANSPORT: "kafka", MAIL_TRANSPORT: "console" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", () => {});
    running.push(child);
    started.push(child);
  }
  return started;
}

async function stopAll(): Promise<void> {
  for (const c of running) if (c.exitCode === null) c.kill("SIGTERM");
  await sleep(6000);
  for (const c of running) if (c.exitCode === null) c.kill("SIGKILL");
  running.length = 0;
}

async function seedUsers(): Promise<void> {
  const rows = Array.from({ length: USERS }, (_, i) => ({
    email: `${TAG}.${i}@retailstore-2n.test`,
    name: `Kill ${i}`,
    passwordHash: "not-a-real-hash",
    emailVerified: true,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    await prisma.user.createMany({ data: rows.slice(i, i + 200) });
  }
  userIds = (
    await prisma.user.findMany({
      where: { email: { startsWith: TAG } },
      select: { id: true },
    })
  ).map((u) => u.id);
}

async function enqueue(n: number): Promise<void> {
  const BATCH = 250;
  for (let w = 0; w < n; w += BATCH) {
    const size = Math.min(BATCH, n - w);
    await notifyMany(
      Array.from({ length: size }, (_, k) => ({
        userId: userIds[(w + k) % userIds.length],
        type: NotificationType.ORDER_SHIPPED,
        title: "Your order shipped",
        body: `Kill probe ${w + k}`,
        link: null,
        aggregateType: "Order",
        aggregateId: randomUUID(),
      }))
    );
  }
}

/** Events this run enqueued, by eventId, so nothing else is counted. */
async function runEventIds(): Promise<string[]> {
  const rows = await prisma.outboxEvent.findMany({
    where: { userId: { in: userIds } },
    select: { eventId: true },
  });
  return rows.map((r) => r.eventId);
}

async function settledCount(): Promise<number> {
  return prisma.notificationDelivery.count({
    where: {
      userId: { in: userIds },
      channel: DeliveryChannel.EMAIL,
      completedAt: { not: null },
    },
  });
}

async function cleanup() {
  if (userIds.length === 0) return;
  await prisma.notificationDelivery.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.outboxEvent.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  if (!process.env.KAFKA_BROKERS?.trim()) {
    console.error(
      "\n  KAFKA_BROKERS is not set. A consumer cannot be killed mid-batch if\n" +
        "  there is no broker feeding it:\n\n" +
        "    docker compose --profile messaging up -d kafka\n"
    );
    process.exit(2);
  }
  if ((process.env.NOTIFY_TRANSPORT ?? "inline").toLowerCase() !== "kafka") {
    console.error(
      `\n  NOTIFY_TRANSPORT is "${process.env.NOTIFY_TRANSPORT ?? "inline"}". On the\n` +
        "  inline transport the relay delivers in THIS process, so there is no\n" +
        "  consumer to kill:\n\n    NOTIFY_TRANSPORT=kafka ...\n"
    );
    process.exit(2);
  }
  const entry = path.join(process.cwd(), "dist", "worker.js");
  if (!fs.existsSync(entry)) {
    console.error(`\n  ${entry} does not exist. Run: npm run build\n`);
    process.exit(2);
  }

  await ensureTopics("retailstore-2n-kill-admin");

  console.log("");
  console.log("=".repeat(W));
  console.log("A CONSUMER KILLED MID-BATCH");
  console.log("=".repeat(W));
  console.log(`  events      ${EVENTS}`);
  console.log(`  consumers   ${CONSUMERS}  (one of them will be SIGKILLed)`);
  console.log(`  group       ${GROUP}`);
  console.log(`  claim       ledger insert BEFORE the provider is called`);
  console.log(`  commit      offset AFTER the handler returns`);
  console.log("=".repeat(W));

  await seedUsers();
  await enqueue(EVENTS);
  const ids = await runEventIds();
  console.log(`  ${ids.length} events enqueued for ${userIds.length} recipients`);

  const published = await drain();
  console.log(`  ${published} published to the broker`);

  const workers = startWorkers(CONSUMERS);
  console.log(`  ${CONSUMERS} consumers started`);

  /**
   * Wait until the group is genuinely mid-flight before killing anything.
   *
   * Killing at zero progress tests the rebalance and nothing else; the
   * interesting moment is when a consumer is holding partitions and has
   * in-flight work whose offsets are not yet committed.
   */
  const killAt = Math.floor(EVENTS * 0.25);
  const deadline = Date.now() + 120_000;
  let progress = 0;
  while (progress < killAt && Date.now() < deadline) {
    await sleep(250);
    progress = await settledCount();
  }

  const victim = workers[0];
  victim.kill("SIGKILL");
  console.log("");
  console.log(`  SIGKILL sent at ${progress}/${EVENTS} settled — no cleanup, no offset commit`);
  console.log(`  ${CONSUMERS - 1} consumers remain; the group must rebalance and finish the rest.`);

  /**
   * The survivors have to re-read whatever the dead consumer had claimed but
   * not committed. That takes a rebalance, which is not instant — so "finished"
   * is defined as no further progress for a while, not as a fixed wait.
   */
  let settled = progress;
  let lastMoved = Date.now();
  const finishBy = Date.now() + 300_000;
  while (settled < EVENTS && Date.now() < finishBy) {
    await sleep(1000);
    const now = await settledCount();
    if (now > settled) {
      settled = now;
      lastMoved = Date.now();
    } else if (Date.now() - lastMoved > 45_000) {
      break;
    }
  }

  await stopAll();

  /* ---- the two numbers ---- */
  const rows = await prisma.notificationDelivery.findMany({
    where: { userId: { in: userIds }, channel: DeliveryChannel.EMAIL },
    select: { eventId: true, status: true, attempts: true },
  });

  const seen = new Set<string>();
  let duplicates = 0;
  for (const r of rows) {
    if (seen.has(r.eventId)) duplicates += 1;
    else seen.add(r.eventId);
  }

  /**
   * A ROW IS NOT A DELIVERY, AND CONFLATING THEM WOULD HIDE THE ONE FAILURE
   * THIS SCRIPT IS MOST LIKELY TO FIND.
   *
   * The ledger claims BEFORE the provider is called, so a consumer killed
   * between the claim and the settle leaves a PENDING row. On redelivery that
   * row collides with the strict claim, is read as an ordinary duplicate, and
   * nothing is ever sent — the notification is lost behind a row that looks
   * like proof it was handled.
   *
   * ADR 0026 calls this the ambiguous middle and specifies a per-channel
   * sweeper for it. That sweeper does not exist yet, so a stale PENDING here
   * is a permanent loss and is counted as one.
   */
  const settledRows = rows.filter((r) => r.status !== "PENDING");
  const stuck = rows.filter((r) => r.status === "PENDING");
  const delivered = new Set(settledRows.map((r) => r.eventId));
  const missing = ids.filter((id) => !delivered.has(id));
  const lost = missing;
  const reclaimed = rows.filter((r) => r.attempts > 1).length;

  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);

  console.log("");
  console.log("=".repeat(W));
  console.log("RESULT");
  console.log("=".repeat(W));
  const row = (label: string, value: string) =>
    console.log(`  ${label.padEnd(34)}${value.padStart(14)}`);
  row("events enqueued", String(ids.length));
  row("delivery rows written", String(rows.length));
  for (const [st, n] of [...byStatus].sort((a, b) => b[1] - a[1])) {
    row(`  ${st.toLowerCase()}`, String(n));
  }
  row("distinct events SETTLED", String(delivered.size));
  rule();
  row("duplicate deliveries", String(duplicates));
  row("lost events", String(lost.length));
  row("  of which stuck PENDING", String(stuck.length));
  rule();
  row("rows claimed more than once", String(reclaimed));
  rule();

  if (duplicates === 0 && lost.length === 0) {
    console.log(`  HOLDS. A consumer was killed with ${EVENTS - progress} events still`);
    console.log(`  outstanding, and the group finished all ${ids.length} exactly once.`);
    console.log("");
    console.log("  The offset commit ordering is what prevented the loss, and the");
    console.log("  ledger's unique constraint is what prevented the duplicate. Neither");
    console.log("  alone is sufficient: commit-first loses, and no-constraint doubles.");
  } else {
    if (lost.length > 0) {
      console.log(`  LOST ${lost.length} EVENT(S). An offset was committed for work that`);
      console.log(`  never completed. First few: ${lost.slice(0, 3).join(", ")}`);
    }
    if (duplicates > 0) {
      console.log(`  ${duplicates} DUPLICATE DELIVERY(S). The idempotency guard did not hold.`);
    }
    if (stuck.length > 0) {
      console.log("");
      console.log(`  ${stuck.length} of those are rows stuck at PENDING: claimed, then the`);
      console.log("  consumer died before settling them. A redelivery collides with the");
      console.log("  row and sends nothing, so they are lost until the per-channel");
      console.log("  sweeper in ADR 0026 exists. It does not exist yet.");
    }
  }

  if (lost.length === 0 && stuck.length === 0) {
    console.log("");
    console.log("  NOT PROVEN BY THIS RUN: the ambiguous middle. Nothing was killed");
    console.log("  in the window between claiming a delivery and settling it, so no");
    console.log("  row was left PENDING. That window is real and narrow, and the");
    console.log("  sweeper ADR 0026 specifies for it is still unbuilt — so this");
    console.log("  result says the common case is safe, not that every case is.");
  }
  console.log("=".repeat(W));

  await cleanup();
  await prisma.$disconnect();
  process.exit(duplicates === 0 && lost.length === 0 && stuck.length === 0 ? 0 : 1);
}

void main().catch(async (err) => {
  console.error(err);
  await stopAll();
  await cleanup();
  await prisma.$disconnect();
  process.exit(1);
});
