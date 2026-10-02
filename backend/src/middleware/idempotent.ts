import type { NextFunction, Request, Response } from "express";
import {
  claimKey,
  completeKey,
  isValidKey,
  releaseKey,
  requestHash,
  type ClaimedKey,
} from "../lib/idempotency";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const REPLAYED_HEADER = "Idempotent-Replayed";

/**
 * Honours an `Idempotency-Key` header on the route it is mounted on.
 *
 * Mount it AFTER requireAuth: keys are scoped to the user, and without a user
 * there is nothing to scope by, so the request simply runs as if no key had
 * been sent. Without the header, likewise — the key is optional, and every
 * client that never sends one sees no change at all.
 *
 * Deliberately not an async function. Express 4 ignores the promise a
 * middleware returns, so a rejection would vanish; the async work is started
 * here and every failure inside it is answered explicitly.
 * See docs/adr/0035-idempotency-keys-at-the-api-boundary.md
 */
export function idempotent(req: Request, res: Response, next: NextFunction): void {
  const key = req.get(IDEMPOTENCY_HEADER);
  if (key === undefined || !req.userId) {
    next();
    return;
  }
  if (!isValidKey(key)) {
    res.status(400).json({
      error: "Idempotency-Key must be 1-255 printable characters with no spaces.",
      code: "INVALID_IDEMPOTENCY_KEY",
    });
    return;
  }
  void begin(req, res, next, key, req.userId);
}

async function begin(req: Request, res: Response, next: NextFunction, key: string, userId: string) {
  const path = req.baseUrl + req.path;
  const hash = requestHash(req.method, path, req.body);

  let outcome;
  try {
    outcome = await claimKey({ userId, key, method: req.method, path, hash });
  } catch (err) {
    /**
     * Fail closed. Running the handler without the claim is exactly what the
     * client asked us not to risk, and a 5xx is never stored, so retrying with
     * the same key is safe the moment the database is back.
     */
    console.error(`Idempotency claim failed for ${req.method} ${path}`, err);
    res.status(503).json({
      error: "Could not process that request right now. Retry with the same key.",
      code: "IDEMPOTENCY_UNAVAILABLE",
    });
    return;
  }

  switch (outcome.kind) {
    case "replay":
      res.set(REPLAYED_HEADER, "true");
      if (outcome.body === null) {
        res.status(outcome.status).end();
      } else {
        res.status(outcome.status).json(outcome.body);
      }
      return;
    case "mismatch":
      res.status(422).json({
        error: "That Idempotency-Key was already used for a different request.",
        code: "IDEMPOTENCY_KEY_REUSED",
      });
      return;
    case "in-progress":
      res.set("Retry-After", String(outcome.retryAfterSeconds));
      res.status(409).json({
        error: "A request with that Idempotency-Key is still being processed.",
        code: "IDEMPOTENCY_IN_PROGRESS",
        retryAfterSeconds: outcome.retryAfterSeconds,
      });
      return;
    case "claimed":
      recordBeforeSending(res, outcome.claim, `${req.method} ${path}`);
      next();
      return;
  }
}

/**
 * Stores the handler's answer, THEN sends it.
 *
 * In that order on purpose: once a client has seen a response, a retry must
 * find COMPLETED, never IN_PROGRESS. Sending first and recording after would
 * open a window where a fast retry is told "still processing" about a request
 * that has already been answered.
 *
 * Both `json` and `end` are wrapped because a handler may answer either way
 * (`res.status(204).end()`), and `json` reaches `end` internally — `settled`
 * keeps that from recording twice. The answer is recorded even if the client
 * has already gone, which is the case this whole mechanism exists for.
 */
function recordBeforeSending(res: Response, claim: ClaimedKey, label: string) {
  let settled = false;
  const json = res.json.bind(res);
  const end = res.end.bind(res) as (...args: unknown[]) => Response;

  res.json = (body?: unknown) => {
    if (settled) return json(body);
    settled = true;
    void settle(claim, res.statusCode, body, label).then(() => json(body));
    return res;
  };

  res.end = ((...args: unknown[]) => {
    if (settled) return end(...args);
    settled = true;
    void settle(claim, res.statusCode, null, label).then(() => end(...args));
    return res;
  }) as Response["end"];
}

/**
 * Every answer below 500 is the answer, 429 excepted. A 5xx is the server
 * failing rather than answering and a 429 says "not now"; storing either would
 * make a passing condition permanent for that key, so both give it back.
 *
 * Never throws: bookkeeping must not fail a request that has already done its
 * work. If the write fails the claim simply expires, and the guards behind
 * this layer make a re-run safe.
 */
async function settle(claim: ClaimedKey, status: number, body: unknown, label: string) {
  try {
    if (status >= 500 || status === 429) {
      await releaseKey(claim);
      return;
    }
    const stored = await completeKey(claim, status, body);
    if (!stored) {
      console.warn(`Idempotency claim for ${label} was taken over before it answered; answer not stored.`);
    }
  } catch (err) {
    console.error(`Could not record the idempotent answer for ${label}; the claim will expire.`, err);
  }
}
