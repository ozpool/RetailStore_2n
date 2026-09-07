import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { TOPICS, kafka } from "../src/lib/kafka";
import {
  ERROR_HEADER,
  GROUP_HEADER,
  ORIGIN_HEADER,
  closeRetryProducer,
  republish,
  retryDestination,
} from "../src/lib/retry";
import { decodeEvent } from "../src/lib/outbox";

/**
 * The dead-letter queue: read it, and put messages back once the cause is fixed.
 *
 * AN OPERATOR TOOL, NOT A DEMO. Nothing here measures anything. It exists
 * because a DLQ nobody can drain is just a slower way of losing messages, and
 * the moment somebody needs it is the moment they are least willing to write a
 * one-off script against a broker.
 *
 * IT DOES NOTHING BY DEFAULT. Listing is safe and replaying is not, so the
 * default is a report and `--commit` is required to send anything. A tool whose
 * dangerous mode is the default gets used exactly once.
 *
 * WHY REPLAY GOES TO A RETRY RUNG AND NOT TO THE MAIN TOPIC
 * This is the part that is not obvious, and getting it wrong produces a replay
 * that appears to work and delivers nothing.
 *
 * Every message in the DLQ already has a ledger row, and that row is FAILED.
 * A message put back on the MAIN topic is claimed with `reclaim: false` — the
 * strict path — so it collides with that existing row, is read as an ordinary
 * redelivery, and is dropped. The logs would show the replay succeeding.
 *
 * A retry rung is consumed with `reclaim: true`, which is what allows a FAILED
 * row to be taken over and tried again. So that is where a replay belongs.
 * See deliveryLedger.claim().
 *
 * THE GROUP TAG IS PRESERVED. A DLQ entry belongs to whichever channel failed,
 * and replaying it untagged would hand it to every group — including the ones
 * that delivered it successfully the first time.
 *
 *   npx tsx scripts/dlq-replay.ts                    what is in there
 *   npx tsx scripts/dlq-replay.ts --limit 500        look further
 *   npx tsx scripts/dlq-replay.ts --commit           actually replay it
 *   npx tsx scripts/dlq-replay.ts --commit --group email-worker
 *
 * See docs/adr/0025-kafka-topics-and-partitioning.md
 */

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const LIMIT = Number(arg("limit", "100"));
const COMMIT = process.argv.includes("--commit");
const ONLY_GROUP = arg("group", "");
/**
 * A stable group id, so a second run does not re-read what the first replayed.
 * Offsets are committed only for messages this tool has finished with.
 */
const READER_GROUP = "dlq-replayer";

const W = 72;
const rule = (c = "-") => console.log(c.repeat(W));
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

function header(
  headers: Record<string, unknown> | undefined,
  name: string
): string | undefined {
  const raw = headers?.[name];
  const one = Array.isArray(raw) ? raw[0] : raw;
  if (one === undefined || one === null) return undefined;
  return Buffer.isBuffer(one) ? one.toString("utf8") : String(one);
}

type Entry = {
  topic: string;
  partition: number;
  offset: string;
  eventId: string;
  type: string;
  userId: string;
  group: string | undefined;
  origin: string | undefined;
  error: string | undefined;
  event: NonNullable<ReturnType<typeof decodeEvent>>;
};

async function main() {
  if (!process.env.KAFKA_BROKERS?.trim()) {
    console.error(
      "\n  KAFKA_BROKERS is not set, and the dead-letter queue lives on the broker.\n"
    );
    process.exit(2);
  }

  console.log("");
  console.log("=".repeat(W));
  console.log("DEAD-LETTER QUEUE");
  console.log("=".repeat(W));
  console.log(`  topic     ${TOPICS.dlq}`);
  console.log(`  reader    ${READER_GROUP}  (committed, so re-runs skip what was handled)`);
  console.log(`  limit     ${LIMIT}`);
  console.log(`  mode      ${COMMIT ? "COMMIT — messages WILL be replayed" : "report only"}`);
  if (ONLY_GROUP) console.log(`  filter    ${ONLY_GROUP}`);
  console.log("=".repeat(W));

  const consumer = kafka("retailstore-2n-dlq-replay").consumer({
    kafkaJS: {
      groupId: READER_GROUP,
      fromBeginning: true,
      autoCommit: false,
      allowAutoTopicCreation: false,
    },
  });

  const entries: Entry[] = [];
  const undecodable: Array<{ partition: number; offset: string }> = [];

  await consumer.connect();
  await consumer.subscribe({ topics: [TOPICS.dlq] });
  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      if (entries.length >= LIMIT) return;

      const event = decodeEvent(message.value);
      if (!event) {
        // Recorded rather than skipped silently: a message nobody can decode is
        // the one most likely to be the actual incident.
        undecodable.push({ partition, offset: String(message.offset) });
        return;
      }

      const group = header(message.headers as Record<string, unknown>, GROUP_HEADER);
      if (ONLY_GROUP && group !== ONLY_GROUP) return;

      entries.push({
        topic,
        partition,
        offset: String(message.offset),
        eventId: event.eventId,
        type: String(event.type),
        userId: event.userId,
        group,
        origin: header(message.headers as Record<string, unknown>, ORIGIN_HEADER),
        error: header(message.headers as Record<string, unknown>, ERROR_HEADER),
        event,
      });
    },
  });

  /**
   * There is no "end of topic" event, so this waits for the flow to stop
   * rather than for a count it cannot know in advance.
   */
  let seen = -1;
  let quiet = 0;
  for (let i = 0; i < 60 && quiet < 3; i += 1) {
    await sleep(1000);
    quiet = entries.length === seen ? quiet + 1 : 0;
    seen = entries.length;
    if (entries.length >= LIMIT) break;
  }

  if (entries.length === 0 && undecodable.length === 0) {
    console.log("");
    console.log("  Nothing in the dead-letter queue.");
    console.log("=".repeat(W));
    await consumer.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  }

  /* ---- what is in there ---- */
  const byError = new Map<string, number>();
  const byGroup = new Map<string, number>();
  for (const e of entries) {
    const key = (e.error ?? "no reason recorded").slice(0, 60);
    byError.set(key, (byError.get(key) ?? 0) + 1);
    byGroup.set(e.group ?? "untagged", (byGroup.get(e.group ?? "untagged") ?? 0) + 1);
  }

  console.log("");
  console.log(`  ${entries.length} message(s)${entries.length >= LIMIT ? " (limit reached — there may be more)" : ""}`);
  if (undecodable.length > 0) {
    console.log(`  ${undecodable.length} UNDECODABLE — left in place, they need a human`);
  }
  console.log("");
  console.log("  by channel");
  for (const [g, n] of [...byGroup].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(6)}  ${g}`);
  }
  console.log("");
  console.log("  by reason");
  for (const [reason, n] of [...byError].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${String(n).padStart(6)}  ${reason}`);
  }

  /* ---- how many are still worth replaying ---- */
  const eventIds = entries.map((e) => e.eventId);
  const ledger = await prisma.notificationDelivery.findMany({
    where: { eventId: { in: eventIds } },
    select: { eventId: true, channel: true, status: true },
  });
  const status = new Map(ledger.map((r) => [`${r.eventId}`, r.status]));

  const alreadySent = entries.filter((e) => status.get(e.eventId) === "SENT").length;
  const noRow = entries.filter((e) => !status.has(e.eventId)).length;

  console.log("");
  console.log("  against the ledger");
  console.log(`    ${String(entries.length - alreadySent - noRow).padStart(6)}  replayable (a FAILED row to take over)`);
  console.log(`    ${String(alreadySent).padStart(6)}  already SENT since — replaying would double-send`);
  console.log(`    ${String(noRow).padStart(6)}  no ledger row at all — pruned, or never claimed`);

  if (!COMMIT) {
    console.log("");
    rule();
    console.log("  Nothing was replayed. Add --commit to send these back to the");
    console.log(`  ${TOPICS.retry5s} rung, where a FAILED row can be`);
    console.log("  reclaimed. Fix the cause first: a replay into a broken provider");
    console.log("  lands straight back here, one rung later.");
    console.log("=".repeat(W));
    await consumer.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  }

  /* ---- replay ---- */
  let replayed = 0;
  let skipped = 0;

  for (const e of entries) {
    if (status.get(e.eventId) === "SENT") {
      skipped += 1;
      continue;
    }
    if (!e.group) {
      // Untagged: every group would pick it up, including ones that already
      // delivered it. Left in place for a human.
      skipped += 1;
      continue;
    }

    await republish({
      event: e.event,
      group: e.group,
      originTopic: TOPICS.dlq,
      // Back to the first rung. A replayed message therefore gets the rest of
      // the ladder again rather than one attempt and straight back here.
      destination: retryDestination(0),
      lastError: `replayed from dlq (was: ${e.error ?? "no reason"})`,
    });
    replayed += 1;
  }

  await closeRetryProducer();

  /**
   * Offsets are committed ONLY now, after every republish has been
   * acknowledged. A commit before the send would mean a crash here loses the
   * DLQ entry as well as the delivery — the same ordering the workers use, and
   * for the same reason.
   */
  const highest = new Map<number, number>();
  for (const e of entries) {
    const cur = highest.get(e.partition) ?? -1;
    highest.set(e.partition, Math.max(cur, Number(e.offset)));
  }
  await consumer.commitOffsets(
    [...highest].map(([partition, offset]) => ({
      topic: TOPICS.dlq,
      partition,
      offset: String(offset + 1),
    }))
  );

  console.log("");
  rule();
  console.log(`  replayed  ${replayed} → ${TOPICS.retry5s}`);
  console.log(`  skipped   ${skipped}  (already sent, or untagged)`);
  console.log("");
  console.log("  Offsets committed after the sends, so a crash mid-replay repeats");
  console.log("  rather than loses. Watch the ledger: a replay that fails again");
  console.log("  will be back in this queue in about sixteen minutes.");
  console.log("=".repeat(W));

  await consumer.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}

void main().catch(async (err) => {
  console.error(err);
  await closeRetryProducer();
  await prisma.$disconnect();
  process.exit(1);
});
