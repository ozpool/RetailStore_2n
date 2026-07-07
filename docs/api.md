# API Reference

Express API, default `http://localhost:4000`.

The browser does not call these directly. It calls the matching BFF path under
`/api/*` on the Next.js server, which forwards them
([ADR 0002](adr/0002-bff-proxy.md)). `POST /auth/login` in this document is
`POST /api/auth/login` from the browser.

---

## Conventions

**Auth.** Session state travels in two `httpOnly` cookies. Requests marked
🔒 need a valid access token; 🏪 additionally requires a seller profile;
👮 requires a *separate* short-lived admin session obtained by step-up, which
the ordinary login cookie does not grant — see [Admin](#admin--admin-).

**Errors.** Consistent JSON:

```json
{ "error": "Human-readable message.", "code": "MACHINE_CODE", "field": "priceCents" }
```

`field` appears when one input is at fault, so the UI can render the message
against that input. `code` is stable; `error` text is not.

| Status | Meaning here |
| --- | --- |
| 400 | Validation failed |
| 401 | No or expired session |
| 403 | Authenticated but not permitted (`NOT_A_SELLER`, `PAYOUTS_LOCKED`) |
| 404 | Not found — **also returned for records owned by someone else** |
| 409 | Conflict with current state (`ALREADY_VERIFIED`, `SESSION_CLOSED`) |
| 429 | Rate limited; includes `retryAfterSeconds` |
| 500 | Server error; details are logged, not returned |

**Money** is integer minor units (`priceCents`) in bodies. The one exception is
`/catalog/listings`, whose `minPrice`/`maxPrice` are whole currency units
because that is what a price filter collects.

---

## Health

### `GET /health`

```json
{ "status": "ok", "service": "retailstore-2n-backend" }
```

### `GET /health/lag`

Is anyone actually *receiving* notifications. Separate from `/health` because it
talks to a broker over the network, and a load balancer's liveness probe must
not depend on that.

**503 when unhealthy**, so a monitor does not have to parse a body to know.

```json
{
  "transport": "kafka",
  "healthy": true,
  "groups": [
    { "group": "email-worker", "lag": 0, "byTopic": {}, "uncommitted": 0 },
    { "group": "sms-worker", "lag": 140, "byTopic": { "retailstore-2n.notifications.v1": 140 }, "uncommitted": 30 }
  ],
  "dlqDepth": 0,
  "thresholds": { "lag": 5000, "dlq": 100 }
}
```

Lag covers **every rung of the retry ladder**, not just the main topic: a group
stalled on `retry.15m` is a real failure that main-topic lag reports as zero.

`uncommitted` is partitions the group has never committed. Their whole retained
backlog is counted in `lag` — because that is what the group still owes — but
the count is separate so "never started" stays distinguishable from "fallen
behind", which matters for the few seconds after a deploy.

On the inline transport it answers `{ "transport": "inline", "healthy": true,
"detail": … }`. **It does not alert.** There is no alerting stack here, and the
thresholds are returned so that whatever does alert need not encode them.

---

## Auth — `/auth`

### `POST /auth/signup`

```json
{ "name": "Ada Lovelace", "email": "ada@example.com", "password": "at least 12 chars" }
```

Password must be ≥ 12 characters and is checked against Pwned Passwords
([ADR 0004](adr/0004-password-policy.md)).

> **Email verification is currently switched off.** The account is created
> already verified and signed in: `201` → `{ "user": { ... } }`, sets both
> cookies, and no verification email is sent. The original code is commented
> out in `backend/src/routes/auth.ts`. The rest of this section describes the
> behaviour with verification on.

With verification on, no session is created — the account must be verified
first, and `201` → `{ "message": "...", "email": "ada@example.com" }`.

| Failure | Code | `field` |
| --- | --- | --- |
| Password too short | `INVALID_INPUT` | `password` |
| Password found in breach corpora | `PASSWORD_BREACHED` | `password` |
| Email already registered **and verified** | `EMAIL_IN_USE` | `email` |

Signing up again on an *unverified* email is not an error: it re-sends the link
and updates the stored password hash.

> Delivery is controlled by `MAIL_TRANSPORT` (nodemailer):
> `console` (default) prints the link to the backend terminal and sends nothing;
> `ethereal` really sends to a throwaway inbox and logs a URL where the rendered
> message can be read; `smtp` uses a real server and the process refuses to
> start unless `SMTP_HOST`, `SMTP_USER`, and `SMTP_PASS` are all set.
>
> A send failure does **not** fail the signup — the account and token are already
> committed, so a transient SMTP error would otherwise 500 an account that
> exists. It is logged loudly instead, and the recovery path is
> `POST /auth/resend-verification`.

### `POST /auth/verify-email`

```json
{ "token": "<from the emailed link>" }
```

Single-use, 24-hour expiry. `200` → `{ "user": { ... } }` and a session is
established.

### `POST /auth/resend-verification`

```json
{ "email": "ada@example.com" }
```

Always `200` — it does not reveal whether the address is registered.

### `POST /auth/login`

```json
{ "email": "ada@example.com", "password": "..." }
```

`200` → `{ "user": { ... } }`, sets both cookies.

| Status | Failure | Code |
| --- | --- | --- |
| 401 | Wrong email or password | `INVALID_CREDENTIALS` |
| 403 | Account suspended | `ACCOUNT_SUSPENDED` |
| 403 | Email not verified (only while verification is on) | `EMAIL_NOT_VERIFIED` |
| 429 | Too many attempts for this address | `RATE_LIMITED` |

With verification on, login is hard-blocked until verified — no partial session.
While it is switched off, an unverified account can log in.

**Rate limited to 10 attempts per 15 minutes per address**, and the counter is
cleared the moment a correct password is given, so ordinary mistyping never
accumulates. The 429 carries `retryAfterSeconds`.

The counter is keyed on the submitted address rather than on a user row, so an
address with no account throttles identically — a 429 says nothing about whether
the account exists. Same reason the 401 uses one message for a wrong address and
a wrong password.

There is deliberately **no per-IP limit** on this endpoint, unlike
`/auth/password/forgot`. See [SECURITY.md](../SECURITY.md#known-gaps) for why,
and for the denial-of-service the per-address limit knowingly accepts.

### `POST /auth/refresh`

Rotates the refresh token and issues a new access token. `204` with new
cookies.

Presenting an already-rotated token revokes the entire token family: reuse
means the credential leaked. → [ADR 0001](adr/0001-access-and-refresh-tokens.md)

**With one exception, for the ten seconds after rotation.** Access tokens expire
in batches, so several requests routinely retry with the same refresh cookie —
the only one the browser has. A token superseded that recently gets a new access
token and **no new refresh cookie**, leaving the one the winning request already
set. Rotation itself is an atomic claim, so exactly one of N concurrent requests
rotates however many arrive together.

Tokens revoked by logout or a password change are never graced, and outside the
window a replay still revokes everything.
→ [ADR 0021](adr/0021-refresh-race-grace-window.md)

### `POST /auth/logout`

Revokes the refresh token and clears cookies. `204`.

### `GET /auth/me` 🔒

```json
{ "user": { "id": "…", "name": "Ada Lovelace", "email": "ada@example.com",
            "isSeller": false, "emailVerified": true, "createdAt": "…" } }
```

