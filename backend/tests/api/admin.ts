import { prisma, requireCatalog, requireServices } from "../lib/db";
import { currentCode, nextPeriod } from "../lib/totp";
import { web } from "../lib/api";
import { awaitNotifications, awaitNotificationsForUser, PASSWORD, Scope } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * The admin panel, and the two doors it deliberately does not open.
 *
 * The design claims two things, and both are asserted below rather than
 * assumed:
 *
 *   1. An ordinary signed-in session — even an admin's — grants NOTHING.
 *      A stolen storefront cookie must not reach the panel.
 *   2. Password alone is not enough. A compromised email inbox leads to a
 *      password reset, and a password reset must not lead to admin.
 *
 * Also asserted: admin revoked from the CLI takes effect immediately, not
 * whenever the 30-minute session happens to lapse.
 */

const scope = new Scope("admin");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

// currentCode / nextPeriod live in lib/totp.ts — three suites need them, and
// single-use codes are exactly the kind of detail that must not be reimplemented
// slightly differently in each one.

void main(
  "admin panel",
  async (t) => {
    await requireServices({ api: true, web: true });
    await requireCatalog();

    const admin = await scope.buyer("admin");
    const ordinary = await scope.buyer("ordinary");
    // Called for its side effect: this registers the account that section 8
    // later looks up by email to suspend. The binding was never read, and
    // deleting the line to satisfy the linter would have broken that section.
    await scope.seller("victim");

    /* ============================================================ */
    t.section("before admin is granted");

    const notYet = await admin.get("/api/admin/session");
    t.check(notYet.status === 200 && notYet.json.isAdmin === false,
      "an ordinary account is not an admin", notYet.json?.isAdmin);
    t.check((await admin.get("/api/admin/overview")).status === 401,
      "and cannot reach the panel");
    t.check((await admin.post("/api/admin/totp/setup", { password: PASSWORD })).status === 403,
      "and cannot even start two-factor enrolment");

    /* ---- granted the way it is really granted: from the CLI ---- */
    await prisma.user.update({
      where: { email: scope.emailFor("admin") },
      data: { role: "ADMIN" },
    });

    /* ============================================================ *
     * The first claim: an ordinary session grants nothing.
     * ============================================================ */
    t.section("being an admin is not the same as being in the panel");

    const now = await admin.get("/api/admin/session");
    t.check(now.json.isAdmin === true, "the account is now an admin", now.json?.isAdmin);
    t.check(now.json.needsTotpSetup === true, "and is told to set up two-factor",
      now.json?.needsTotpSetup);

    const stillLocked = await admin.get("/api/admin/overview");
    t.check(stillLocked.status === 401,
      "but the ordinary session STILL cannot reach the panel", stillLocked.status);
    t.check(stillLocked.json.code === "ADMIN_SESSION_REQUIRED", "with a specific code",
      stillLocked.json?.code);

    t.check((await admin.post("/api/admin/session", { password: PASSWORD, code: "000000" })).status === 403,
      "and cannot step up before enrolling a second factor");

    /* ============================================================ */
    t.section("enrolling two-factor");

    t.check((await admin.post("/api/admin/totp/setup", { password: "wrong password" })).status === 401,
      "setup requires the password, even though already signed in");

    const setup = await admin.post("/api/admin/totp/setup", { password: PASSWORD });
    t.check(setup.status === 200, "setup starts", setup.status);
    t.check(typeof setup.json.secret === "string" && setup.json.secret.length > 10,
      "returns a secret");
    t.check(setup.json.qrDataUrl?.startsWith("data:image/png;base64,"),
      "and a QR code to scan");

    const secret: string = setup.json.secret;

    // An unconfirmed enrolment must not count as a second factor — otherwise a
    // half-finished setup would lock the account out of its own panel.
    const beforeConfirm = await admin.post("/api/admin/session", {
      password: PASSWORD,
      code: currentCode(secret),
    });
    t.check(beforeConfirm.status === 403,
      "an unconfirmed enrolment does not count yet", beforeConfirm.status);

    t.check((await admin.post("/api/admin/totp/confirm", { code: "123456" })).status === 400,
      "a wrong code does not confirm it");

    const enrolCode = currentCode(secret);
    const confirmed = await admin.post("/api/admin/totp/confirm", { code: enrolCode });
    t.check(confirmed.status === 200, "the right code confirms it", confirmed.status);

    /* ============================================================ *
     * A code is single-use.
     *
     * A valid code lives about 90 seconds here, because one step either side is
     * allowed for clock drift. Without replay protection those same six digits
     * keep working for that whole window — so a code seen over a shoulder, or
     * relayed by a phishing proxy, can be spent a second time by someone else.
     * ============================================================ */
    t.section("a code cannot be used twice");

    const replayEnrol = await admin.post("/api/admin/session", {
      password: PASSWORD,
      code: enrolCode,
    });
    t.check(replayEnrol.status === 401,
      "the code that finished enrolment cannot then open the panel",
      `${replayEnrol.status} ${JSON.stringify(replayEnrol.json)}`);
    t.check(replayEnrol.json.error === "That didn't work.",
      "and says only that, not 'too late' — which would confirm it was real",
      replayEnrol.json?.error);

    /* ============================================================ *
     * The second claim: password alone is not enough.
     * ============================================================ */
    t.section("the step-up");

    const passwordOnly = await admin.post("/api/admin/session", {
      password: PASSWORD,
      code: "000000",
    });
    t.check(passwordOnly.status === 401,
      "the correct password with a wrong code is refused", passwordOnly.status);
    t.check((await admin.get("/api/admin/overview")).status === 401,
      "and the panel is still shut");

    const wrongPassword = await admin.post("/api/admin/session", {
      password: "not the password",
      code: currentCode(secret),
    });
    t.check(wrongPassword.status === 401, "a valid code with a wrong password is refused");
    t.check(wrongPassword.json.error === "That didn't work.",
      "and both failures give the SAME message, so this is not an oracle",
      wrongPassword.json?.error);

    // A fresh window is needed: the enrolment code was spent above, and inside
    // the same 30 seconds an authenticator app shows the very same digits.
    await nextPeriod();
    const goodCode = currentCode(secret);

    const stepUp = await admin.post("/api/admin/session", {
      password: PASSWORD,
      code: goodCode,
    });
    t.check(stepUp.status === 200 && stepUp.json.active === true, "both together open it",
      `${stepUp.status} ${JSON.stringify(stepUp.json)}`);
    t.check(stepUp.json.expiresInSeconds === 1800, "a thirty-minute session",
      stepUp.json?.expiresInSeconds);

    // The same code, immediately, from a different browser. This is the attack
    // the column exists for: an observer replaying what they just watched.
    const replayer = web();
    await replayer.post("/api/auth/login", {
      email: scope.emailFor("admin"),
      password: PASSWORD,
    });
    const replayed = await replayer.post("/api/admin/session", {
      password: PASSWORD,
      code: goodCode,
    });
    t.check(replayed.status === 401,
      "a code that just worked cannot be replayed elsewhere",
      `${replayed.status} ${JSON.stringify(replayed.json)}`);
    t.check((await replayer.get("/api/admin/overview")).status === 401,
      "so the replayer's panel stays shut");

    const overview = await admin.get("/api/admin/overview");
    t.check(overview.status === 200, "the panel opens", overview.status);
    t.check(typeof overview.json.catalogue.total === "number", "with catalogue counts",
      overview.json?.catalogue);
    t.check(typeof overview.json.reports.open === "number", "and a report count");

    /* ---- a different browser session has no admin cookie ---- */
    const freshSession = web();
    await freshSession.post("/api/auth/login", {
      email: scope.emailFor("admin"),
      password: PASSWORD,
    });
    t.check((await freshSession.get("/api/admin/overview")).status === 401,
      "signing in again elsewhere does NOT carry the admin session with it");

    /* ============================================================ */
    t.section("reporting, by an ordinary user");

    const listing = await scope.claimListing();
    const reasons = await ordinary.get("/api/reports/reasons");
    t.check(reasons.status === 200 && reasons.json.reasons.length > 0, "reasons are listed");

    const filed = await ordinary.post("/api/reports", {
      targetType: "LISTING",
      targetId: listing.id,
      reason: "MISLEADING_DESCRIPTION",
      detail: "The photo doesn't match the description.",
    });
    t.check(filed.status === 201, "a report is filed", `${filed.status} ${filed.text.slice(0, 120)}`);

    const twice = await ordinary.post("/api/reports", {
      targetType: "LISTING",
      targetId: listing.id,
      reason: "SPAM",
    });
    t.check(twice.status === 409 && twice.json.code === "ALREADY_REPORTED",
      "the same person cannot report the same thing twice while it's open",
      `${twice.status} ${twice.json?.code}`);

    const bogus = await ordinary.post("/api/reports", {
      targetType: "LISTING",
      targetId: "00000000-0000-4000-8000-000000000000",
      reason: "SPAM",
    });
    t.check(bogus.status === 404, "reporting something that doesn't exist is refused");

    t.check((await ordinary.get("/api/admin/reports")).status === 401,
      "an ordinary user cannot read the report queue");

    /* ============================================================ */
    t.section("the queue");

    const queue = await admin.get("/api/admin/reports");
    t.check(queue.status === 200, "the queue loads");
    t.check(queue.json.reports.length >= 1, "the report is in it", queue.json.reports.length);
    const report = queue.json.reports.find((r: any) => r.targetId === listing.id);
    t.check(!!report, "and is findable by target");
    t.check(report?.targetLabel === listing.title,
      "showing the item's title, not a bare UUID", report?.targetLabel);
    t.check(report?.reporterName === "Test ordinary", "and who reported it",
      report?.reporterName);
    // A moderator triaging a queue does not need contact details to judge
    // whether a listing breaks the rules.
    t.check(!JSON.stringify(report).includes("@"),
      "but NOT the reporter's email address", JSON.stringify(report).slice(0, 120));

    /* ============================================================ */
    t.section("actions require a written reason");

    t.check((await admin.post(`/api/admin/listings/${listing.id}/remove`, { reason: "" })).status === 400,
      "removing a listing with no reason is refused");
    t.check((await admin.post(`/api/admin/listings/${listing.id}/remove`, { reason: "x" })).status === 400,
      "and a one-character reason too");

    /**
     * The seller here is a seed account, which cleanup deliberately does not
     * delete — so notifications from previous runs are still on it. Counting
     * from this moment is what makes the assertion about THIS removal rather
     * than every removal ever.
     */
    const since = new Date();

    const removed = await admin.post(`/api/admin/listings/${listing.id}/remove`, {
      reason: "Photos don't match the description.",
      reportId: report.id,
    });
    t.check(removed.status === 200, "with a real reason it works", removed.status);

    const gone = await prisma.listing.findUniqueOrThrow({
      where: { id: listing.id },
      select: { deletedAt: true, status: true },
    });
    t.check(gone.deletedAt !== null && gone.status === "REMOVED",
      "the listing is soft-deleted, not destroyed", `${gone.status} deleted=${!!gone.deletedAt}`);

    const catalogue = await fetch("http://localhost:4000/catalog/listings?limit=40").then((r) => r.json());
    t.check(!catalogue.listings.some((l: any) => l.id === listing.id),
      "and it is out of the public catalogue");

    /* ---- the seller is told, with the reason ---- */
    const sellerUserId = await prisma.listing
      .findUniqueOrThrow({ where: { id: listing.id }, select: { seller: { select: { userId: true } } } })
      .then((l) => l.seller.userId);
    // Waited for, not read once: notify() is fire-and-forget so a notification
    // failure can never fail the moderation action, which means the row lands
    // just after the call returns. This read immediately and failed only inside
    // a full run, where the machine is busier.
    await awaitNotificationsForUser(sellerUserId, ["LISTING_REMOVED"]);
    const sellerNotifs = await prisma.notification.findMany({
      where: { userId: sellerUserId, type: "LISTING_REMOVED", createdAt: { gte: since } },
      select: { body: true },
    });
    t.check(sellerNotifs.length === 1, "the seller is notified once", sellerNotifs.length);
    t.check(/photos don't match/i.test(sellerNotifs[0]?.body ?? ""),
      "with the reason they were given", sellerNotifs[0]?.body);

    /* ---- restoring hands control back, it does not republish ---- */
    const restored = await admin.post(`/api/admin/listings/${listing.id}/restore`, {
      reason: "Seller corrected the photos.",
    });
    t.check(restored.status === 200, "it can be restored");
    const back = await prisma.listing.findUniqueOrThrow({
      where: { id: listing.id },
      select: { deletedAt: true, status: true },
    });
    t.check(back.deletedAt === null && back.status === "DRAFT",
      "as a DRAFT — restoring hands control back rather than republishing",
      back.status);

    /* ============================================================ */
    t.section("suspension, not deletion");

    const victimId = await prisma.user
      .findUniqueOrThrow({ where: { email: scope.emailFor("victim") }, select: { id: true } })
      .then((u) => u.id);

    const suspended = await admin.post(`/api/admin/users/${victimId}/suspend`, {
      reason: "Selling prohibited items.",
    });
    t.check(suspended.status === 200, "an account can be suspended", suspended.status);

    const loginBlocked = await web().post("/api/auth/login", {
      email: scope.emailFor("victim"),
      password: PASSWORD,
    });
    t.check(loginBlocked.status === 403 && loginBlocked.json.code === "ACCOUNT_SUSPENDED",
      "they can no longer log in", `${loginBlocked.status} ${loginBlocked.json?.code}`);
    t.check(/prohibited items/i.test(loginBlocked.json.error ?? ""),
      "and are told why, rather than facing something that looks like a bug",
      loginBlocked.json?.error);

    const theirProfile = await prisma.sellerProfile.count({
      where: { user: { email: scope.emailFor("victim") } },
    });
    t.check(theirProfile === 1,
      "their seller profile still exists — suspension is not deletion");

    t.check((await admin.post(`/api/admin/users/${victimId}/suspend`, { reason: "again" })).status === 409,
      "suspending twice is refused");

    const adminId = await prisma.user
      .findUniqueOrThrow({ where: { email: scope.emailFor("admin") }, select: { id: true } })
      .then((u) => u.id);
    t.check((await admin.post(`/api/admin/users/${adminId}/suspend`, { reason: "test" })).status === 400,
      "an admin cannot suspend themselves");

    /**
     * One compromised admin must not be able to lock the others out.
     *
     * This account is still suspended from the step above, which is the point:
     * the categorical rule must win over the state. "Can I suspend this admin?"
     * should not depend on whether they happen to be suspended already.
     */
    await prisma.user.update({ where: { id: victimId }, data: { role: "ADMIN" } });
    const adminOnAdmin = await admin.post(`/api/admin/users/${victimId}/suspend`, {
      reason: "test",
    });
    t.check(adminOnAdmin.status === 403 && adminOnAdmin.json.code === "CANNOT_SUSPEND_ADMIN",
      "and cannot suspend another admin from the UI — the rule beats the state",
      `${adminOnAdmin.status} ${adminOnAdmin.json?.code}`);
    await prisma.user.update({ where: { id: victimId }, data: { role: "USER" } });

    const reinstated = await admin.post(`/api/admin/users/${victimId}/reinstate`, {
      reason: "Listings corrected.",
    });
    t.check(reinstated.status === 200, "they can be reinstated");
    t.check((await web().post("/api/auth/login", {
      email: scope.emailFor("victim"),
      password: PASSWORD,
    })).status === 200, "and can log in again");

    /* ============================================================ */
    t.section("closing the report");

    const resolved = await admin.post(`/api/admin/reports/${report.id}/resolve`, {
      outcome: "Listing removed and then restored once corrected.",
      dismissed: false,
    });
    t.check(resolved.status === 200, "a report can be closed", resolved.status);
    t.check((await admin.post(`/api/admin/reports/${report.id}/resolve`, {
      outcome: "again",
    })).status === 409, "and cannot be closed twice");

    // Waited for, like every other notification read: notify() is
    // fire-and-forget so the row lands after the route has already answered.
    await awaitNotifications(scope.emailFor("ordinary"), ["REPORT_RESOLVED"]);
    const reporterNotified = await prisma.notification.count({
      where: { user: { email: scope.emailFor("ordinary") }, type: "REPORT_RESOLVED" },
    });
    t.check(reporterNotified === 1, "the reporter is told the outcome", reporterNotified);

    /* ============================================================ */
    t.section("the audit trail");

    const audit = await admin.get("/api/admin/audit");
    t.check(audit.status === 200, "the audit log loads");
    const actions = audit.json.actions.map((a: any) => a.action);
    for (const expected of ["LISTING_REMOVED", "LISTING_RESTORED", "USER_SUSPENDED", "USER_REINSTATED"]) {
      t.check(actions.includes(expected), `${expected} was recorded`);
    }
    const removal = audit.json.actions.find((a: any) => a.action === "LISTING_REMOVED");
    t.check(/photos don't match/i.test(removal?.reason ?? ""), "with the reason given",
      removal?.reason);
    t.check(removal?.moderator === "Test admin", "and who did it", removal?.moderator);
    t.check(removal?.reportId === report.id, "linked to the report it came from");

    /* ============================================================ *
     * Revocation must be immediate, not whenever the session lapses.
     * ============================================================ */
    t.section("revoking admin takes effect at once");

    await prisma.user.update({ where: { id: adminId }, data: { role: "USER" } });
    const afterRevoke = await admin.get("/api/admin/overview");
    t.check(afterRevoke.status === 403 && afterRevoke.json.code === "ADMIN_REVOKED",
      "the live admin session stops working immediately",
      `${afterRevoke.status} ${afterRevoke.json?.code}`);
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
