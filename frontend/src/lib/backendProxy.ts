import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:4000";

// Paths that legitimately return 401 on their own (bad credentials, no
// session yet, or the refresh call itself) — retrying these through the
// refresh flow would be wrong or would loop.
const NO_REFRESH_RETRY = new Set([
  "/auth/login",
  "/auth/signup",
  "/auth/refresh",
  "/auth/verify-email",
  "/auth/resend-verification",
]);

function parseCookieHeader(header: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return map;
}

function applySetCookies(cookieHeader: string, setCookies: string[]): string {
  const map = parseCookieHeader(cookieHeader);
  for (const setCookie of setCookies) {
    const firstPair = setCookie.split(";")[0];
    const eq = firstPair.indexOf("=");
    if (eq === -1) continue;
    map.set(firstPair.slice(0, eq).trim(), firstPair.slice(eq + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

const REFRESH_COOKIE = "retailstore_2n_refresh";

/**
 * 401 codes that mean "the access token is fine; something else was refused".
 *
 * A 401 normally means the access token expired, so the proxy refreshes and
 * retries — right for a shopping request that went stale mid-flight.
 *
 * The admin endpoints break that assumption. A wrong password or code at
 * step-up is a 401 about the CREDENTIALS, and no amount of refreshing changes
 * the answer. Retrying it silently sent the whole attempt twice, which spent
 * two of the eight allowed tries per fifteen minutes for one wrong code — so
 * the real budget was four, and a moderator could lock themselves out in half
 * the attempts the limit advertises. It also ran bcrypt and TOTP verification
 * twice for every failure.
 *
 * ADMIN_SESSION_REQUIRED is the same story and far more common: it is the
 * ordinary answer to "is an admin session live?", which the panel asks on every
 * page load. Each of those was triggering a pointless refresh — and a refresh
 * rotates the refresh token, so a page load was needlessly churning the token
 * family that theft detection watches.
 */
const NOT_A_TOKEN_PROBLEM = new Set([
  "ADMIN_SESSION_REQUIRED",
  "ADMIN_AUTH_FAILED",
  // Changing a password answers 401 when the CURRENT password is wrong. Same
  // story: refreshing cannot change the answer, and retrying would spend two of
  // the ten attempts allowed per fifteen minutes on one typo.
  "WRONG_PASSWORD",
]);

/**
 * Whether a 401 is worth refreshing for.
 *
 * Defaults to true on anything unparseable, so an unexpected body shape keeps
 * the old behaviour rather than silently disabling refresh.
 */
function worthRefreshing(body: string | null): boolean {
  if (!body) return true;
  try {
    const code = (JSON.parse(body) as { code?: string }).code;
    return !code || !NOT_A_TOKEN_PROBLEM.has(code);
  } catch {
    return true;
  }
}

/**
 * How long a completed refresh stays remembered. Requests that were already
 * on their way to the backend when the rotation happened come back with a 401
 * and a now-stale refresh token; without this they would present that old
 * token again and trip theft detection.
 */
const REFRESH_MEMO_MS = 10_000;

type RefreshOutcome = { ok: boolean; setCookies: string[] };
type RefreshEntry = { promise: Promise<RefreshOutcome>; created: number };

/**
 * Single-flight refresh — an OPTIMISATION, no longer a correctness control.
 *
 * Refresh tokens rotate on every use, and presenting an already-rotated token
 * is treated as theft — it revokes the whole family. N concurrent requests
 * hitting a freshly expired access token each call /auth/refresh with the same
 * cookie, because it is the only one the browser has, so all but the first look
 * like a replay.
 *
 * Keyed by the refresh token itself: the first caller performs the refresh and
 * everyone else awaits the same promise and reuses its cookies. One backend
 * round trip per token, however many requests expire together.
 *
 * THIS MAP IS PER-PROCESS, AND THAT IS NOW FINE.
 * It used to be the only thing preventing the race, which meant a second
 * frontend instance reintroduced it — two memos, two refreshes, one of them
 * read as theft, the user signed out everywhere.
 *
 * The race is now handled where the token state actually lives: the backend
 * treats a token superseded within the last ten seconds as a race rather than a
 * replay and issues an access token without rotating again. So a memo miss
 * across instances costs an extra HTTP round trip and nothing else.
 *
 * Keeping it anyway, because avoiding N-1 unnecessary refreshes is worth a Map.
 * NOT moved to Redis: doing that would mean publishing the newly minted refresh
 * token through Redis so the losers could use it — a live session credential in
 * the one store this codebase treats as safe to lose (ADR 0019). The grace
 * window needs no credential to leave Postgres at all.
 *
 * See docs/adr/0021-refresh-race-grace-window.md
 */
const refreshes = new Map<string, RefreshEntry>();

function sweepRefreshes(now: number) {
  for (const [key, entry] of refreshes) {
    if (now - entry.created > REFRESH_MEMO_MS) refreshes.delete(key);
  }
}

function refreshOnce(cookieHeader: string): Promise<RefreshOutcome> {
  const token = parseCookieHeader(cookieHeader).get(REFRESH_COOKIE);
  // No refresh cookie means there is nothing to refresh, and no key to dedupe on.
  if (!token) return Promise.resolve({ ok: false, setCookies: [] });

  const now = Date.now();
  sweepRefreshes(now);

  const existing = refreshes.get(token);
  if (existing) return existing.promise;

  const promise = (async (): Promise<RefreshOutcome> => {
    try {
      const refresh = await callBackend("/auth/refresh", "POST", cookieHeader, null, null);
      return {
        ok: refresh.status === 204 && refresh.setCookies.length > 0,
        setCookies: refresh.setCookies,
      };
    } catch {
      // A failed refresh must not reject: callers treat !ok as "stay signed out".
      return { ok: false, setCookies: [] };
    }
  })();

  refreshes.set(token, { promise, created: now });
  return promise;
}

async function callBackend(
  backendPath: string,
  method: string,
  cookieHeader: string,
  body: ArrayBuffer | null,
  contentType: string | null
) {
  const headers: Record<string, string> = { cookie: cookieHeader };
  if (contentType) headers["content-type"] = contentType;

  const res = await fetch(`${BACKEND_URL}${backendPath}`, {
    method,
    headers,
    body: body ?? undefined,
  });
  const text = res.status === 204 ? null : await res.text();
  return { status: res.status, contentType: res.headers.get("content-type"), body: text, setCookies: res.headers.getSetCookie() };
}

export async function proxyToBackend(req: NextRequest, backendPath: string) {
  const originalCookieHeader = req.headers.get("cookie") ?? "";

  // Buffered rather than streamed, and as bytes rather than text: image uploads
  // are multipart binary that text() would corrupt, and the refresh-and-retry
  // path below has to be able to send the same body a second time.
  const body =
    req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();

  // Forwarded as-is so multipart boundaries survive; JSON callers set their own.
  const contentType = req.headers.get("content-type");

  let result = await callBackend(backendPath, req.method, originalCookieHeader, body, contentType);
  let extraSetCookies: string[] = [];

  // Compare the path only — catch-all routes append the query string, so a
  // plain Set lookup on the full value would miss.
  const pathOnly = backendPath.split("?")[0];

  if (
    result.status === 401 &&
    !NO_REFRESH_RETRY.has(pathOnly) &&
    worthRefreshing(result.body)
  ) {
    const refresh = await refreshOnce(originalCookieHeader);

    if (refresh.ok) {
      const retryCookieHeader = applySetCookies(originalCookieHeader, refresh.setCookies);
      result = await callBackend(backendPath, req.method, retryCookieHeader, body, contentType);
      extraSetCookies = refresh.setCookies;
    }
  }

  const res = new NextResponse(result.body, {
    status: result.status,
    headers: { "Content-Type": result.contentType ?? "application/json" },
  });

  for (const cookie of [...extraSetCookies, ...result.setCookies]) {
    res.headers.append("set-cookie", cookie);
  }

  return res;
}
