import "dotenv/config";
import { ensureTopics, isKafkaConfigured, TOPICS } from "./lib/kafka";
import { getTransport, assertNotifyConfigured } from "./lib/notifyTransport";
import { DEFAULT_POLL_MS, relayOnce } from "./lib/relay";
import { prisma } from "./lib/prisma";

/**
 * The outbox relay, as its own process.
 *
 * WHY NOT A setInterval INSIDE THE API, like the two sweepers
 * `startOrderSweeper` and `startReservationSweeper` are exactly that, and they
 * have the same shape. The difference is what they do: those recover state
 * nothing in the request path can reach, and are idle almost always. This is on
 * the critical path of every notification, and its throughput is the thing that
 * has to scale when volume grows.
 *
 * In the API, scaling publishing would mean scaling the API, and a relay bug
 * would take checkout down with it. Here it is a separate image target, scales
 * on its own, and becomes a Kubernetes Deployment without a rewrite.
 *
 * SEVERAL OF THESE ARE SAFE TO RUN. The claim query uses FOR UPDATE SKIP
 * LOCKED, so N relays divide the backlog rather than duplicating it.
 *
 * Under NOTIFY_TRANSPORT=inline the API runs the relay in-process instead and
 * this program is not used — there is no broker to publish to and nothing to
 * scale, so a second container for a function call would be ceremony.
 */

const POLL_MS = Number(process.env.RELAY_POLL_MS) || DEFAULT_POLL_MS;

async function main() {
  let summary: string;
  try {
    summary = assertNotifyConfigured();
  } catch (err) {
    console.error(`\nConfiguration error:\n  ${(err as Error).message}\n`);
    process.exit(1);
  }

  console.log(`RetailStore_2n relay starting — polling every ${POLL_MS}ms`);
  console.log(`Transport: ${summary}`);

  if (isKafkaConfigured()) {
    // Before the first publish, so a missing topic is a startup error rather
    // than a failed batch. Auto-creation is off on the producer for the same
    // reason: a typo should not quietly become a new empty topic.
    const created = await ensureTopics("retailstore-2n-relay-admin");
    console.log(
      created.length > 0
        ? `Topics:    created ${created.join(", ")}`
        : `Topics:    all present (${TOPICS.main} and the retry ladder)`
    );
  }

  let stopping = false;

  /**
   * Finishes the pass in flight before exiting.
   *
   * A relay killed mid-publish is safe — the rows stay unpublished and the next
   * relay picks them up — but it produces duplicates for whatever was already
   * on the wire. Draining on SIGTERM keeps a rolling deploy quiet, and the
   * hard-kill path stays correct for when it is not a deploy.
   */
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} — finishing the current pass, then stopping.`);
    try {
      await getTransport().close();
      await prisma.$disconnect();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // A plain loop rather than setInterval: a pass that outruns its interval must
  // delay the next one, not have a second started on top of it.
  for (;;) {
    if (stopping) return;

    const { published, failed } = await relayOnce();

    if (published > 0) console.log(`[relay] published ${published}`);
    if (failed > 0) console.error(`[relay] ${failed} failed, will retry`);

    // A pass that found work goes straight round again, so a backlog drains at
    // full speed rather than one batch per interval.
    if (published === 0) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
}

main().catch((err) => {
  console.error("[relay] fatal", err);
  process.exit(1);
});
