import crypto from "crypto";
import { prisma } from "./prisma";
import { Prisma } from "../generated/prisma/client";
import { IdempotencyStatus } from "../generated/prisma/enums";

/**
 * Idempotency keys for requests this API RECEIVES.
 *
 * Every call this server makes to a provider already carries a key (ADR 0013,
 * ADR 0029). This is the other direction: a client that lost a response and
 * retries gets the first answer back instead of a second execution or a
 * confusing 409. See docs/adr/0035-idempotency-keys-at-the-api-boundary.md
 *
 * CLAIM, THEN ACT — the delivery ledger's shape (ADR 0026), not a cache.
 * The INSERT that wins the unique (userId, key) pair is the request that runs.
 * Everything else is answered from the row. A read-then-write check here would
 * let two concurrent copies both see "no row" and both run.
 *
 * NOT THE CONCURRENCY CONTROL. The real double-execution guards —
 * claimOrderForPayment, the reservation row lock, return_requests' unique
 * orderItemId — stay exactly where they are. A claim can expire under a handler
 * that is still running and be taken over; those guards are what make the
 * second run harmless. This layer only makes sure the client hears the answer.
 */

/** How long a key is honoured. Covers any client's retry loop. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 3600_000;

/**
 * How long an IN_PROGRESS claim blocks a retry.
 *
 * Only reached when the process holding the claim died mid-request: a live
 * handler answers in well under a second, and its answer clears the claim.
 * Two minutes is long enough that a slow provider call is never taken over
 * underneath itself, and short enough that a client retrying after a crash is
 * not locked out of its own request for long.
 */
export const IDEMPOTENCY_LOCK_MS = 2 * 60_000;

/** Printable ASCII, no spaces, up to 255 — what a UUID or a ULID fits in. */
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** Objects with their keys sorted, recursively, so `{a,b}` and `{b,a}` hash alike. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((k) => [k, canonical(record[k])])
    );
  }
  return value;
}

/**
 * What a key is bound to: method, concrete path, and body.
 *
 * The path is the one with ids filled in (`/orders/abc/pay`), so a key used to
 * pay one order cannot be replayed as the answer for paying another.
 */
export function requestHash(method: string, path: string, body: unknown): string {
  return crypto
    .createHash("sha256")
    .update(`${method.toUpperCase()} ${path}\n${JSON.stringify(canonical(body ?? {}))}`)
    .digest("hex");
}

export type KeyRequest = {
  userId: string;
  key: string;
  method: string;
  path: string;
  hash: string;
};

/**
 * Proof of a claim. `lockedUntil` doubles as a fencing token: completing or
 * releasing only touches the row if it still carries the value this claim set,
 * so a request whose claim was taken over cannot overwrite its successor.
 */
export type ClaimedKey = { userId: string; key: string; lockedUntil: Date };

export type ClaimOutcome =
  | { kind: "claimed"; claim: ClaimedKey }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "mismatch" }
  | { kind: "in-progress"; retryAfterSeconds: number };

function lockFrom(now: Date): Date {
  return new Date(now.getTime() + IDEMPOTENCY_LOCK_MS);
}

function secondsUntil(then: Date, now: Date): number {
  return Math.max(1, Math.ceil((then.getTime() - now.getTime()) / 1000));
}

/**
 * Claims a key, or says why this request may not run.
 *
 * Two passes at most. The second exists for a row that disappears between the
 * INSERT losing and the SELECT reading — swept, released after a 5xx, or past
 * retention and deleted here — in which case the key is free again and the
 * INSERT gets one more try.
 */
export async function claimKey(req: KeyRequest, now: Date = new Date()): Promise<ClaimOutcome> {
  const { userId, key } = req;

  for (let pass = 0; pass < 2; pass++) {
    const lockedUntil = lockFrom(now);
    // ON CONFLICT ("userId", "key") DO NOTHING — the unique index decides.
    const { count } = await prisma.idempotencyKey.createMany({
      data: [
        {
          userId,
          key,
          method: req.method,
          path: req.path,
          requestHash: req.hash,
          lockedUntil,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) return { kind: "claimed", claim: { userId, key, lockedUntil } };

    const row = await prisma.idempotencyKey.findUnique({
      where: { userId_key: { userId, key } },
      select: {
        id: true,
        status: true,
        method: true,
        path: true,
        requestHash: true,
        responseStatus: true,
        responseBody: true,
        lockedUntil: true,
        createdAt: true,
      },
    });
    if (!row) continue;

    // Past retention but not swept yet: honour the documented window, not the
    // sweeper's timing. Conditional on createdAt so a fresh claim that replaced
    // it in the meantime is never the one deleted.
    if (row.createdAt.getTime() < now.getTime() - IDEMPOTENCY_RETENTION_MS) {
      await prisma.idempotencyKey.deleteMany({ where: { id: row.id, createdAt: row.createdAt } });
      continue;
    }

    if (row.method !== req.method || row.path !== req.path || row.requestHash !== req.hash) {
      return { kind: "mismatch" };
    }

    if (row.status === IdempotencyStatus.COMPLETED) {
      return { kind: "replay", status: row.responseStatus ?? 200, body: row.responseBody };
    }

    if (row.lockedUntil.getTime() > now.getTime()) {
      return { kind: "in-progress", retryAfterSeconds: secondsUntil(row.lockedUntil, now) };
    }

    // A stale claim: whoever held it died before answering. Compare-and-set on
    // the lock it left, so two retries arriving together take it over once.
    const takeover = lockFrom(now);
    const { count: taken } = await prisma.idempotencyKey.updateMany({
      where: { id: row.id, status: IdempotencyStatus.IN_PROGRESS, lockedUntil: row.lockedUntil },
      data: { lockedUntil: takeover },
    });
    if (taken === 1) return { kind: "claimed", claim: { userId, key, lockedUntil: takeover } };
    return { kind: "in-progress", retryAfterSeconds: secondsUntil(takeover, now) };
  }

  return { kind: "in-progress", retryAfterSeconds: 1 };
}

function toJson(body: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (body === undefined || body === null) return Prisma.JsonNull;
  // Through JSON once, so what is stored is exactly what the client was sent:
  // Dates as strings, undefined fields gone.
  return JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue;
}

/**
 * Stores the answer. False means the claim was taken over before this request
 * answered, and the successor's row was left alone.
 */
export async function completeKey(claim: ClaimedKey, status: number, body: unknown): Promise<boolean> {
  const { count } = await prisma.idempotencyKey.updateMany({
    where: {
      userId: claim.userId,
      key: claim.key,
      status: IdempotencyStatus.IN_PROGRESS,
      lockedUntil: claim.lockedUntil,
    },
    data: {
      status: IdempotencyStatus.COMPLETED,
      responseStatus: status,
      responseBody: toJson(body),
      completedAt: new Date(),
    },
  });
  return count === 1;
}

/** Gives the key back, for answers that must not be replayed (5xx, 429). */
export async function releaseKey(claim: ClaimedKey): Promise<void> {
  await prisma.idempotencyKey.deleteMany({
    where: {
      userId: claim.userId,
      key: claim.key,
      status: IdempotencyStatus.IN_PROGRESS,
      lockedUntil: claim.lockedUntil,
    },
  });
}

/** Deletes every key past retention, whatever its status. */
export async function pruneIdempotencyKeysOnce(now: Date = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_RETENTION_MS);
  const { count } = await prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return { deleted: count };
}

/**
 * Keeps `idempotency_keys` from growing without bound. Runs on every API
 * replica, and that is safe for the same reason as the other sweepers: a
 * DELETE of rows past a cutoff divides between replicas rather than repeating.
 */
export function startIdempotencySweeper(intervalMs = 3600_000) {
  async function tick() {
    try {
      const { deleted } = await pruneIdempotencyKeysOnce();
      if (deleted > 0) console.log(`Idempotency sweeper deleted ${deleted} expired key(s)`);
    } catch (err) {
      console.error("Idempotency sweeper failed", err);
    }
  }

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
