# 1. Access + rotating refresh tokens with reuse detection

- **Status:** Accepted
- **Recorded:** 2026-08-22

## Context

Sessions need to survive a browser restart for weeks, while a stolen credential
should stop working quickly. Those two goals pull in opposite directions with a
single long-lived token.

A JWT is cheap to validate — no database round trip — but cannot be revoked
before it expires. A long-lived JWT is therefore a credential you cannot take
back.

## Decision

Two tokens with different jobs.

**Access token** — signed JWT, 15 minutes, `httpOnly` cookie. Validated
statelessly on every request.

**Refresh token** — opaque random string, 30 days, `httpOnly` cookie. Only the
**SHA-256 hash** is stored. Each use rotates it: a new token is issued and the
old row records `replacedByTokenHash`.

**Reuse detection:** presenting an already-rotated token means two parties hold
it. There is no way to tell which is the attacker, so the entire token family is
revoked. The legitimate user logs in again; the stolen token is worthless.

Refresh tokens are hashed for the same reason passwords are — a refresh token is
sufficient to impersonate someone, so a database leak must not yield usable
sessions.

## Consequences

- Revocation works within 15 minutes without a database lookup per request.
- Token theft is detected rather than merely survived.
- Requires a `refresh_tokens` table and rotation logic.
- The BFF must transparently refresh on 401 and retry, or every session would
  visibly break every 15 minutes ([ADR 0002](0002-bff-proxy.md)).

### Correction: concurrent refresh is not an edge case

This record originally said a concurrent-refresh race was *"rare, and the
failure mode is a re-login rather than a compromise."* Both halves were wrong,
and it shipped as a bug: users were being signed out after roughly 15 minutes
idle, and buy actions failed with "Not authenticated".

**Why it is not rare.** It needs no second tab. The app issues several
authenticated requests together on ordinary page loads — `AuthContext` calls
`/auth/me` while the account page calls `/seller/me`, the seller dashboard
calls `/seller/me` and `/seller/listings`, a hold posts to `/reservations`.
Once the access token has expired, each of those 401s and each asks to refresh
using the same token. The first rotates it; every other one is presenting an
already-rotated token, which is indistinguishable from a replay.

**Why the failure mode is worse than a re-login.** Reuse detection revokes the
whole family, so the session cannot be recovered. But the request that won the
race still returns a fresh access token — so the user looks signed in for
another 15 minutes and is then locked out with no way back. Measured directly:
two concurrent requests left `0` unrevoked tokens.

**The fix: single-flight refresh in the BFF.** `lib/backendProxy.ts` keys
in-progress refreshes by refresh token, so the first caller performs the
refresh and the rest await the same promise and reuse its cookies. One refresh
per token however many requests expire together. Completed entries are
remembered for 10 seconds, because a request already travelling to the backend
when rotation happened comes back with a stale token and would otherwise
present it again.

This costs nothing in security: theft detection is untouched, and the BFF
simply stops sending duplicate refreshes. Verified with five simultaneous
authenticated requests after expiry — all 200, session intact.

**Known boundary:** the map is per-process. Behind more than one instance the
race returns, because each process would run its own refresh. Before scaling
out, the backend needs a short reuse grace window — which is a real design
change, not a timestamp check, since only the token *hash* is stored and the
original replacement therefore cannot be handed back.

A client-side revalidation every 13 minutes was also added, so an open tab
usually rolls its session forward before reaching the 401 path at all. That is
an optimisation, not the fix: timers do not fire on a sleeping machine, so a
visibility check covers resume and single-flight still does the real work.

## Alternatives considered

**Single long-lived JWT.** Simplest, and unrevocable. A leaked token stays valid
until expiry.

**Server-side sessions in Redis.** Trivially revocable, but adds infrastructure
and a lookup on every request. Reasonable, but the JWT + refresh pairing gets
most of the benefit without another service to run.

**Refresh tokens stored in plaintext.** Simpler comparison, but converts a
read-only database leak directly into account takeover.

**Rotation without reuse detection.** Rotation alone narrows the window; it does
not notice that a token leaked. Detection is the part that turns theft into a
dead end, and it costs one extra column.
