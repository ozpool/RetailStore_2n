import crypto from "crypto";
import { prisma } from "./prisma";
import { hashPassword, hashToken, verifyPassword } from "./auth";
import { isPasswordBreached } from "./passwordBreach";
import { sendPasswordResetEmail } from "./mailer";
import { revokeAllRefreshTokens } from "./refreshTokens";

/**
 * Changing a password, and recovering one you have lost.
 *
 * TWO ROUTES INTO THE SAME PLACE, WITH DIFFERENT PROOFS
 * A change proves you know the current password. A reset proves you control the
 * inbox. Both end with the account having a new password and every other
 * session dead, because both are the standard response to "somebody else may be
 * in my account" — and locking the intruder out is the entire point. A password
 * change that leaves their session refreshing has locked out nobody.
 *
 * WHAT A RESET DELIBERATELY DOES NOT DO
 * It does not clear an admin's TOTP enrolment. Mail access must not be enough to
 * strip a second factor — that would make the second factor decorative, since
 * the inbox is exactly where a reset link lands. Somebody who takes over an
 * admin's email gets the password and still cannot open the panel.
 */

/** One hour. A reset link is a live credential, not a formality. */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";

export class PasswordError extends Error {
  code: string;
  status: number;
  field?: string;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "PasswordError";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

/**
 * The rules a new password has to pass, wherever it comes from.
 *
 * Shared so the two routes cannot drift. A reset endpoint that skipped the
 * breach check would be a way to set a password signup would have refused —
 * and the person doing it would be someone who just proved they had lost
 * control of the account once already.
 */
async function assertUsablePassword(password: string, currentHash?: string) {
  if (password.length < 12) {
    throw new PasswordError(
      "INVALID_INPUT",
      "Password must be at least 12 characters.",
      400,
      "newPassword"
    );
  }

  if (currentHash && (await verifyPassword(password, currentHash))) {
    throw new PasswordError(
      "SAME_PASSWORD",
      "That's already your password. Choose a different one.",
      400,
      "newPassword"
    );
  }

  if (await isPasswordBreached(password)) {
    throw new PasswordError(
      "PASSWORD_BREACHED",
      "This password has appeared in a known data breach. Please choose a different one.",
      400,
      "newPassword"
    );
  }
}

/* ------------------------------------------------------------------ *
 * Change, while signed in
 * ------------------------------------------------------------------ */

/**
 * Changes the password of somebody who already knows it.
 *
 * The current password is required even though the caller is authenticated, for
 * the same reason admin TOTP enrolment asks for it: a stolen session must not be
 * enough to take the account permanently. Without this check, anyone who got
 * hold of a live cookie could set their own password and lock the owner out for
 * good.
 *
 * Returns the caller's replacement refresh token — every OTHER session is
 * revoked, but signing you out of the tab you are using would be a hostile way
 * to respond to good security hygiene.
 */
export async function changePassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
  /** The caller's current refresh token, so their own session survives. */
  keepRefreshToken?: string;
}) {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, passwordHash: true },
  });
  if (!user) throw new PasswordError("NOT_FOUND", "Account not found.", 404);

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw new PasswordError(
      "WRONG_PASSWORD",
      "That isn't your current password.",
      401,
      "currentPassword"
    );
  }

  await assertUsablePassword(input.newPassword, user.passwordHash);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(input.newPassword) },
  });

  const revoked = await revokeAllRefreshTokens(user.id, input.keepRefreshToken);

  /**
   * Outstanding reset links die too.
   *
   * Somebody who changes their password because they suspect a compromise
   * should not leave a working reset link in an inbox the attacker may be
   * reading. Marked used rather than deleted, so the row still records that a
   * link was issued.
   */
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  return { otherSessionsEnded: revoked };
}

/* ------------------------------------------------------------------ *
 * Reset, when you cannot sign in
 * ------------------------------------------------------------------ */

/**
 * Issues a reset link, if that address has an account.
 *
 * ALWAYS SUCCEEDS FROM THE CALLER'S POINT OF VIEW
 * The route returns the same 200 whether or not the address is registered.
 * Anything else turns this into an account-enumeration oracle: an attacker
 * feeds it a list of emails and learns which ones have accounts here, which is
 * worth having before a credential-stuffing run. Same reasoning as
 * /auth/resend-verification.
 *
 * Suspended accounts still get a link. Being suspended is not a reason to be
 * denied control of your own credentials, and login stays blocked regardless.
 */
export async function requestPasswordReset(email: string) {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });

  // No account. Deliberately silent — see above.
  if (!user) return;

  /**
   * Any previous unused link is invalidated first.
   *
   * Otherwise asking twice leaves two working links, and the older one is the
   * one more likely to have leaked — a forwarded email, a shared screen, a
   * mail scanner that follows URLs.
   */
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const token = crypto.randomBytes(32).toString("hex");
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      // Only the hash. A database leak must not hand over working links.
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  await sendPasswordResetEmail(user.email, `${FRONTEND_ORIGIN}/reset-password?token=${token}`);
}

/**
 * Redeems a reset link.
 *
 * Every failure — unknown, expired, already used — gives one message. Telling
 * somebody a token is "expired" rather than "invalid" confirms it was real,
 * which is a small gift to anyone testing tokens they should not have.
 */
export async function resetPassword(input: { token: string; newPassword: string }) {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(input.token) },
    select: {
      id: true,
      userId: true,
      usedAt: true,
      expiresAt: true,
      user: { select: { passwordHash: true, emailVerified: true } },
    },
  });

  const unusable =
    !record || record.usedAt !== null || record.expiresAt.getTime() < Date.now();
  if (unusable) {
    throw new PasswordError(
      "INVALID_TOKEN",
      "That link has expired or has already been used. Ask for a new one.",
      400
    );
  }

  await assertUsablePassword(input.newPassword, record.user.passwordHash);

  await prisma.$transaction([
    // Burned in the same transaction as the password change, so a crash cannot
    // leave a spent link usable.
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: record.userId },
      data: {
        passwordHash: await hashPassword(input.newPassword),
        /**
         * Redeeming the link proves they control the inbox, which is exactly
         * what email verification asks. Someone who signed up, never confirmed,
         * and later reset would otherwise be left unable to log in for a reason
         * they have already satisfied.
         */
        emailVerified: true,
      },
    }),
  ]);

  // Every session, with no exception: there is no caller session to preserve,
  // and if the account was taken over then the intruder's is among them.
  const revoked = await revokeAllRefreshTokens(record.userId);
  return { userId: record.userId, sessionsEnded: revoked };
}
