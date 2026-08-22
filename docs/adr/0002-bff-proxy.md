# 2. Next.js as a Backend-for-Frontend instead of direct browser→API calls

- **Status:** Accepted
- **Recorded:** 2026-08-22

## Context

The frontend and backend are separate apps on separate ports. The browser needs
data from Express. The obvious approach is to call it directly with
`credentials: "include"` and a CORS allowlist.

That approach has costs that compound: the backend's address ships to the
browser, cross-origin cookies need `SameSite=None` in production (which means
third-party cookie handling), and CORS preflights become a permanent
maintenance surface.

## Decision

The browser only ever talks to the Next.js server. Route handlers under
`frontend/src/app/api/*` forward to Express server-to-server and relay cookies
in both directions.

`BACKEND_URL` is a server-only variable — deliberately *not* `NEXT_PUBLIC_*` —
so the backend address never reaches the client bundle.

Two consequences fall out of putting the proxy here:

- **Transparent token refresh.** On a 401 the proxy calls `/auth/refresh`, then
  replays the original request with the rotated cookies. Callers never see the
  15-minute expiry ([ADR 0001](0001-access-and-refresh-tokens.md)). Endpoints
  that legitimately 401 — login, signup, refresh, verify-email,
  resend-verification — are excluded, or a wrong password would trigger a
  refresh loop.
- **Same-origin cookies.** Plain `SameSite=Lax` works, with no third-party
  cookie exposure.

**Server components are the exception.** Public catalog reads call Express
directly rather than routing through `/api/*`. The Next server *is* the BFF, so
making it call its own HTTP handler would add a hop for nothing. The BFF exists
for *browser* traffic.

## Consequences

- One origin for the browser. No CORS configuration on the client side.
- Auth complexity is centralised in one module instead of spread across call
  sites.
- Every browser request pays an extra local hop. Negligible next to the database
  work behind it.
- The proxy must be body-format agnostic. It originally read bodies as text,
  which silently corrupted multipart uploads; it now buffers an `ArrayBuffer`
  and forwards the incoming `Content-Type`. Buffering rather than streaming is
  required because refresh-and-retry has to send the same body twice.
- The BFF is not a security control. It forwards without interpreting, so every
  rule is enforced in Express.
- **Refresh-and-retry must not fire on a 401 that has nothing to do with the
  access token.** The proxy treats 401 as "token expired, refresh and try
  again", which is right for a stale shopping request. It is wrong for the admin
  endpoints: a bad password or code at step-up is a 401 about the credentials,
  and retrying sent the whole attempt twice — spending two of the eight allowed
  tries per fifteen minutes for one wrong code, so the real budget was four. It
  also ran bcrypt and TOTP verification twice per failure, and turned the
  panel's routine "is an admin session live?" check into a needless refresh
  token rotation on every page load. The retry is now skipped when the 401 body
  carries a code saying the token was never the problem
  (`worthRefreshing` in `lib/backendProxy.ts`), defaulting to retry on anything
  unparseable so an unexpected shape cannot silently disable refresh.

## Alternatives considered

**Direct calls with CORS.** Fewer moving parts, but exposes the backend origin,
needs `SameSite=None` cross-site cookies in production, and spreads refresh
handling across every caller.

**A dedicated API gateway (nginx, Traefik).** The right answer at multi-service
scale. Here it would be another process to run and could not implement
refresh-and-retry without application knowledge.

**Next.js server actions for everything.** Idiomatic Next, but couples the
client tightly to the framework and fits mutations better than the read-heavy
catalog.
