import { API, prisma, requireServices } from "../lib/db";
import { PASSWORD, Scope } from "../lib/fixtures";
import { cleanupOnInterrupt, main, wireInterrupt } from "../lib/harness";

/**
 * Refresh-token rotation: the race, and the theft it must not be confused with.
 *
 * WHY THIS SUITE EXISTS
 * Rotation with reuse detection had no direct coverage at all. The passwords
 * suite inspects token rows, and nothing drove /auth/refresh — so the single
 * most destructive behaviour in the auth system (one bad request revoking every
 * session a user has) was unasserted, and a grace window was about to be added
 * on top of it.
 *
 * THE THING BEING PROTECTED
 * Access tokens last fifteen minutes, so a page with several requests in flight
 * has them all expire at the same instant. Each retries with the same refresh
 * cookie, because it is the only one the browser has. Without a grace window
 * the first rotates it and the rest look like a replay — which revokes the
 * whole family and signs the user out of every device.
 *
 * THE THING THAT MUST STILL WORK
 * A genuine replay. Four of the sections below exist to prove the window did
 * not quietly become a hole: outside it, and for every kind of revocation that
 * is not a rotation, a reused token still destroys the family.
 *
 * Talks to the API directly, never the BFF — the BFF has a single-flight memo
 * that would dedupe the very race this is trying to provoke.
 *
 * See docs/adr/0021-refresh-race-grace-window.md
 */

const scope = new Scope("refresh");
wireInterrupt();
cleanupOnInterrupt(() => scope.cleanup());

const REFRESH_COOKIE = "retailstore_2n_refresh";
const ACCESS_COOKIE = "retailstore_2n_access";

/** One cookie value out of a jar string. */
function cookieFrom(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

type RefreshReply = { status: number; refresh?: string; access?: string; setCount: number };

/** POSTs /auth/refresh with exactly the refresh cookie given, and nothing else. */
async function refreshWith(token: string): Promise<RefreshReply> {
  const res = await fetch(`${API}/auth/refresh`, {
    method: "POST",
    headers: { cookie: `${REFRESH_COOKIE}=${token}` },
  });
  const set = res.headers.getSetCookie();
  const joined = set.join("; ");
  return {
    status: res.status,
    refresh: cookieFrom(joined, REFRESH_COOKIE),
    access: cookieFrom(joined, ACCESS_COOKIE),
    setCount: set.length,
  };
}

/** How many live refresh tokens this user has. Zero means signed out everywhere. */
function liveTokens(userId: string) {
  return prisma.refreshToken.count({ where: { userId, revokedAt: null } });
}

void main(
  "refresh rotation and the concurrency race",
  async (t) => {
    await requireServices({ api: true, web: true, db: true });

    /* ============================================================ *
     * 1. Ordinary rotation.
     * ============================================================ */
    t.section("1 - one request rotates cleanly");

    const buyer = await scope.apiBuyer("racer");
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: scope.emailFor("racer") },
      select: { id: true },
    });

    const first = cookieFrom(buyer.header(), REFRESH_COOKIE);
    t.check(first !== undefined, "login issued a refresh cookie");

    const rotated = await refreshWith(first!);
    t.check(rotated.status === 204, "refresh succeeded", rotated.status);
    t.check(rotated.refresh !== undefined, "and set a NEW refresh cookie");
    t.check(rotated.refresh !== first, "which is a different value — it rotated");
    t.check(rotated.access !== undefined, "along with a new access cookie");
    t.check((await liveTokens(user.id)) === 1, "exactly one live token remains");

    /* ============================================================ *
     * 2. THE RACE.
     *
     * Ten simultaneous refreshes with the same cookie, which is what a
     * page does when several requests expire together — and what two
     * frontend instances do even after the BFF memo dedupes within each.
     * ============================================================ */
    t.section("2 - ten simultaneous refreshes with the same token");

    const shared = rotated.refresh!;
    const replies = await Promise.all(Array.from({ length: 10 }, () => refreshWith(shared)));

    const ok = replies.filter((r) => r.status === 204).length;
    const denied = replies.filter((r) => r.status === 401).length;

    t.check(ok === 10, "ALL TEN succeeded — none was mistaken for a replay", `204s=${ok} 401s=${denied}`);

    /**
     * EXACTLY ONE ROTATED.
     *
     * The rest must not mint refresh tokens of their own. Ten rotations would
     * leave ten live tokens for one session, nine of which are invalidated the
     * moment any other is used — a session that breaks on the next refresh
     * instead of this one.
     */
    const setRefresh = replies.filter((r) => r.refresh !== undefined);
    t.check(setRefresh.length === 1, "and exactly one of them set a refresh cookie", setRefresh.length);

    t.check(
      replies.every((r) => r.access !== undefined),
      "while every one of them got a working access token — which is what the request needed"
    );

    t.check(
      (await liveTokens(user.id)) === 1,
      "one live token for the session, not ten",
      await liveTokens(user.id)
    );

    /* ---- and the session is genuinely still usable ---- */
    const winner = setRefresh[0].refresh!;
    const afterRace = await refreshWith(winner);
    t.check(afterRace.status === 204, "the winner's token still refreshes normally", afterRace.status);
    t.check(afterRace.refresh !== undefined && afterRace.refresh !== winner,
      "rotating again as usual — the chain is intact, not forked");

    /* ============================================================ *
     * 3. A REPLAY OUTSIDE THE WINDOW IS STILL THEFT.
     *
     * The assertion that proves the grace window is a window and not a
     * hole. `revokedAt` is backdated rather than sleeping eleven seconds:
     * the elapsed time is the input to the decision, and simulating it
     * exactly beats waiting inexactly.
     * ============================================================ */
    t.section("3 - the same replay, eleven seconds later, revokes everything");

    const stale = afterRace.refresh!;
    const live = await refreshWith(stale);
    t.check(live.status === 204, "one more clean rotation to set up a superseded token", live.status);

    const { hashToken } = await import("../../src/lib/auth");
    await prisma.refreshToken.update({
      where: { tokenHash: hashToken(stale) },
      data: { revokedAt: new Date(Date.now() - 11_000) },
    });

    const replayed = await refreshWith(stale);
    t.check(replayed.status === 401, "the replay is refused", replayed.status);
    t.check(
      (await liveTokens(user.id)) === 0,
      "and the ENTIRE family is revoked — every device signed out",
      await liveTokens(user.id)
    );

    /* ============================================================ *
     * 4. Revocations that are not rotations are never graced.
     *
     * The window is gated on `replacedByTokenHash`, which only rotation
     * writes. Logout and password change leave it null, so a token
     * revoked by either is a replay from the first millisecond — there is
     * no concurrent refresh to be racing with.
     * ============================================================ */
    t.section("4 - a token killed by logout gets no grace, even immediately");

    const loggedOut = await scope.apiBuyer("loggedout");
    const loggedOutUser = await prisma.user.findUniqueOrThrow({
      where: { email: scope.emailFor("loggedout") },
      select: { id: true },
    });
    const doomed = cookieFrom(loggedOut.header(), REFRESH_COOKIE)!;

    const bye = await loggedOut.post("/auth/logout");
    t.check(bye.status === 204, "logged out", bye.status);

    const afterLogout = await refreshWith(doomed);
    t.check(
      afterLogout.status === 401,
      "the just-revoked token is refused with no grace period at all",
      afterLogout.status
    );
    t.check(
      (await liveTokens(loggedOutUser.id)) === 0,
      "nothing live is left",
      await liveTokens(loggedOutUser.id)
    );

    /* ---- password change: same reasoning, different route ---- */
    t.section("5 - and neither does a token killed by a password change");

    const changed = await scope.apiBuyer("changer");
    const changerUser = await prisma.user.findUniqueOrThrow({
      where: { email: scope.emailFor("changer") },
      select: { id: true },
    });

    // Rotate once so this token has been through a rotation and therefore HAS
    // a replacement — the grace window's other precondition. The change below
    // then revokes that replacement, which is what must stop the grace.
    const beforeChange = cookieFrom(changed.header(), REFRESH_COOKIE)!;
    const rotatedOnce = await refreshWith(beforeChange);
    t.check(rotatedOnce.status === 204, "rotated once", rotatedOnce.status);

    const change = await changed.post("/auth/password/change", {
      currentPassword: PASSWORD,
      newPassword: "a replacement long enough to pass 1",
    });
    t.check(change.status === 200, "password changed", change.status);

    /**
     * `beforeChange` was rotated seconds ago and has a replacement — both
     * grace preconditions hold. The replacement is now revoked, and that alone
     * must be enough to refuse.
     *
     * Without the liveness check on the replacement, a stolen token would be
     * usable for ten seconds after the victim changed their password
     * *specifically to stop it*.
     */
    const afterChange = await refreshWith(beforeChange);
    t.check(
      afterChange.status === 401,
      "a rotated token whose replacement was revoked gets no grace",
      afterChange.status
    );
    t.check(
      (await liveTokens(changerUser.id)) <= 1,
      "and no extra sessions were created in the process",
      await liveTokens(changerUser.id)
    );

    /* ============================================================ *
     * 6. Nonsense is still nonsense.
     * ============================================================ */
    t.section("6 - an unknown token is refused without touching anything");

    const other = await scope.apiBuyer("bystander");
    const otherUser = await prisma.user.findUniqueOrThrow({
      where: { email: scope.emailFor("bystander") },
      select: { id: true },
    });

    const garbage = await refreshWith("not-a-token-that-was-ever-issued");
    t.check(garbage.status === 401, "refused", garbage.status);
    t.check(
      (await liveTokens(otherUser.id)) === 1,
      "and an unrelated user's session is untouched",
      await liveTokens(otherUser.id)
    );
    t.check((await other.get("/auth/me")).status === 200, "who is still signed in");
  },
  async (t) => {
    await scope.cleanup();
    await scope.verifyClean(t);
  }
);
