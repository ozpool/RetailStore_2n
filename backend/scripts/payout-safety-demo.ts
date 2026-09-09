import "dotenv/config";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { prisma } from "../src/lib/prisma";
import {
  claimPayout,
  earningsSummary,
  payableItems,
  runPayout,
  sendPendingPayouts,
} from "../src/lib/payouts";
import {
  PAYOUT_PROVIDER,
  isStubPayouts,
  stubTransferCount,
  __resetStubPayouts,
} from "../src/lib/payoutProvider";
import {
  FulfilmentStatus,
  OrderStatus,
  PayoutStatus,
} from "../src/generated/prisma/enums";

/**
 * Kills the process between the claim and the transfer, and counts what that
 * cost.
 *
 * WHAT IS BEING CLAIMED
 * ADR 0029 says a payout claims its lines before a cent moves, and ADR 0030
 * says `payout_items.orderItemId` is unique. Three numbers follow from that,
 * and all three are meant to hold at once:
 *
 *   money paid twice        $0.00   the unique constraint refuses the second claim
 *   money lost to a crash   $0.00   the claim survives and the sweeper finishes it
 *   money in limbo          $0.00   after the sweeper runs, nothing is left PENDING
 *
 * Those are three halves of one trade, and the trade is the same one the
 * delivery ledger makes (ADR 0026). The claim is committed BEFORE the provider
 * is called, so a process that dies in between leaves a payout that was
 * reserved and never sent — money OWED rather than money LOST. That is only
 * survivable because something comes back for it, and this script is what
 * shows all three numbers holding rather than one being traded for another.
 *
 * WHY SIGKILL AND NOT A SIMULATED FAILURE
 * A thrown error is handled: the claim rolls back or the caller retries, and
 * nothing interesting happens. SIGKILL is the case the design is actually
 * defending against — an OOM kill, a container evicted mid-request, a pulled
 * plug — and it is the one where a claim written a moment too late pays the
 * same $50 to the same seller twice.
 *
 * The kill is real. A child process claims the payout and then SIGKILLs
 * ITSELF, so the row is committed by a process that no longer exists and has
 * no chance to clean up, roll back, or finish the transfer.
 *
 * HOW A DOUBLE PAYMENT WOULD BE DETECTED
 * Not by trusting the constraint that is supposed to prevent it. The count is
 * `payout_items rows - distinct(orderItemId)` over this run's rows, plus the
 * transferred total against the owed total. If the unique index were dropped
 * tomorrow this script would report the duplicates it allows, rather than
 * reporting zero because the index made the query impossible to fail.
 *
 *   npx tsx scripts/payout-safety-demo.ts
 *   npx tsx scripts/payout-safety-demo.ts --lines 12 --racers 8
 *
 * See docs/adr/0029-payouts-separate-transfers-not-destination-charges.md
 * and  docs/adr/0030-payout-eligibility-and-hold.md
 */

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const LINES = Number(arg("lines", "6"));
const RACERS = Number(arg("racers", "8"));
const CENTS_PER_LINE = 5_000;
const TAG = `rs2.payoutsafety.${Date.now()}`;
const DAY = 24 * 3600_000;

const W = 72;
const rule = (c = "-") => console.log(c.repeat(W));
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

let sellerUserId = "";
let sellerId = "";
let buyerId = "";
let orderId = "";

/* ------------------------------------------------------------------ *
 * Child mode: claim, then die with the claim committed.
 * ------------------------------------------------------------------ */

/**
 * Runs in a SEPARATE process, invoked by the parent below.
 *
 * The SIGKILL is sent to its own pid, after `claimPayout` has returned and
 * therefore after its transaction has committed. Nothing between the commit
 * and the death is under this process's control, which is the point: no
 * finally block, no rollback, no retry.
 */
async function childClaimThenDie(targetSellerId: string): Promise<never> {
  const claim = await claimPayout(targetSellerId);
  if (!claim.claimed) {
    console.error(`child: nothing claimed (${claim.reason})`);
    process.exit(3);
  }
  // Printed on stdout so the parent can report what was reserved by a process
  // that is about to stop existing.
  console.log(JSON.stringify({ payoutId: claim.payoutId, amountCents: claim.amountCents }));
  await prisma.$disconnect();
  process.kill(process.pid, "SIGKILL");
  // Unreachable. SIGKILL cannot be caught, blocked or ignored.
  throw new Error("survived SIGKILL");
}

type ChildResult = { payoutId: string; amountCents: number; signal: string | null };

function spawnClaimThenDie(targetSellerId: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      // tsx, because this script is TypeScript and there is no build step in
      // the loop a reader would run this from.
      ["--import", "tsx", __filename, "--child-claim", targetSellerId],
      { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] }
    );

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("exit", (code, signal) => {
      const line = out.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        return reject(new Error(`child produced no claim (code=${code} signal=${signal}) ${err}`));
      }
      try {
        const parsed = JSON.parse(line) as { payoutId: string; amountCents: number };
        resolve({ ...parsed, signal });
      } catch {
        reject(new Error(`child output was not a claim: ${line}`));
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Fixture
 * ------------------------------------------------------------------ */

async function seed(): Promise<void> {
  const seller = await prisma.user.create({
    data: {
      email: `${TAG}.seller@retailstore-2n.test`,
      name: "Safety Seller",
      passwordHash: "not-a-real-hash",
      emailVerified: true,
      isSeller: true,
    },
    select: { id: true },
  });
  sellerUserId = seller.id;

  const buyer = await prisma.user.create({
    data: {
      email: `${TAG}.buyer@retailstore-2n.test`,
      name: "Safety Buyer",
      passwordHash: "not-a-real-hash",
      emailVerified: true,
    },
    select: { id: true },
  });
  buyerId = buyer.id;

  const profile = await prisma.sellerProfile.create({
    data: {
      userId: sellerUserId,
      shopName: "Safety Shop",
      // Both gates open. This script is about the claim, not the gates — those
      // have their own assertions in tests/api/payouts.ts.
      payoutsEnabled: true,
      payoutsReady: true,
      connectAccountId: `acct_stub_${randomUUID().slice(0, 12)}`,
      connectOnboardedAt: new Date(),
    },
    select: { id: true },
  });
  sellerId = profile.id;

  const order = await prisma.order.create({
    data: {
      reference: TAG,
      buyerId,
      status: OrderStatus.PAID,
      subtotalCents: LINES * CENTS_PER_LINE,
      paidAt: new Date(Date.now() - 60 * DAY),
    },
    select: { id: true },
  });
  orderId = order.id;

  await prisma.orderItem.createMany({
    data: Array.from({ length: LINES }, (_, i) => ({
      orderId,
      sellerId,
      title: `Mended plate ${i + 1}`,
      unitPriceCents: CENTS_PER_LINE,
      quantity: 1,
      sellerName: "Safety Shop",
      fulfilment: FulfilmentStatus.DELIVERED,
      // Long past any sane hold, so every line is payable and the numbers
      // below are not a function of PAYOUT_HOLD_DAYS.
      deliveredAt: new Date(Date.now() - 60 * DAY),
    })),
  });
}

async function cleanup(): Promise<void> {
  if (sellerId) {
    await prisma.payoutItem.deleteMany({ where: { payout: { sellerId } } });
    await prisma.payoutDebt.deleteMany({ where: { sellerId } });
    await prisma.payout.deleteMany({ where: { sellerId } });
  }
  if (orderId) {
    await prisma.orderItem.deleteMany({ where: { orderId } });
    await prisma.order.deleteMany({ where: { id: orderId } });
  }
  for (const id of [sellerUserId, buyerId].filter(Boolean)) {
    await prisma.user.deleteMany({ where: { id } });
  }
}

/**
 * Duplicate payments, counted WITHOUT relying on the constraint.
 *
 * `payout_items` rows minus distinct `orderItemId`s. Zero because the index
 * refuses the second insert — but computed as a difference, so if the index
 * were removed this would report a number rather than staying zero by
 * construction.
 */
async function duplicateStats() {
  const rows = await prisma.payoutItem.findMany({
    where: { payout: { sellerId } },
    select: { orderItemId: true, amountCents: true },
  });
  const distinct = new Set(rows.map((r) => r.orderItemId));
  const perItem = new Map<string, number>();
  for (const r of rows) perItem.set(r.orderItemId, (perItem.get(r.orderItemId) ?? 0) + 1);
  const duplicatedCents = rows
    .filter((r) => (perItem.get(r.orderItemId) ?? 0) > 1)
    .reduce((sum, r) => sum + r.amountCents, 0);

  return { rows: rows.length, distinct: distinct.size, duplicatedCents };
}

/** What actually left the platform, from the payout rows rather than the stub. */
async function transferredCents(): Promise<number> {
  const paid = await prisma.payout.aggregate({
    where: { sellerId, status: PayoutStatus.PAID },
    _sum: { amountCents: true },
  });
  return paid._sum.amountCents ?? 0;
}

/* ------------------------------------------------------------------ *
 * The demo
 * ------------------------------------------------------------------ */

async function main() {
  /**
   * REFUSED against a real provider, and not merely warned about. Every step
   * below moves money on purpose, twice concurrently, from a process it then
   * kills. Under `stripe_connect` that is somebody's actual bank account.
   */
  if (!isStubPayouts()) {
    console.error(
      `\n  PAYOUT_PROVIDER is "${PAYOUT_PROVIDER}". This script transfers money\n` +
        "  concurrently and kills the process mid-payout. It will not run against\n" +
        "  a real provider:\n\n    PAYOUT_PROVIDER=stub npx tsx scripts/payout-safety-demo.ts\n"
    );
    process.exit(2);
  }
  if (!process.env.DATABASE_URL?.trim()) {
    console.error("\n  DATABASE_URL is not set. There is nothing to claim against.\n");
    process.exit(2);
  }

  const owed = LINES * CENTS_PER_LINE;

  console.log("");
  console.log("=".repeat(W));
  console.log("A PROCESS KILLED BETWEEN THE CLAIM AND THE TRANSFER");
  console.log("=".repeat(W));
  console.log(`  lines         ${LINES} delivered items at ${usd(CENTS_PER_LINE)} each`);
  console.log(`  owed          ${usd(owed)}`);
  console.log(`  racers        ${RACERS} concurrent payout attempts`);
  console.log(`  claim         payout_items insert BEFORE the provider is called`);
  console.log(`  guard         payout_items.orderItemId is UNIQUE`);
  console.log("=".repeat(W));

  await seed();

  const before = await earningsSummary(sellerId);
  console.log(`  payable now   ${usd(before.payableCents)}  (${(await payableItems(sellerId)).length} lines)`);

  /* ---- 1. the crash ---- */
  rule();
  console.log("1. A child process claims the payout, then SIGKILLs itself");
  const child = await spawnClaimThenDie(sellerId);
  console.log(`   claimed       ${usd(child.amountCents)} as payout ${child.payoutId.slice(0, 8)}`);
  console.log(`   child exit    ${child.signal ?? "clean"}${child.signal === "SIGKILL" ? "  (uncatchable, as intended)" : "  <-- NOT a real kill"}`);

  const stranded = await prisma.payout.findUniqueOrThrow({
    where: { id: child.payoutId },
    select: { status: true, providerTransferId: true, _count: { select: { items: true } } },
  });
  console.log(`   payout row    ${stranded.status}, ${stranded._count.items} items, transfer id ${stranded.providerTransferId ?? "none"}`);
  console.log(`   transferred   ${usd(await transferredCents())}   <-- money is OWED, not sent`);

  /* ---- 2. the money is not payable twice ---- */
  rule();
  console.log("2. While that payout sits there, is the money payable again?");
  const second = await runPayout(sellerId);
  console.log(`   second run    ${second.sent ? `SENT ${usd(second.amountCents ?? 0)}  <-- DOUBLE PAID` : `refused: ${second.reason}`}`);
  console.log(`   payable now   ${usd((await earningsSummary(sellerId)).payableCents)}  (claimed lines are spoken for)`);

  /* ---- 3. the sweeper finishes it ---- */
  rule();
  console.log("3. Something comes back for the stranded claim");
  const swept = await sendPendingPayouts();
  console.log(`   considered    ${swept.considered}`);
  console.log(`   sent          ${swept.sent}`);
  console.log(`   failed        ${swept.failed}`);
  console.log(`   transferred   ${usd(await transferredCents())}`);
  console.log(`   still PENDING ${await prisma.payout.count({ where: { sellerId, status: PayoutStatus.PENDING } })}`);

  /* ---- 4. and it will not send it again ---- */
  rule();
  console.log("4. The sweeper runs again, as a cron with no memory would");
  const sweptAgain = await sendPendingPayouts();
  console.log(`   considered    ${sweptAgain.considered}  (nothing is PENDING, so nothing is re-sent)`);
  console.log(`   transferred   ${usd(await transferredCents())}`);

  /* ---- 5. the concurrent case, for completeness ---- */
  rule();
  console.log(`5. ${RACERS} payout attempts at once, on a fresh payable line`);
  const extra = await prisma.orderItem.create({
    data: {
      orderId,
      sellerId,
      title: "A late arrival",
      unitPriceCents: CENTS_PER_LINE,
      quantity: 1,
      sellerName: "Safety Shop",
      fulfilment: FulfilmentStatus.DELIVERED,
      deliveredAt: new Date(Date.now() - 60 * DAY),
    },
    select: { id: true },
  });

  const outcomes = await Promise.all(
    Array.from({ length: RACERS }, () => runPayout(sellerId))
  );
  const won = outcomes.filter((o) => o.sent).length;
  const lost = outcomes.filter((o) => !o.sent);
  const reasons = [...new Set(lost.map((o) => o.reason))].join(", ");
  console.log(`   sent          ${won}`);
  console.log(`   refused       ${lost.length}  (${reasons})`);
  console.log(`   times paid    ${
    (await prisma.payoutItem.count({ where: { orderItemId: extra.id } }))
  }  for the one new line`);

  /* ---- the report ---- */
  const dup = await duplicateStats();
  const sent = await transferredCents();
  const total = owed + CENTS_PER_LINE;

  console.log("");
  console.log("=".repeat(W));
  console.log("WHAT IT COST");
  console.log("=".repeat(W));
  console.log(`  owed                    ${usd(total)}`);
  console.log(`  transferred             ${usd(sent)}`);
  console.log(`  paid twice              ${usd(dup.duplicatedCents)}`);
  console.log(`  lost to the crash       ${usd(total - sent)}`);
  console.log(`  left in limbo           ${await prisma.payout.count({ where: { sellerId, status: PayoutStatus.PENDING } })} payouts`);
  console.log("");
  console.log(`  payout_items rows       ${dup.rows}`);
  console.log(`  distinct order items    ${dup.distinct}   (equal, so nothing is in two payouts)`);
  console.log(`  stub transfers issued   ${stubTransferCount()}   in this process`);
  console.log("=".repeat(W));

  const ok =
    dup.duplicatedCents === 0 &&
    dup.rows === dup.distinct &&
    sent === total &&
    child.signal === "SIGKILL";

  console.log(
    ok
      ? "  PASS  nothing paid twice, nothing lost, nothing left owed."
      : "  FAIL  see the numbers above."
  );
  console.log("=".repeat(W));
  console.log("");

  await cleanup();
  __resetStubPayouts();
  await prisma.$disconnect();
  process.exit(ok ? 0 : 1);
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

const childArg = process.argv.indexOf("--child-claim");
if (childArg !== -1) {
  const target = process.argv[childArg + 1];
  if (!target) {
    console.error("--child-claim needs a sellerId");
    process.exit(2);
  }
  void childClaimThenDie(target);
} else {
  main().catch(async (err) => {
    console.error(err);
    // A crashed demo must not leave its own fixture behind, or the next run
    // starts from a state nobody chose.
    await cleanup().catch(() => {});
    await prisma.$disconnect();
    process.exit(1);
  });
}
