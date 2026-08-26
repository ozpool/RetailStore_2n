import { generateSync } from "otplib";

/**
 * TOTP helpers for tests.
 *
 * Shared because codes are SINGLE-USE, and every suite that signs in to the
 * admin panel has to cope with that. Left to each suite, the waiting gets
 * reinvented — and a suite that forgets fails with "That didn't work" on a code
 * that is provably correct, which is a miserable hour to debug.
 */

const PERIOD_MS = 30_000;

/** The code an authenticator app would be showing right now. */
export function currentCode(secret: string) {
  return generateSync({ secret });
}

/**
 * Waits until the current 30-second period has rolled over.
 *
 * Needed between any two code entries. Inside one period an authenticator app
 * shows the SAME six digits, so generating again is not a new code — it is the
 * spent one, and the server is right to refuse it.
 *
 * Sleeps only to the next boundary plus a margin, so the typical wait is well
 * under thirty seconds rather than a flat thirty.
 */
export async function nextPeriod() {
  const msIntoPeriod = Date.now() % PERIOD_MS;
  await new Promise((r) => setTimeout(r, PERIOD_MS - msIntoPeriod + 1200));
}

/**
 * A fresh, unspent code — waiting first if the current period was already used.
 *
 * The common shape in a suite: enrol with one code, then sign in with another.
 */
export async function freshCode(secret: string) {
  await nextPeriod();
  return currentCode(secret);
}
