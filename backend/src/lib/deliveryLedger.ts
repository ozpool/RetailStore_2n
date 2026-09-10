import { prisma } from "./prisma";
import { isUniqueViolation } from "./pgErrors";
import { shouldSend } from "./channelPolicy";
import type { NotificationEvent } from "./outbox";
import { DeliveryChannel, DeliveryStatus } from "../generated/prisma/enums";

/**
 * The delivery ledger: what was sent, on which channel, and what came back.
 *
 * WHY THIS EXISTS AT ALL
 * Everything upstream delivers at least once on purpose. The relay publishes
 * and then marks publishedAt, so a crash between them republishes. A Kafka
 * consumer that sends and then dies before committing its offset reprocesses on
 * restart. A rebalance during a rolling deploy hands a partition back at the
 * last committed offset. None of those are failures — they are Tuesday.
 *
 * Without a record of what has already been sent, each one is a second email,
 * and later a second SMS.
 *
 * THE ORDER OF OPERATIONS IS THE WHOLE DESIGN
 *   1. resolve preferences; if off, write SUPPRESSED and stop
 *   2. INSERT PENDING — a unique violation means somebody else has it, return
 *   3. call the provider
 *   4. update to SENT with its message id, or FAILED with the reason
 *
 * Step 2 is the guard. It is the same discipline as claiming an order before
 * charging it (ADR 0013) and claiming refund headroom before refunding
 * (ADR 0016): mutual exclusion is decided by whether a write matched, and only
 * the winner may talk to the provider. There is no window between checking and
 * claiming, because the check IS the claim.
 *
 * Checking first and inserting after would reintroduce the read-then-write race
 * that ADR 0012 exists to prevent — two consumers both read "no row", both
 * decide to send, and both send.
 *
 * See docs/adr/0026-delivery-idempotency.md
 */

export type Claim =
  /** This process owns the delivery. Call the provider, then settle it. */
  | { claimed: true; id: string }
  /** Somebody else already has it, or it is not being sent at all. */
  | { claimed: false; reason: "duplicate" | "suppressed" | "error" };

/**
 * Resolves preferences and claims the delivery in one step.
 *
 * Returns `claimed: false` far more often than it returns true, and almost none
 * of those are errors: a suppressed channel and a redelivered message are both
 * ordinary. Callers must not log them as failures — doing so fills the log
 * during every rolling deploy and teaches people to ignore it.
 */
export type ClaimOptions = {
  /**
   * Allow taking over this delivery's own earlier FAILED attempt.
   *
   * Passed ONLY by the retry ladder. On the main topic a pre-existing row is
   * always somebody else's redelivery, and treating it as reclaimable is how a
   * rebalance turns into a second email.
   */
  reclaim?: boolean;
};

export async function claim(
  event: NotificationEvent,
  channel: DeliveryChannel,
  opts: ClaimOptions = {}
): Promise<Claim> {
  const decision = await shouldSend({
    userId: event.userId,
    type: event.type,
    channel,
  });

  if (!decision.send) {
    /**
     * Recorded, not dropped. "Why did I not get a text about my refund?" has to
     * have an answer, and reconstructing one from preferences that have since
     * been edited is not an answer.
     *
     * The same unique constraint applies, so a redelivered suppressed event
     * collides here too and is ignored.
     */
    try {
      await prisma.notificationDelivery.create({
        data: {
          eventId: event.eventId,
          channel,
          userId: event.userId,
          notificationId: event.payload.notificationId,
          status: DeliveryStatus.SUPPRESSED,
          suppressReason: decision.reason,
          completedAt: new Date(),
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) {
        console.error(`[delivery] could not record suppression`, err);
      }
    }
    return { claimed: false, reason: "suppressed" };
  }

  try {
    const row = await prisma.notificationDelivery.create({
      data: {
        eventId: event.eventId,
        channel,
        userId: event.userId,
        notificationId: event.payload.notificationId,
        status: DeliveryStatus.PENDING,
        attempts: 1,
      },
      select: { id: true },
    });
    return { claimed: true, id: row.id };
  } catch (err) {
    if (isUniqueViolation(err)) {
      /**
       * NOT an error. A redelivery found the row from the first attempt.
       *
       * On the retry ladder that row is this delivery's OWN previous attempt,
       * and stopping here would make the ladder a no-op — every rung would
       * collide with the failure the rung before it left behind. Only the retry
       * path passes `reclaim`, so the main path keeps exactly the strictness
       * ADR 0026 describes.
       */
      if (opts.reclaim) return reclaimFailed(event, channel);
      return { claimed: false, reason: "duplicate" };
    }
    console.error(`[delivery] could not claim ${event.eventId}/${channel}`, err);
    return { claimed: false, reason: "error" };
  }
}

/**
 * Takes over a delivery whose previous attempt failed, so the next rung of the
 * ladder can try it again.
 *
 * A CONDITIONAL UPDATE, NOT A READ THEN A WRITE. `status: FAILED` in the where
 * clause IS the claim: two workers racing the same retry message both issue
 * this statement, Postgres lets exactly one match, and the loser is told the
 * delivery is not his. Same discipline as claiming an order before charging it
 * (ADR 0013) and claiming refund headroom before refunding (ADR 0016), and the
 * same reason: a check followed by a write is the race ADR 0012 exists to
 * prevent.
 *
 * ONLY FAILED ROWS ARE ELIGIBLE. A SENT row is finished. A SUPPRESSED row was a
 * decision rather than a fault. A PENDING row is somebody's live attempt, and
 * taking that one over is precisely how one event becomes two messages.
 *
 * Permanent failures never reach here, because they are never republished onto
 * the ladder in the first place — see retryDecision() in lib/retry.ts. That is
 * deliberate: the permanence lives in the routing decision, not in a string
 * parsed back out of lastError.
 */
async function reclaimFailed(
  event: NotificationEvent,
  channel: DeliveryChannel
): Promise<Claim> {
  const taken = await prisma.notificationDelivery.updateMany({
    where: { eventId: event.eventId, channel, status: DeliveryStatus.FAILED },
    data: {
      status: DeliveryStatus.PENDING,
      attempts: { increment: 1 },
      lastError: null,
      completedAt: null,
    },
  });

  if (taken.count !== 1) {
    // Somebody else has it, or it is no longer in a state worth retrying.
    return { claimed: false, reason: "duplicate" };
  }

  const row = await prisma.notificationDelivery.findUnique({
    where: { eventId_channel: { eventId: event.eventId, channel } },
    select: { id: true },
  });

  return row ? { claimed: true, id: row.id } : { claimed: false, reason: "error" };
}

/**
 * Thrown by a channel that has nothing to send TO.
 *
 * Distinct from a failure and distinct from a preference. Push is the case that
 * needs it: a user with no subscribed device is not a broken provider and not
 * somebody who opted out — they simply never turned it on in any browser.
 * Recording that as FAILED would fill the ledger with red for the ordinary
 * state of almost every account.
 */
export class NothingToDeliverTo extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NothingToDeliverTo";
  }
}

/**
 * Thrown by a channel for a failure that retrying cannot fix.
 *
 * A rejected address, an account that no longer exists, an address nobody has
 * verified, a 410 Gone from a push endpoint. The ladder exists for a provider
 * having a bad minute; putting these on it delays nothing but the inevitable
 * and burns sender reputation doing it.
 *
 * DECIDED PER FAILURE, NOT PER EXCEPTION TYPE — ADR 0025. The same
 * `Error` from the same provider call is transient on a 503 and permanent on a
 * 550, so the channel that made the call is the only thing that can classify
 * it. Anything a channel does NOT wrap in this is treated as transient, which
 * is the safe default: a retry that was not needed costs one wasted send, a
 * missing retry costs the notification.
 */
/**
 * Thrown by a channel that COULD send this, but not yet.
 *
 * Quiet hours are the only user of it. Distinct from NothingToDeliverTo, which
 * is terminal, and from a transient failure, which rides a ladder measured in
 * minutes — this is a wait measured in hours, and it is not a failure at all.
 *
 * The row is parked with a notBefore and a sweeper picks it up. See
 * lib/deferredDeliveries.ts.
 */
export class DeferDelivery extends Error {
  readonly notBefore: Date;

  constructor(notBefore: Date, reason: string) {
    super(reason);
    this.name = "DeferDelivery";
    this.notBefore = notBefore;
  }
}

export class PermanentFailure extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PermanentFailure";
  }
}

/**
 * Parks the delivery until `notBefore`.
 *
 * attempts is NOT incremented. A deferral is not an attempt — nothing was sent
 * and nothing failed — and counting it would let a long enough quiet window
 * look like a delivery that had been retried into the ground.
 */
export async function markDeferred(id: string, notBefore: Date, reason: string) {
  await prisma.notificationDelivery.update({
    where: { id },
    data: {
      status: DeliveryStatus.DEFERRED,
      notBefore,
      suppressReason: reason,
      completedAt: null,
    },
  });
}

export async function markSuppressed(id: string, reason: string) {
  await prisma.notificationDelivery.update({
    where: { id },
    data: {
      status: DeliveryStatus.SUPPRESSED,
      suppressReason: reason,
      // Cleared, so a row that was deferred and then settled cannot be picked
      // up again by the sweeper.
      notBefore: null,
      completedAt: new Date(),
    },
  });
}

/** The provider accepted it. */
export async function markSent(id: string, providerMessageId?: string | null) {
  await prisma.notificationDelivery.update({
    where: { id },
    data: {
      status: DeliveryStatus.SENT,
      providerMessageId: providerMessageId ?? null,
      notBefore: null,
      completedAt: new Date(),
    },
  });
}

/**
 * The provider refused, or could not be reached.
 *
 * `permanent` separates a rejected address from a provider having a bad
 * minute. It is decided per failure, not per exception type — see ADR 0025.
 *
 * Both land as FAILED, because from the ledger's point of view they are the
 * same event: this attempt did not deliver. What differs is what happens next,
 * and that is the caller's decision rather than a status — a permanent failure
 * is never republished onto the ladder, so no rung ever reclaims the row. The
 * prefix on lastError is there for the human reading the admin panel, and
 * nothing branches on it.
 */
export async function markFailed(
  id: string,
  err: unknown,
  permanent = false
): Promise<void> {
  const message = String(err instanceof Error ? err.message : err).slice(0, 500);
  await prisma.notificationDelivery.update({
    where: { id },
    data: {
      status: DeliveryStatus.FAILED,
      lastError: permanent ? `permanent: ${message}` : message,
      notBefore: null,
      completedAt: new Date(),
    },
  });
}

/**
 * What happened, and — the part the ladder reads — whether trying again could
 * plausibly change it.
 *
 * `failed` and `retry` are both failures. They are separate outcomes because
 * only one of them should be put back on the wire, and collapsing them is how
 * a bounced address gets sent four more times.
 */
export type DeliveryOutcome =
  | "sent"
  | "duplicate"
  | "suppressed"
  /** Permanent. The provider will refuse this again for the same reason. */
  | "failed"
  /** Transient. Worth another rung of the ladder. */
  | "retry"
  /**
   * Parked until notBefore. NOT a failure and NOT for the ladder — the wait is
   * hours, and the ladder's longest rung is fifteen minutes. The sweeper owns
   * it from here.
   */
  | "deferred";

/**
 * Sends a delivery that was parked, once its notBefore has passed.
 *
 * THE CLAIM IS THE CONDITIONAL UPDATE, exactly as everywhere else in this file.
 * `status: DEFERRED` in the where clause is what makes two sweepers safe: both
 * issue this statement, Postgres lets one match, and the loser is told the row
 * is not his. A read-then-write here would send the 8am refund text twice.
 *
 * `notBefore` is re-checked in the same statement rather than trusted from the
 * caller's query, so a row that was re-deferred between the sweeper reading it
 * and claiming it is not sent early.
 */
export async function redeliverDeferred(
  id: string,
  send: () => Promise<{ providerMessageId?: string | null }>,
  now: Date = new Date()
): Promise<DeliveryOutcome> {
  const taken = await prisma.notificationDelivery.updateMany({
    where: { id, status: DeliveryStatus.DEFERRED, notBefore: { lte: now } },
    data: { status: DeliveryStatus.PENDING, attempts: { increment: 1 } },
  });

  if (taken.count !== 1) return "duplicate";

  try {
    const result = await send();
    await markSent(id, result.providerMessageId);
    return "sent";
  } catch (err) {
    if (err instanceof NothingToDeliverTo) {
      await markSuppressed(id, err.message);
      return "suppressed";
    }

    /**
     * Still inside a window — the operator widened it, or a same-day window
     * closed and reopened. Parked again rather than sent late or dropped.
     */
    if (err instanceof DeferDelivery) {
      await markDeferred(id, err.notBefore, err.message);
      return "deferred";
    }

    const permanent = err instanceof PermanentFailure;
    await markFailed(id, err, permanent);
    console.error(`[delivery] deferred send ${permanent ? "permanently " : ""}failed`, err);
    return permanent ? "failed" : "retry";
  }
}

/**
 * Runs a send under the ledger.
 *
 * Wraps the four steps so a channel consumer cannot get the order wrong — which
 * matters, because getting it wrong produces a bug that only appears under
 * redelivery and looks like the provider double-sending.
 *
 * NEVER THROWS. A channel that cannot deliver must not stop the others, and
 * under Kafka a throw here would prevent the offset commit and redeliver
 * forever — an infinite in-place retry that blocks the partition, which is the
 * exact failure the ladder exists to avoid. The outcome is on the row and in
 * the return value.
 */
export async function deliver(
  event: NotificationEvent,
  channel: DeliveryChannel,
  send: () => Promise<{ providerMessageId?: string | null }>,
  opts: ClaimOptions = {}
): Promise<DeliveryOutcome> {
  const c = await claim(event, channel, opts);

  if (!c.claimed) {
    return c.reason === "suppressed" ? "suppressed" : "duplicate";
  }

  try {
    const result = await send();
    await markSent(c.id, result.providerMessageId);
    return "sent";
  } catch (err) {
    // Not a failure: there was nobody on this channel to send to. Recorded so
    // the row still answers "why did nothing arrive?", and not logged as an
    // error because for push it is the ordinary state of most accounts.
    if (err instanceof NothingToDeliverTo) {
      await markSuppressed(c.id, err.message);
      return "suppressed";
    }

    /**
     * Parked, not dropped and not failed. The offset still commits — the
     * message's work is done as far as Kafka is concerned, and the ledger row
     * is now the record of what is still owed.
     */
    if (err instanceof DeferDelivery) {
      await markDeferred(c.id, err.notBefore, err.message);
      return "deferred";
    }

    /**
     * Unwrapped failures are transient by default. A channel has to say
     * "permanent" explicitly, because the cost of being wrong is asymmetric:
     * an unnecessary retry wastes one send, a missing retry loses the
     * notification outright.
     */
    const permanent = err instanceof PermanentFailure;
    await markFailed(c.id, err, permanent);
    console.error(
      `[delivery] ${channel} ${permanent ? "permanently " : ""}failed for ` +
        `${event.eventId}`,
      err
    );
    return permanent ? "failed" : "retry";
  }
}
