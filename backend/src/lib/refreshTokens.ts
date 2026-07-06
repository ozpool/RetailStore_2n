import { prisma } from "./prisma";
import { generateRefreshToken, hashToken, REFRESH_TOKEN_MAX_AGE_MS } from "./auth";

export async function issueRefreshToken(userId: string) {
  const token = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE_MS),
    },
  });
  return token;
}

export type RotateResult =
  /** Rotated. Set both cookies. */
  | { ok: true; userId: string; token: string }
  /**
   * Lost a concurrent race, within the grace window. Set ONLY the access
   * cookie — the request that won already issued the current refresh token and
   * set it on its own response.
   */
  | { ok: true; userId: string; token: null }
  | { ok: false; reason: "not_found" | "expired" | "reused" };

/**
 * How long after rotation the superseded token is still treated as a race
 * rather than a replay.
 *
 * Ten seconds. Long enough to cover several requests that expired together and
 * a slow network between them; short enough that a token found in a log, a
 * proxy, or somebody's history is long past it.
 */
const RACE_GRACE_MS = 10_000;

/**
 * Rotates a refresh token: the presented token is marked used and a new one
 * is issued in its place. If the presented token was already rotated once
 * before, that's a signal it was stolen and replayed after the legitimate
 * client moved on — every token for that user is revoked in response.
 *
 * ─────────────────────────────────────────────────────────────────────
 * EXCEPT WHEN IT IS A RACE, WHICH IS NOT THEFT
 *
 * Access tokens last fifteen minutes, so a page with several requests in
 * flight has all of them expire at the same instant. Each retries with the
 * same refresh cookie, because that is the only one the browser has. The first
 * rotates it; the rest present a token that was revoked milliseconds ago and,
 * without the window below, are read as a replay — which revokes the whole
 * family and signs the user out of every device they own.
 *
 * The BFF used to hide this with a per-process memo, which worked precisely
 * because there was one process. Behind two frontend instances the requests
 * land on different memos and the race returns, so the fix belongs here, where
 * the token state actually lives. It also covers callers that are not our BFF
 * at all — a mobile client hitting this API directly has the identical race,
 * and no memo anywhere would have helped it.
 *
 * WHY THIS GIVES AN ATTACKER NOTHING
 * The grace path is only reachable by presenting a token that was valid ten
 * seconds ago. Anyone holding that token could have used it normally in that
 * window anyway. The window does not extend an attacker's reach; it declines
 * to punish the legitimate client for the server's own rotation timing. Outside
 * it, a replay still revokes everything.
 *
 * It also refuses to graduate a dead chain: the replacement must still be live.
 * If the family was revoked — logout, password change, a real detected theft —
 * there is nothing to race with and this is a replay again.
 * ─────────────────────────────────────────────────────────────────────
 */
export async function rotateRefreshToken(rawToken: string): Promise<RotateResult> {
  const tokenHash = hashToken(rawToken);
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!record) {
    return { ok: false, reason: "not_found" };
  }

  if (record.revokedAt) {
    return decideOnSupersededToken(tokenHash, record.userId);
  }

  if (record.expiresAt.getTime() < Date.now()) {
    await prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });
    return { ok: false, reason: "expired" };
  }

  const newToken = generateRefreshToken();
  const newTokenHash = hashToken(newToken);

  /**
   * CLAIM THE TOKEN, THEN MINT ITS REPLACEMENT — the same discipline as the
   * payment claim (ADR 0013), refund headroom (ADR 0016) and the TOTP period.
   *
   * The check above is a READ. Ten concurrent requests all read `revokedAt`
   * as null before any of them writes, so all ten proceed to rotate — and the
   * suite measured exactly that: four of ten minted a token, leaving four live
   * refresh tokens for one session, each invalidating the others on next use.
   * The grace window hid the symptom (nobody was signed out) while the chain
   * quietly forked.
   *
   * `revokedAt IS NULL` in the WHERE makes the revocation the claim. Postgres
   * serialises the concurrent UPDATEs on the row lock, so the second one
   * re-evaluates the condition after the first commits and matches nothing.
   * Exactly one caller can see count === 1.
   *
   * In one transaction with the create, because a claim whose replacement was
   * never written leaves `replacedByTokenHash` pointing at nothing — and the
   * grace check requires the replacement to be live, so the next racing
   * request would be read as theft and sign the user out.
   */
  const claimed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date(), replacedByTokenHash: newTokenHash },
    });

    // Somebody else claimed it between our read and this update.
    if (count === 0) return false;

    await tx.refreshToken.create({
      data: {
        userId: record.userId,
        tokenHash: newTokenHash,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE_MS),
      },
    });
    return true;
  });

  if (!claimed) {
    // Lost the race. Whoever won has now set revokedAt and replacedByTokenHash,
    // so this is the same question as arriving at an already-rotated token.
    return decideOnSupersededToken(tokenHash, record.userId);
  }

  return { ok: true, userId: record.userId, token: newToken };
}

/**
 * A token that has already been superseded: race, or replay?
 *
 * Reached two ways — presenting a token that was rotated before this request
 * started, or losing the atomic claim above by milliseconds. Both ask the same
 * thing, so both come here.
 *
 * Re-reads rather than trusting the caller's copy of the row, because in the
 * lost-claim case the caller's copy is stale by definition: it was read before
 * the winner wrote.
 */
async function decideOnSupersededToken(
  tokenHash: string,
  userId: string
): Promise<RotateResult> {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: { revokedAt: true, replacedByTokenHash: true },
  });

  const supersededMsAgo = record?.revokedAt
    ? Date.now() - record.revokedAt.getTime()
    : Number.POSITIVE_INFINITY;

  /**
   * Two preconditions, and both matter.
   *
   * `replacedByTokenHash` is written only by rotation, so its presence already
   * separates "superseded by a concurrent refresh" from "revoked by a logout or
   * a password change" — those leave it null and must never be graced, because
   * there is no concurrent refresh to be racing with.
   *
   * The replacement still being live is the second half. Without it, a stolen
   * token would keep working for ten seconds after the victim changed their
   * password *specifically to stop it*.
   */
  if (supersededMsAgo <= RACE_GRACE_MS && record?.replacedByTokenHash) {
    const replacement = await prisma.refreshToken.findUnique({
      where: { tokenHash: record.replacedByTokenHash },
      select: { revokedAt: true, expiresAt: true },
    });

    if (
      replacement &&
      replacement.revokedAt === null &&
      replacement.expiresAt.getTime() > Date.now()
    ) {
      // A new ACCESS token, and deliberately no new refresh token. Issuing one
      // here would fork the chain: two live refresh tokens for one session,
      // each of which invalidates the other on next use.
      return { ok: true, userId, token: null };
    }
  }

  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { ok: false, reason: "reused" };
}

/**
 * Revokes every live refresh token for a user.
 *
 * Called whenever the password changes, by either route. A password change is
 * the standard response to "somebody else may be in my account", and it is
 * worthless if the intruder's session keeps working — they would simply keep
 * refreshing, and the owner would have locked out nobody.
 *
 * `except` keeps the caller's own session alive, so changing your password from
 * the settings page does not sign you out of the tab you are using. A reset
 * passes nothing, because there is no session to preserve and the whole point
 * is that every existing one dies.
 */
export async function revokeAllRefreshTokens(userId: string, except?: string) {
  const { count } = await prisma.refreshToken.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(except ? { tokenHash: { not: hashToken(except) } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return count;
}

export async function revokeRefreshToken(rawToken: string) {
  const tokenHash = hashToken(rawToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
