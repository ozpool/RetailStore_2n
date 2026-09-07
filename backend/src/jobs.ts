import "dotenv/config";
import { prisma } from "./lib/prisma";
import { sendPendingPayouts } from "./lib/payouts";
import { pruneOutboxOnce } from "./lib/outboxRetention";
import { sweepDeferredOnce } from "./lib/deferredDeliveries";
import { sweepStalePendingOnce } from "./lib/stalePending";
import { releaseExpiredHolds } from "./lib/reservations";
import { reconcileProcessingOrders } from "./lib/orders";

/**
 * One-shot jobs, for a scheduler that is not this process.
 *
 * WHY THIS EXISTS, given the API already runs five sweepers on a timer.
 * Those five are in-process on purpose and stay there (ADR 0032): they recover
 * state no request path can reach, and N replicas divide their work by
 * conditional UPDATE rather than repeating it. Moving them to CronJobs would
 * serialise work that currently parallelises.
 *
 * What has no invoker at all is `sendPendingPayouts`. The payout claim commits
 * before the transfer (ADR 0029), so a process that dies in between leaves
 * money reserved and unsent, and unlike the delivery ledger's ambiguous middle
 * nothing comes back for it. That one call is the reason this file exists, and
 * it is a Job rather than a sixth sweeper because it moves money to a third
 * party: a Job has an exit code, a start time and a record, where a loop inside
 * the API has application logs.
 *
 * THE OTHERS ARE REGISTERED ANYWAY, and not as an invitation to schedule them.
 * They are here because an operator holding a shell sometimes needs to run one
 * by hand — after an incident, or to answer "would this even do anything right
 * now" — and the alternative is a `npx tsx -e` one-liner reaching into library
 * internals, which is how a production database gets a typo. Registering them
 * in one list also means the list cannot silently disagree with `src/index.ts`.
 *
 *   node dist/jobs.js payouts:pending
 *   node dist/jobs.js --list
 *
 * Exit codes are the interface: 0 did something or had nothing to do, 1 the job
 * threw, 2 the invocation was wrong. A CronJob that cannot fail is a CronJob
 * whose failure nobody sees.
 */

type Job = {
  run: () => Promise<string>;
  scheduled: boolean;
  what: string;
};

const JOBS: Record<string, Job> = {
  /**
   * THE ONE THAT IS ACTUALLY SCHEDULED.
   *
   * Safe beside a seller pressing the button: `sendClaimedPayout` refuses
   * anything that is not still PENDING, and the transfer carries the payout id
   * as its idempotency key, so a duplicate attempt is the provider's no-op
   * rather than a second transfer.
   */
  "payouts:pending": {
    scheduled: true,
    what: "send payouts that were claimed and never transferred",
    run: async () => {
      const r = await sendPendingPayouts();
      // `raced` is deliberately in the line: a nonzero `failed` should alarm
      // somebody and a nonzero `raced` should not.
      return `considered=${r.considered} sent=${r.sent} raced=${r.raced} failed=${r.failed}`;
    },
  },

  /* ---- the rest: for a human with a shell, not for a schedule ---- */

  "outbox:prune": {
    scheduled: false,
    what: "delete published outbox rows past the retention window",
    run: async () => {
      const r = await pruneOutboxOnce();
      return `deleted=${r.deleted} oldestKept=${r.oldestKept?.toISOString() ?? "none"}`;
    },
  },
  "deliveries:deferred": {
    scheduled: false,
    what: "send messages quiet hours parked",
    run: async () => {
      const r = await sweepDeferredOnce();
      return `sent=${r.sent} expired=${r.expired} skipped=${r.skipped}`;
    },
  },
  "deliveries:stale": {
    scheduled: false,
    what: "reopen deliveries claimed but never settled",
    run: async () => {
      const r = await sweepStalePendingOnce();
      // needsReview is the one worth a human's attention: every such row is an SMS.
      return `resent=${r.resent} failed=${r.failed} needsReview=${r.needsReview}`;
    },
  },
  "reservations:expire": {
    scheduled: false,
    what: "return expired holds to stock",
    run: async () => `released=${await releaseExpiredHolds()}`,
  },
  "orders:reconcile": {
    scheduled: false,
    what: "settle in-flight payments against the provider",
    run: async () => `settled=${await reconcileProcessingOrders()}`,
  },
};

function usage(): void {
  const width = Math.max(...Object.keys(JOBS).map((k) => k.length));
  console.log("\nUsage: node dist/jobs.js <job>\n");
  for (const [name, job] of Object.entries(JOBS)) {
    const mark = job.scheduled ? "cron" : "    ";
    console.log(`  ${mark}  ${name.padEnd(width)}  ${job.what}`);
  }
  console.log(
    "\n  'cron' marks the one a CronJob runs. The others also run on every API\n" +
      "  replica already (src/index.ts) and are listed for running by hand.\n"
  );
}

async function main(): Promise<number> {
  const name = process.argv[2];

  if (!name || name === "--list" || name === "-h" || name === "--help") {
    usage();
    // Asking for the list is a successful request; running nothing by mistake
    // is not.
    return name ? 0 : 2;
  }

  const job = JOBS[name];
  if (!job) {
    console.error(`\nUnknown job: ${name}`);
    usage();
    return 2;
  }

  const started = Date.now();
  try {
    const summary = await job.run();
    // One line, because `kubectl logs` on a completed Job is the whole
    // interface for "did it do anything".
    console.log(`${name}: ${summary} (${Date.now() - started}ms)`);
    return 0;
  } catch (err) {
    console.error(`${name}: FAILED after ${Date.now() - started}ms`);
    console.error(err);
    return 1;
  }
}

void main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
