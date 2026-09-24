# Security Policy

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (Security → Report a vulnerability), which keeps the report
private until a fix exists.

Useful to include: what you did, what happened, and what you expected — plus
the affected endpoint or file if you know it.

This is a personal project with no SLA. Expect a response in days rather than
hours.

## Scope

RetailStore_2n is **in development and not deployed**. There is no production
instance, no real user data, and no real money. Reports are welcome anyway —
the point of the exercise is getting this right — but nothing here is protecting
live users today.

Three integrations are deliberate stubs and are **not** vulnerabilities:

| Stub | Behaviour |
| --- | --- |
| Email (`lib/mailer.ts`) | Verification links print to the server console |
| Identity (`lib/kycProvider.ts`) | Deterministic fake; verifies nobody |
| Storage (`lib/storage.ts`) | Local disk, publicly readable by design |

The identity stub reports `isStub: true` through the API and is labelled on
screen, so it never implies a real check occurred.

## Posture

What is deliberately in place, with the reasoning in each linked record:

**Sessions.** 15-minute JWT access tokens plus 30-day opaque refresh tokens.
Refresh tokens are stored as SHA-256 hashes, rotate on every use, and reuse of a
rotated token revokes the whole family — theft is detected, not merely survived.
All cookies are `httpOnly`, `sameSite=lax`, `secure` in production, so XSS
cannot read a session. The BFF performs refreshes single-flight, so concurrent
requests expiring together cannot look like a replay and revoke a live session.
→ [ADR 0001](docs/adr/0001-access-and-refresh-tokens.md)

**Passwords.** bcrypt cost 12. Minimum 12 characters with no composition rules,
plus rejection of anything in known breach corpora via Pwned Passwords
k-anonymity — only a 5-character hash prefix leaves the server.
→ [ADR 0004](docs/adr/0004-password-policy.md)

**Authorisation.** `requireAuth` establishes identity; `requireSeller` resolves
the caller's seller profile. Every seller query is scoped by `sellerId`, and
records owned by others return 404 rather than 403 so response codes don't
disclose existence.

**Uploads.** Magic-byte validation (not extension or `Content-Type`),
re-encoding through Sharp that strips EXIF including GPS, an 8 MB cap, a
50-megapixel decode cap against decompression bombs, and server-generated
storage keys validated against a strict pattern so user input never reaches a
filesystem path.
→ [ADR 0010](docs/adr/0010-strip-image-metadata.md)

**Identity data.** No ID images, document numbers, or dates of birth are ever
stored. Only a provider session reference, document type, country, outcome, and
timestamp.
→ [ADR 0006](docs/adr/0006-kyc-store-reference-not-document.md)

**SQL injection.** Database access goes through Prisma's query builder, which
parameterises. There is exactly one raw SQL statement — the `SELECT … FOR UPDATE`
that locks a listing row during reservation, which the query builder cannot
express. Its parameters go through Prisma's tagged template rather than string
concatenation, and every write around it is a normal Prisma call.
→ [ADR 0012](docs/adr/0012-row-locking-for-reservations.md)

**Boundaries.** The browser never reaches Express directly. The BFF forwards
without interpreting and is therefore *not* a security control — every rule is
enforced in the API, and disabled UI is always re-checked server-side.
→ [ADR 0002](docs/adr/0002-bff-proxy.md)

## Known gaps

Tracked, not hidden:

- **No per-IP limit on login.** Login is capped per address — 10 attempts per
  15 minutes, cleared on success — alongside eleven other limited endpoints,
  including admin step-up at 8 per 15 min, which is the only reason a six-digit
  TOTP is not brute-forceable. The counters are shared across instances via
  Redis, so they hold under replicas rather than silently multiplying by the
  replica count.
  → [ADR 0018](docs/adr/0018-redis-for-shared-ephemeral-state.md)

  What is missing is a per-IP limit, and it is missing on purpose. Set low
  enough to matter it punishes shared addresses — an office, a university, a
  carrier NAT — where hundreds of unrelated people sign in from one IP. Set high
  enough not to, it stops nothing, because credential stuffing tries one leaked
  password against thousands of accounts from rotating proxies and the
  per-address counter never sees more than one attempt from any of them.

  The version worth having counts only *failed* attempts, so legitimate traffic
  behind a NAT never accumulates. That needs the limiter to report a count
  without incrementing it, which the current one deliberately cannot do — it
  counts on the way in, because that is what makes it atomic.

- **A known denial-of-service on the login limit.** Because the counter is keyed
  on the submitted address, somebody who knows a victim's email can spend that
  victim's allowance and keep them out for up to fifteen minutes. Accepted
  knowingly: a recoverable nuisance against an otherwise unbounded attack on
  every account. It is also why the limit is ten rather than three.
- **Reuse detection has a ten-second grace window.** A refresh token
  superseded within ten seconds is treated as a concurrent request rather than
  a replay, because access tokens expire in batches and a page with several
  requests in flight would otherwise revoke its own session on every refresh.
  Outside the window, and for tokens revoked by logout or a password change, a
  replay still revokes every session the user has.

  This is not a widening of anyone's reach: the path is only reachable by
  presenting a token that was valid ten seconds ago, and whoever holds that
  token could have used it normally in the same window.
  → [ADR 0021](docs/adr/0021-refresh-race-grace-window.md)
- **No CSRF tokens.** `sameSite=lax` cookies plus a same-origin BFF cover the
  common cases, but state-changing requests have no additional token. Worth
  adding before deployment.
- **No security headers.** No CSP, HSTS, or `X-Content-Type-Options`. `helmet`
  and a CSP belong here before this is public.
- **No account lockout.** Deliberate, not missing. Login is throttled (above),
  which caps guessing without handing anyone a way to disable another person's
  account permanently — a lockout that an attacker can trigger is a denial of
  service dressed as a control.
- **Email enumeration is partially possible.** Resend-verification is
  deliberately silent, but signup distinguishes an already-verified address.
- **Uploads are served from a public path** with unguessable keys. Adequate for
  listing photos; not appropriate for anything private.
- **No automated security testing.** No dependency scanning, SAST, or
  `npm audit` in CI — there is no CI.
- **No secret management.** Secrets come from `.env` files. `JWT_SECRET`
  defaults to a placeholder that must be replaced.
