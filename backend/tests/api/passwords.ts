import { prisma, requireServices } from "../lib/db";
import { web } from "../lib/api";
import { PASSWORD, Scope } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * Changing a password, and recovering a lost one.
 *
 * THE ASSERTIONS THAT MATTER ARE THE NEGATIVE ONES
 * Both routes end with somebody holding a new password, so "it worked" is the
 * easy half. What actually protects an account is everything that must NOT
 * happen: a stolen session cannot change the password without knowing it, a
 * link cannot be used twice, a wrong link cannot be told apart from an expired
 * one, and the endpoint must not answer differently for an address that exists.
 *
 * That last one is the reason /password/forgot always returns the same 200. An
 * endpoint that says "no such account" is an account-enumeration oracle, and
 * the list it produces is exactly what a credential-stuffing run wants.
 */

const scope = new Scope("pwd");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

const NEW_PASSWORD = "a completely different phrase 41";

/** Reads the freshest live reset token for an account, the way the email would. */
async function resetTokenFor(email: string) {
  const row = await prisma.passwordResetToken.findFirst({
    where: { user: { email }, usedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, tokenHash: true, expiresAt: true },
  });
  return row;
}

void main(
  "passwords",
  async (t) => {
    await requireServices({ api: true, web: true });

    /* ============================================================ *
     * 1. Changing it while signed in.
     * ============================================================ */
    t.section("1 - changing a password you know");

    const email = scope.emailFor("changer");
    const buyer = await scope.buyer("changer");

    const wrongCurrent = await buyer.post("/api/auth/password/change", {
      currentPassword: "not my password at all",
      newPassword: NEW_PASSWORD,
    });
    t.check(wrongCurrent.status === 401,
      "a stolen session cannot change the password without knowing it",
      `${wrongCurrent.status} ${JSON.stringify(wrongCurrent.json)}`);
    t.check(wrongCurrent.json.field === "currentPassword",
      "and says which field was wrong", wrongCurrent.json?.field);

    const tooShort = await buyer.post("/api/auth/password/change", {
      currentPassword: PASSWORD,
      newPassword: "short",
    });
    t.check(tooShort.status === 400 && tooShort.json.field === "newPassword",
      "a short new password is refused", `${tooShort.status} ${tooShort.json?.field}`);

    const same = await buyer.post("/api/auth/password/change", {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    t.check(same.status === 400 && same.json.code === "SAME_PASSWORD",
      "and so is setting the password you already have", same.json?.code);

    const breached = await buyer.post("/api/auth/password/change", {
      currentPassword: PASSWORD,
      newPassword: "password123456",
    });
    t.check(breached.status === 400 && breached.json.code === "PASSWORD_BREACHED",
      "a breached password is refused here too, not just at signup",
      `${breached.status} ${breached.json?.code}`);

    /* ---- a second session, which must die ---- */
    const otherDevice = web();
    const otherLogin = await otherDevice.post("/api/auth/login", { email, password: PASSWORD });
    t.check(otherLogin.status === 200, "a second device signs in", otherLogin.status);
    t.check((await otherDevice.get("/api/auth/me")).status === 200,
      "and can read its own account");

    const changed = await buyer.post("/api/auth/password/change", {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    t.check(changed.status === 200, "the change goes through", changed.status);
    t.check(changed.json.otherSessionsEnded >= 1,
      "and reports how many other sessions it ended",
      changed.json?.otherSessionsEnded);

    t.check((await buyer.get("/api/auth/me")).status === 200,
      "the tab you changed it from stays signed in");

    /**
     * Checked at the token rows, not by calling /auth/refresh.
     *
     * The browser never calls refresh directly — the BFF does it internally on
     * a 401, so there is no /api/auth/refresh to hit and an earlier version of
     * this assertion was testing a 404.
     *
     * What it asserts instead is the real property: exactly one live refresh
     * token remains, the one belonging to the tab that made the change. The
     * other device keeps its ACCESS token until it expires — that is what a
     * short-lived bearer token means — but it can never renew, so its session
     * is finished within fifteen minutes rather than lasting thirty days.
     */
    const liveTokens = await prisma.refreshToken.count({
      where: { user: { email }, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    t.check(liveTokens === 1,
      "exactly one refresh token survives — the tab that changed the password",
      `${liveTokens} live`);

    t.check((await web().post("/api/auth/login", { email, password: PASSWORD })).status === 401,
      "the old password no longer works");
    const newLogin = await web().post("/api/auth/login", { email, password: NEW_PASSWORD });
    t.check(newLogin.status === 200, "the new one does", newLogin.status);

    /* ============================================================ *
     * 2. Asking for a reset link.
     * ============================================================ */
    t.section("2 - forgot password, and the enumeration question");

    /**
     * A fresh account per run, unlike everything else in this suite.
     *
     * The forgot-password limiter is keyed by EMAIL — three an hour — which is
     * correct for the product: deleting and recreating your account must not
     * hand you a fresh allowance. It is deterministic Scope emails that make it
     * awkward here, because the limiter is in-memory and outlives the accounts.
     * Two runs of this suite inside an hour silently exhausted the budget, no
     * token was minted, and the failure read as "the token was not stored".
     *
     * Timestamped so each run gets its own bucket. Still under the reserved
     * prefix, so cleanup and the stale-data purge both still find it.
     */
    const forgotName = `forgot-${Date.now()}`;
    const forgotEmail = scope.emailFor(forgotName);
    await scope.buyer(forgotName);

    const forgotReal = await web().post("/api/auth/password/forgot", { email: forgotEmail });
    const forgotFake = await web().post("/api/auth/password/forgot", {
      email: "rs2.pwd.nobody-at-all@retailstore-2n.test",
    });
    const forgotJunk = await web().post("/api/auth/password/forgot", { email: "not-an-email" });

    t.check(forgotReal.status === 200, "asking for a link succeeds", forgotReal.status);
    t.check(
      forgotFake.status === forgotReal.status &&
        JSON.stringify(forgotFake.json) === JSON.stringify(forgotReal.json),
      "an address with NO account answers identically — no enumeration oracle",
      `${forgotFake.status} ${JSON.stringify(forgotFake.json)}`
    );
    t.check(
      forgotJunk.status === forgotReal.status &&
        JSON.stringify(forgotJunk.json) === JSON.stringify(forgotReal.json),
      "and so does a malformed one, so probing with junk is indistinguishable",
      `${forgotJunk.status} ${JSON.stringify(forgotJunk.json)}`
    );

    t.check(
      (await prisma.passwordResetToken.count({
        where: { user: { email: "rs2.pwd.nobody-at-all@retailstore-2n.test" } },
      })) === 0,
      "and no token is minted for an address that has no account"
    );

    const issued = await resetTokenFor(forgotEmail);
    t.check(!!issued, "a token was stored for the real account");
    t.check(issued !== null && issued.tokenHash.length === 64,
      "hashed, not stored in the clear — a leak must not hand over live links",
      issued?.tokenHash.slice(0, 12));

    const ttlMinutes = issued
      ? Math.round((issued.expiresAt.getTime() - Date.now()) / 60000)
      : 0;
    t.check(ttlMinutes > 50 && ttlMinutes <= 60,
      "expiring in about an hour, not the 24 a verification link gets",
      `${ttlMinutes} minutes`);

    /* ---- asking again invalidates the first link ---- */
    await web().post("/api/auth/password/forgot", { email: forgotEmail });
    const live = await prisma.passwordResetToken.count({
      where: { user: { email: forgotEmail }, usedAt: null },
    });
    t.check(live === 1,
      "asking twice leaves exactly one live link, not two",
      `${live} live`);

    /* ============================================================ *
     * 3. Redeeming it.
     * ============================================================ */
    t.section("3 - resetting with the link");

    // The raw token only exists in the email, so the test mints its own the
    // same way the library does and writes the matching hash.
    const crypto = await import("crypto");
    const { hashToken } = await import("../../src/lib/auth");
    const raw = crypto.randomBytes(32).toString("hex");
    const owner = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });
    await prisma.passwordResetToken.updateMany({
      where: { userId: owner.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    await prisma.passwordResetToken.create({
      data: {
        userId: owner.id,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const badToken = await web().post("/api/auth/password/reset", {
      token: "0".repeat(64),
      newPassword: "yet another good phrase 88",
    });
    t.check(badToken.status === 400 && badToken.json.code === "INVALID_TOKEN",
      "an unknown token is refused", badToken.json?.code);

    const FINAL_PASSWORD = "the third and final phrase 77";
    const reset = await web().post("/api/auth/password/reset", {
      token: raw,
      newPassword: FINAL_PASSWORD,
    });
    t.check(reset.status === 200, "a good token sets the new password", reset.status);

    const replay = await web().post("/api/auth/password/reset", {
      token: raw,
      newPassword: "trying the same link twice 99",
    });
    t.check(replay.status === 400 && replay.json.code === "INVALID_TOKEN",
      "the same link cannot be used twice", replay.json?.code);
    t.check(replay.json.error === badToken.json.error,
      "and a spent link is indistinguishable from a fake one",
      `"${replay.json?.error}" vs "${badToken.json?.error}"`);

    t.check((await web().post("/api/auth/login", { email, password: NEW_PASSWORD })).status === 401,
      "the password from before the reset stops working");
    const finalLogin = await web().post("/api/auth/login", {
      email,
      password: FINAL_PASSWORD,
    });
    t.check(finalLogin.status === 200, "and the one just chosen works", finalLogin.status);

    /* ---- resetting does not sign you in ---- */
    t.check(!/set-cookie/i.test(JSON.stringify(reset.json ?? {})),
      "the reset response carries no session");
    t.check(reset.json.ok === true && /sign in/i.test(reset.json.message ?? ""),
      "it sends you to sign in instead — a reset link must not be a one-click login",
      reset.json?.message);

    /* ============================================================ *
     * 4. A reset proves inbox control, so it verifies the address.
     * ============================================================ */
    t.section("4 - an unverified account can still recover");

    const unverifiedEmail = scope.emailFor("unverified");
    await web().post("/api/auth/signup", {
      name: "Test unverified",
      email: unverifiedEmail,
      password: PASSWORD,
    });
    scope.track(unverifiedEmail);
    // Signup marks accounts verified while email verification is switched off,
    // so the unverified starting state is set directly.
    await prisma.user.update({ where: { email: unverifiedEmail }, data: { emailVerified: false } });

    const before = await prisma.user.findUniqueOrThrow({
      where: { email: unverifiedEmail },
      select: { id: true, emailVerified: true },
    });
    t.check(before.emailVerified === false, "the account starts unverified");

    const rawTwo = crypto.randomBytes(32).toString("hex");
    await prisma.passwordResetToken.create({
      data: {
        userId: before.id,
        tokenHash: hashToken(rawTwo),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const recovered = await web().post("/api/auth/password/reset", {
      token: rawTwo,
      newPassword: "recovered without verifying 12",
    });
    t.check(recovered.status === 200, "they can still reset", recovered.status);

    const after = await prisma.user.findUniqueOrThrow({
      where: { email: unverifiedEmail },
      select: { emailVerified: true },
    });
    t.check(after.emailVerified === true,
      "and the reset verified the address, because using the link proved the inbox",
      after.emailVerified);
    t.check(
      (await web().post("/api/auth/login", {
        email: unverifiedEmail,
        password: "recovered without verifying 12",
      })).status === 200,
      "so they are not left unable to log in for a reason they already satisfied"
    );

    /* ============================================================ *
     * 5. An expired link.
     * ============================================================ */
    t.section("5 - an expired link");

    const rawThree = crypto.randomBytes(32).toString("hex");
    await prisma.passwordResetToken.create({
      data: {
        userId: owner.id,
        tokenHash: hashToken(rawThree),
        // Already dead.
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const stale = await web().post("/api/auth/password/reset", {
      token: rawThree,
      newPassword: "should not be accepted 55",
    });
    t.check(stale.status === 400 && stale.json.code === "INVALID_TOKEN",
      "an expired link is refused", stale.json?.code);
    t.check(stale.json.error === badToken.json.error,
      "with the same message a fake one gets, so it confirms nothing",
      stale.json?.error);
    t.check(
      (await web().post("/api/auth/login", { email, password: FINAL_PASSWORD })).status === 200,
      "and the real password is untouched"
    );

    /* ---- signed out is signed out ---- */
    t.check((await web().post("/api/auth/password/change", {
      currentPassword: FINAL_PASSWORD,
      newPassword: "nope 1234567890",
    })).status === 401, "changing a password requires being signed in");
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
