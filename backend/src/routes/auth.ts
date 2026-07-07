import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import {
  clearAuthCookies,
  getRefreshTokenCookie,
  hashPassword,
  setAuthCookies,
  signAccessToken,
  verifyPassword,
} from "../lib/auth";
import {
  consumeEmailVerificationToken,
  issueAndSendVerificationEmail,
} from "../lib/emailVerification";
import { isPasswordBreached } from "../lib/passwordBreach";
import { issueRefreshToken, revokeRefreshToken, rotateRefreshToken } from "../lib/refreshTokens";
import { requireAuth } from "../middleware/requireAuth";
import { checkRateLimit, clearRateLimit } from "../lib/rateLimit";
import {
  PasswordError,
  changePassword,
  requestPasswordReset,
  resetPassword,
} from "../lib/passwordReset";

export const authRouter = Router();

const signupSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(12, "Password must be at least 12 characters"),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

const tokenSchema = z.object({
  token: z.string().min(1, "Missing token"),
});

const emailSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
});

function publicUser(user: {
  id: string;
  name: string;
  email: string;
  isSeller: boolean;
  emailVerified: boolean;
  avatarUrl: string | null;
  createdAt: Date;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    isSeller: user.isSeller,
    emailVerified: user.emailVerified,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
  };
}

async function issueSession(res: import("express").Response, userId: string) {
  // signAccessToken is synchronous — it signs in-process. Only the refresh
  // token touches the database. This used to wrap both in Promise.all, which
  // read as two round trips in parallel and was actually one await and one
  // pointless wrap.
  const accessToken = signAccessToken({ userId });
  const refreshToken = await issueRefreshToken(userId);
  setAuthCookies(res, { accessToken, refreshToken });
}

authRouter.post("/signup", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: issue?.message ?? "Invalid input", field: issue?.path[0] });
    return;
  }
  const { name, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing?.emailVerified) {
    res.status(409).json({ error: "An account with that email already exists", field: "email" });
    return;
  }

  if (await isPasswordBreached(password)) {
    res.status(400).json({
      error: "This password has appeared in a known data breach. Please choose a different one.",
      field: "password",
    });
    return;
  }

  const passwordHash = await hashPassword(password);

  // EMAIL VERIFICATION IS SWITCHED OFF. The account is marked verified and
  // signed in straight away instead of waiting for an emailed link. To turn it
  // back on, restore the commented-out block below, delete the live code after
  // it, and restore the matching blocks in the login route and in
  // frontend/src/app/signup/page.tsx.
  //
  // // An unverified account already exists for this email — treat this as a
  // // fresh signup rather than a dead-end 409, so a lost/expired email isn't
  // // a trap. Update the name/password too, in case they were retrying with
  // // a different password than the first attempt.
  // const user = existing
  //   ? await prisma.user.update({ where: { id: existing.id }, data: { name, passwordHash } })
  //   : await prisma.user.create({ data: { name, email, passwordHash } });
  //
  // await issueAndSendVerificationEmail(user.id, user.email);
  // res.status(201).json({
  //   message: "Check your email to verify your account before logging in.",
  //   email: user.email,
  // });
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { name, passwordHash, emailVerified: true },
      })
    : await prisma.user.create({ data: { name, email, passwordHash, emailVerified: true } });
  await issueSession(res, user.id);
  res.status(201).json({ user: publicUser(user) });
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: issue?.message ?? "Invalid input", field: issue?.path[0] });
    return;
  }
  const { email, password } = parsed.data;

  /**
   * RATE LIMITED PER ADDRESS.
   *
   * Without it, password guessing against one account is unbounded. Every other
   * credential control here — bcrypt at cost 12, breached-password rejection,
   * refresh rotation — raises the *cost* of an attack. Only a limit caps the
   * number of attempts, and SECURITY.md named this as the gap.
   *
   * Ten per fifteen minutes: high enough that ordinary mistyping never reaches
   * it, low enough that sustained guessing is pointless.
   *
   * CLEARED ON SUCCESS, so somebody who mistypes twice and then gets it right
   * does not carry those attempts for the rest of the window.
   *
   * THE TRADE-OFF, STATED
   * Keying on the submitted address means somebody who knows a victim's email
   * can spend the victim's allowance and keep them out for up to fifteen
   * minutes. That is real. It is also a recoverable nuisance, traded against an
   * otherwise unbounded attack on every account on the platform.
   *
   * NO PER-IP LIMIT HERE, unlike /password/forgot — see the note below.
   *
   * Fails OPEN when Redis is unreachable, unlike `admin-stepup`. Nobody being
   * able to sign in is worse than an unthrottled login for the length of an
   * outage, and the one surface that genuinely cannot tolerate that has its own
   * limit which fails closed.
   */
  const perAddress = await checkRateLimit(`login:${email}`, 10, 15 * 60 * 1000);

  if (!perAddress.allowed) {
    /**
     * Identical whether or not the address exists.
     *
     * The counter is keyed on what was submitted rather than on a user row, so
     * an address with no account is throttled exactly like one with an account
     * — a 429 therefore says nothing about which. Same reasoning as the 401
     * below sharing one message for a wrong address and a wrong password.
     */
    res.status(429).json({
      error: "Too many sign-in attempts. Wait a few minutes and try again.",
      code: "RATE_LIMITED",
      retryAfterSeconds: perAddress.retryAfterSeconds,
    });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  const valid = user ? await verifyPassword(password, user.passwordHash) : false;

  if (!user || !valid) {
    /**
     * One message for both a wrong address and a wrong password, and a `code`
     * that says nothing more than the message does.
     *
     * Distinguishing them turns login into an account-enumeration oracle: feed
     * it a list of addresses and learn which have accounts here, which is worth
     * having before a credential-stuffing run. The 429 above is deliberately
     * shaped the same way.
     *
     * The code was documented in docs/api.md before it was actually sent —
     * every other failure path here carries one, and api.md's own convention is
     * that `code` is stable while `error` text is not.
     */
    res.status(401).json({
      error: "Incorrect email or password",
      code: "INVALID_CREDENTIALS",
    });
    return;
  }

  /**
   * Cleared here — as soon as the password is proven — not after the checks
   * below.
   *
   * The limit exists to cap password guessing, and that question is now
   * settled. A suspended or unverified account is a different refusal made by
   * somebody who demonstrably knows their own password, and holding their spent
   * attempts against them would throttle the person who fixes the problem and
   * comes back.
   */
  await clearRateLimit(`login:${email}`);

  /**
   * WHY THERE IS NO PER-IP LIMIT ON LOGIN
   *
   * /password/forgot has one, and the asymmetry is deliberate. That endpoint
   * sends mail, so volume from a single caller is inherently suspicious and
   * naturally low. Login is neither.
   *
   * A per-IP login limit fails in both directions at once. Set low enough to
   * matter, it punishes shared addresses — an office, a university, a mobile
   * carrier's NAT — where hundreds of unrelated people sign in from one IP, and
   * the failure looks to them like the site being broken. Set high enough not
   * to, it stops nothing: credential stuffing does not guess one password many
   * times from one address, it tries one leaked password against thousands of
   * accounts from rotating proxies, and the per-address counter above never
   * sees more than a single attempt from any of them.
   *
   * The version worth having counts only FAILED attempts, so legitimate
   * traffic behind a NAT never accumulates. That needs the limiter to answer
   * "how many so far?" without incrementing, which `checkRateLimit` cannot do
   * — it counts on the way in, by design, because that is what makes it atomic.
   * Recorded here as the shape of the fix rather than approximated badly.
   */

  /**
   * Suspension is checked after the password, deliberately.
   *
   * Checking first would turn login into an oracle for which accounts are
   * suspended, without anyone needing to know the password. The reason is
   * included because a vague refusal is indistinguishable from a bug, and
   * generates support instead of preventing it.
   */
  if (user.suspendedAt) {
    res.status(403).json({
      error: user.suspendedReason
        ? `This account is suspended. ${user.suspendedReason}`
        : "This account is suspended.",
      code: "ACCOUNT_SUSPENDED",
    });
    return;
  }

  // EMAIL VERIFICATION IS SWITCHED OFF (see the signup route), so an
  // unverified account is allowed to log in.
  //
  // if (!user.emailVerified) {
  //   res.status(403).json({
  //     error: "Please verify your email before logging in.",
  //     code: "EMAIL_NOT_VERIFIED",
  //   });
  //   return;
  // }

  await issueSession(res, user.id);
  res.json({ user: publicUser(user) });
});

authRouter.post("/verify-email", async (req, res) => {
  const parsed = tokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing token" });
    return;
  }

  const userId = await consumeEmailVerificationToken(parsed.data.token);
  if (!userId) {
    res.status(400).json({ error: "This verification link is invalid or has expired." });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(400).json({ error: "This verification link is invalid or has expired." });
    return;
  }

  await issueSession(res, user.id);
  res.json({ user: publicUser(user) });
});

authRouter.post("/resend-verification", async (req, res) => {
  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid email" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (user && !user.emailVerified) {
    await issueAndSendVerificationEmail(user.id, user.email);
  }

  // Same response whether or not the account exists or is already
  // verified — otherwise this endpoint would let anyone probe which emails
  // are registered.
  res.json({ message: "If that email needs verification, we've sent a new link." });
});

authRouter.post("/refresh", async (req, res) => {
  const refreshToken = getRefreshTokenCookie(req);
  if (!refreshToken) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const result = await rotateRefreshToken(refreshToken);
  if (!result.ok) {
    clearAuthCookies(res);
    res.status(401).json({ error: "Session expired, please log in again" });
    return;
  }

  const accessToken = signAccessToken({ userId: result.userId });

  /**
   * `token` is null when this request lost a concurrent refresh race.
   *
   * Passing it straight through matters: setAuthCookies then writes only the
   * access cookie, leaving the refresh cookie the winning request already set.
   * Overwriting it with anything else — including a fresh rotation — would
   * fork the chain and break the session on the next refresh.
   */
  setAuthCookies(res, { accessToken, refreshToken: result.token ?? undefined });
  res.status(204).end();
});

authRouter.post("/logout", async (req, res) => {
  const refreshToken = getRefreshTokenCookie(req);
  if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }
  clearAuthCookies(res);
  res.status(204).end();
});

/* ================================================================== *
 * Passwords
 * ================================================================== */

function failPassword(res: import("express").Response, err: unknown, fallback: string) {
  if (err instanceof PasswordError) {
    return res
      .status(err.status)
      .json({ error: err.message, code: err.code, ...(err.field ? { field: err.field } : {}) });
  }
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: z.string().min(1, "Enter a new password"),
});

/**
 * Change your password while signed in.
 *
 * Requires the current password even though the session is already valid — a
 * stolen cookie must not be enough to take the account permanently.
 */
authRouter.post("/password/change", requireAuth, async (req, res) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return res.status(400).json({
        error: issue?.message ?? "Invalid input",
        code: "INVALID_INPUT",
        field: issue?.path[0],
      });
    }

    // Rate limited on the CURRENT password check, which is a password oracle
    // for anyone holding a stolen session and guessing.
    const limit = await checkRateLimit(`password-change:${req.userId}`, 10, 15 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({
        error: "Too many attempts. Wait a few minutes.",
        code: "RATE_LIMITED",
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const result = await changePassword({
      userId: req.userId!,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
      // Their own session survives; everything else is revoked.
      keepRefreshToken: getRefreshTokenCookie(req),
    });

    res.json({
      ok: true,
      otherSessionsEnded: result.otherSessionsEnded,
      message:
        result.otherSessionsEnded > 0
          ? `Password changed. ${result.otherSessionsEnded} other session${
              result.otherSessionsEnded === 1 ? " was" : "s were"
            } signed out.`
          : "Password changed.",
    });
  } catch (err) {
    failPassword(res, err, "Could not change your password.");
  }
});

/**
 * Ask for a reset link.
 *
 * Always 200, whether or not the address is registered — anything else is an
 * account-enumeration oracle. Same reasoning as /auth/resend-verification.
 */
authRouter.post("/password/forgot", async (req, res) => {
  try {
    const parsed = emailSchema.safeParse(req.body ?? {});
    // Even a malformed address gets the same answer, so probing with junk
    // cannot be distinguished from probing with real addresses.
    if (!parsed.success) {
      return res.json({ message: "If that address has an account, a reset link is on its way." });
    }

    /**
     * Rate limited per address AND per caller.
     *
     * Per address, because otherwise this endpoint will mail somebody's inbox
     * as fast as it can be called — harassment, and a fast route to being
     * marked as spam. Per IP, because otherwise one caller can do that to a
     * long list of addresses instead.
     */
    const perEmail = await checkRateLimit(`forgot:${parsed.data.email}`, 3, 60 * 60 * 1000);
    const perCaller = await checkRateLimit(`forgot-ip:${req.ip}`, 20, 60 * 60 * 1000);

    if (perEmail.allowed && perCaller.allowed) {
      await requestPasswordReset(parsed.data.email);
    }

    // Note the response does not change when rate limited either. A 429 here
    // would say "this address is real and somebody keeps asking".
    res.json({ message: "If that address has an account, a reset link is on its way." });
  } catch (err) {
    // Even a genuine failure answers the same way, and is logged rather than
    // returned. The alternative leaks which addresses exist via error shape.
    console.error("Password reset request failed", err);
    res.json({ message: "If that address has an account, a reset link is on its way." });
  }
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, "Missing token"),
  newPassword: z.string().min(1, "Enter a new password"),
});

/** Redeem a reset link. Single-use, one hour, and it ends every session. */
authRouter.post("/password/reset", async (req, res) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return res.status(400).json({
        error: issue?.message ?? "Invalid input",
        code: "INVALID_INPUT",
        field: issue?.path[0],
      });
    }

    /**
     * A courtesy cap, not a guessing control.
     *
     * Tokens are 256 bits of randomness, so this endpoint cannot be brute
     * forced no matter how many attempts are allowed. Nor is it an expensive
     * one to abuse: an invalid token costs a SHA-256 and one indexed lookup and
     * returns before any bcrypt or breach-list call happens. Only a genuine
     * token reaches the costly work, and a genuine token can be used once.
     *
     * So the limit exists to stop somebody hammering the endpoint, and nothing
     * more. It was 20/hour, which is tight enough to bite a corporate NAT where
     * many people share one egress address — and, less importantly but more
     * visibly, tight enough that running the test suite twice in an hour
     * exhausted it. Raised to a figure that still caps abuse without punishing
     * shared addresses.
     */
    const limit = await checkRateLimit(`reset-ip:${req.ip}`, 100, 60 * 60 * 1000);
    if (!limit.allowed) {
      return res.status(429).json({ error: "Too many attempts.", code: "RATE_LIMITED" });
    }

    await resetPassword({
      token: parsed.data.token,
      newPassword: parsed.data.newPassword,
    });

    /**
     * No session is issued.
     *
     * They are sent to the login page to use the password they just chose.
     * Signing them in directly would mean a reset link is a one-click login,
     * and links leak — forwarded mail, shared screens, scanners that follow
     * URLs. Making them type it also confirms they know what they set.
     */
    clearAuthCookies(res);
    res.json({ ok: true, message: "Password changed. Sign in with your new password." });
  } catch (err) {
    failPassword(res, err, "Could not reset your password.");
  }
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  res.json({ user: publicUser(user) });
});

authRouter.post("/become-seller", requireAuth, async (req, res) => {
  const userId = req.userId!;

  // The flag and the profile have to move together. A user with isSeller but no
  // SellerProfile could not own a listing, and a profile without the flag would
  // be invisible to the UI — so both happen in one transaction or neither does.
  const user = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: { isSeller: true },
    });

    await tx.sellerProfile.upsert({
      where: { userId },
      update: {},
      create: { userId, shopName: updated.name },
    });

    return updated;
  });

  res.json({ user: publicUser(user) });
});
