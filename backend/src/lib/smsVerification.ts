import crypto from "crypto";
import { hashToken } from "./auth";
import { prisma } from "./prisma";
import { InvalidPhoneNumber, toE164 } from "./phone";
import { SmsSendError, sendSms } from "./smsProvider";

/**
 * Proving that whoever holds the account holds the phone.
 *
 * Mirrors lib/emailVerification.ts — issue a secret, hash it, expire it, spend
 * it once — with the differences a six-digit code forces. See the comment on
 * the PhoneVerification model for why each one exists.
 */

/**
 * TEN MINUTES, against twenty-four hours for an email link.
 *
 * An email link needs the inbox. A code sits on a lock screen where anybody
 * holding the handset can read it, so the window in which a borrowed or stolen
 * phone can be turned into a verified number is kept short.
 */
const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Wrong guesses allowed against one code, after which it is spent.
 *
 * Five is enough for a misread digit and far too few to search a million-code
 * space. Past it, guessing costs a fresh code — which costs a rate-limit slot,
 * which is the actual ceiling.
 */
const MAX_ATTEMPTS = 5;

/**
 * Six digits, uniformly drawn.
 *
 * `crypto.randomInt` rather than `Math.random()`: this is a credential. The
 * range is inclusive-exclusive, so this yields 000000-999999 with equal
 * probability and keeps leading zeros, which a numeric type would eat.
 */
function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export class PhoneAlreadyInUse extends Error {
  constructor() {
    super("That number is already verified on another account.");
    this.name = "PhoneAlreadyInUse";
  }
}

export type IssueResult = {
  /** E.164, for showing back to the user masked. */
  phone: string;
  expiresAt: Date;
  /**
   * Only ever set under the stub provider, so the suite and a local developer
   * can complete the flow without a handset. Null under twilio — and the route
   * must not return it to a client regardless.
   */
  devCode: string | null;
};

/**
 * Sends a fresh code, invalidating any earlier one for this user.
 *
 * INVALIDATING FIRST MATTERS. Without it, requesting three codes leaves three
 * live codes, which triples the chance a guess lands and lets an attacker who
 * can trigger sends widen the target. One live code per user at a time.
 */
export async function issueAndSendCode(userId: string, rawPhone: string): Promise<IssueResult> {
  const phone = toE164(rawPhone);

  /**
   * Checked before a message is paid for. The unique index is still the real
   * guard — two people racing the same number both pass this check and one
   * loses at the insert — but failing here saves an SMS and gives a better
   * message than a constraint violation.
   */
  const taken = await prisma.user.findFirst({
    where: { phone, phoneVerifiedAt: { not: null }, NOT: { id: userId } },
    select: { id: true },
  });
  if (taken) throw new PhoneAlreadyInUse();

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  await prisma.$transaction([
    prisma.phoneVerification.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.phoneVerification.create({
      data: { userId, phone, codeHash: hashToken(code), expiresAt },
    }),
  ]);

  /**
   * The message names the sender and the action, and carries nothing else. An
   * order number or an amount in a verification text is data on a lock screen
   * for no benefit — the recipient already knows what they just asked for.
   */
  await sendSms({
    to: phone,
    body: `${code} is your RetailStore_2n verification code. It expires in 10 minutes. If you did not ask for it, ignore this message.`,
  });

  return {
    phone,
    expiresAt,
    devCode: process.env.SMS_PROVIDER?.trim() === "twilio" ? null : code,
  };
}

export type VerifyOutcome =
  | { ok: true; phone: string }
  | { ok: false; reason: "no-code" | "expired" | "too-many-attempts" | "wrong-code" | "taken" };

/**
 * Checks a code and, if it is right, commits the number.
 *
 * VERIFICATION AND CONSENT ARE SET TOGETHER HERE, and that is a decision worth
 * naming. Entering a code that was sent to your phone, having typed that number
 * into a settings page that says what it is for, is the consent. Asking a
 * second time on the next screen would be theatre, and the columns stay
 * separate so consent can later be withdrawn without unverifying the number.
 */
export async function verifyCode(userId: string, rawCode: string): Promise<VerifyOutcome> {
  const code = (rawCode ?? "").trim();

  const record = await prisma.phoneVerification.findFirst({
    where: { userId, usedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!record) return { ok: false, reason: "no-code" };
  if (record.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (record.attempts >= MAX_ATTEMPTS) return { ok: false, reason: "too-many-attempts" };

  /**
   * Compared as fixed-length hashes under timingSafeEqual rather than with
   * `===`. The timing signal on a six-digit code is small, and so is the cost
   * of not having to argue about how small.
   */
  const expected = Buffer.from(record.codeHash, "hex");
  const actual = Buffer.from(hashToken(code), "hex");
  const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!matches) {
    await prisma.phoneVerification.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, reason: "wrong-code" };
  }

  const now = new Date();

  try {
    await prisma.$transaction([
      prisma.phoneVerification.update({
        where: { id: record.id },
        data: { usedAt: now },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { phone: record.phone, phoneVerifiedAt: now, smsConsentAt: now },
      }),
    ]);
  } catch (err) {
    /**
     * The unique index fired: somebody else verified this number between the
     * check in issueAndSendCode and now. Rare, and the correct outcome — the
     * first to prove it keeps it.
     */
    const code2 = (err as { code?: string })?.code;
    if (code2 === "P2002") return { ok: false, reason: "taken" };
    throw err;
  }

  return { ok: true, phone: record.phone };
}

/**
 * Forgets the number entirely.
 *
 * All three columns clear together. Leaving `phone` behind with a null
 * `phoneVerifiedAt` would keep a number nobody consented to hold, and would
 * hold the unique index against its owner using it on another account.
 */
export async function removePhone(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.phoneVerification.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { phone: null, phoneVerifiedAt: null, smsConsentAt: null },
    }),
  ]);
}

export { InvalidPhoneNumber, SmsSendError };
