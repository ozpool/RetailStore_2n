# 15. Admin by CLI grant and step-up authentication

- **Status:** Accepted
- **Recorded:** 2026-08-25

## Context

Moderation needs someone who can remove a listing, suspend an account, and see
the whole catalogue and every order. That is a large amount of power, and the
question was how an account comes to hold it.

The tempting design is a `role` column and an endpoint to set it — an admin can
promote another admin from the panel. It is easy to build and it is how a lot
of small projects do it.

It is also a single point of total failure. That endpoint is reachable from the
internet, it is guarded by the same session cookie that guards adding something
to a wishlist, and anyone who reaches it once can grant themselves permanent
access and then lock everyone else out. The blast radius of one stolen cookie
becomes the entire site.

A second, quieter problem: the ordinary login session is long-lived by design,
because being logged out while shopping is miserable. That is the right trade
for a shopping cookie and the wrong one for a cookie that can delete other
people's work.

## Decision

### `role: ADMIN` is granted only by CLI

`npm run admin:grant <email>` — a script that talks to the database directly.
**There is no promotion endpoint, and adding one would defeat the arrangement.**

The property this buys is precise: granting admin requires shell access to the
server. Someone who fully compromises a browser session gets whatever that
account could already do — they cannot escalate to admin, because no reachable
code path grants it.

This is **not** security by obscurity. The repository is public; the mechanism
is documented in this file and in `docs/api.md`. It is secure because the
capability does not exist over HTTP, not because an attacker cannot find out
how it works. Anything relying on an attacker's ignorance would fail the moment
someone read the source, which they can.

### Being an admin is not the same as being in the admin panel

Opening the panel needs a **step-up**: the password again, plus a code from an
authenticator app. That mints a **separate** cookie — `retailstore_2n_admin`, its own
secret, **30 minutes**.

The secret is *derived* from `JWT_SECRET` via HMAC rather than configured
separately. Separate, so an ordinary access token can never be replayed as an
admin token even if the signing code is later confused. Derived, so there is no
second environment variable to forget — a missing admin secret that silently
fell back to the main one would be worse than no separation at all.

Two attacks close here:

- **A stolen shopping cookie.** It carries no admin rights. The thief must also
  have the password and the second factor.
- **A compromised email inbox.** Password reset gets an attacker the password;
  it does not get them the TOTP secret.

### TOTP, not SMS

Text messages can be redirected by taking over someone's phone number, and that
is a real, routine attack against exactly this kind of account. TOTP also needs
no mail or SMS provider, which matters because this project does not yet have a
working mailer — an SMS second factor would have been a second thing to build
before the first one worked.

Enrolment is stored **unconfirmed** until a code proves the authenticator app
actually holds the secret. A half-finished enrolment that counted would lock
the account out of its own panel.

### Each code works once

Allowing one 30-second step either side for clock drift means a valid code spans
about 90 seconds. Left there, the same six digits keep working for that whole
window — so a code read over a shoulder, or relayed by a proxy that phishes it,
can be spent a second time by somebody else. The rate limit does not help: a
single replay is one attempt.

`User.totpLastUsedAt` stores the period whose code was last accepted, and
anything from that period or earlier is refused. The period start is recorded
rather than the moment of use, because two codes from one period *are* the same
code and must compare equal.

Spending it is an atomic conditional UPDATE — the same technique as claiming an
order for payment ([ADR 0013](0013-payment-provider-seam.md)). Read-then-write
would let two requests carrying one code both pass the check before either
wrote. It is a smaller version of the same race that produced five charges for
one order, and it deserves the same answer.

Enrolment spends a code too. Otherwise the code typed to finish setup stays live
and can be replayed against the step-up endpoint moments later — the exact
attack, reached through the one door that was not watching for it.

### Every action carries a written reason

`ModerationAction` is append-only, mirroring how `KycAttempt` is retained. Each
row records who acted, on what, why, and which report it came from. The reason
is required — 3 to 1000 characters — and is shown verbatim to the person
affected.

Two reasons, and the second is the one that mattered. An audit row reading only
"suspended by sam" is useless six months later when someone asks why. And
somebody whose listing disappeared is owed an explanation; making the moderator
type one is the only reliable way to ensure there is one.

## Consequences

**Revocation is immediate.** `requireAdmin` re-reads the role from the database
on every request rather than trusting the token's claim, so
`npm run admin:revoke` takes effect on the next request instead of when a
30-minute token happens to expire. That is one extra query per admin request —
a trivially small price on a route nobody hits at volume.

**The first sign-in after enrolling needs the next code.** Finishing setup spends
one, so the digits the app is still showing will be refused. Correct, and
baffling if unexplained — the sign-in screen says so explicitly rather than
letting someone conclude their brand-new authenticator is broken.

**Losing the authenticator locks you out.** There are no recovery codes. The
recovery path is the CLI: revoke and re-grant, which clears the enrolment. This
is acceptable precisely *because* CLI access is the root of the whole scheme
already — it adds no new trust. It would not be acceptable if the panel were
the only way in.

**The panel denies its own existence.** A non-admin at `/admin` gets "Not
found", not "you are not an admin", and no sign-in form to probe. This is a
small thing and it is not load-bearing; the security comes from the two gates
above. It costs one branch and denies a free confirmation.

**Two gates mean two chances to get it wrong.** The regression suites
(`api/admin.ts`, `browser/admin-and-notifications.ts`,
`browser/admin-dashboard.ts`) assert the negatives explicitly: password alone
is refused, code alone is refused, an unconfirmed enrolment does not count,
both failures return the *same* message so the endpoint is not an oracle, and a
second browser session does not inherit the admin cookie.

## Alternatives considered

**A separate admin application on its own host.** What a larger organisation
does, and it isolates properly. Rejected as disproportionate: a second
deployment, a second auth system, and a second thing to keep patched, for a
site with one moderator.

**IP allowlisting.** Rejected. It breaks entirely when the moderator is not at
a known address, which for a project maintained from a laptop is most of the
time, and it protects nothing that the second factor does not already protect
better.

**A permissions matrix with several admin tiers.** Rejected as premature. There
is one moderator. `UserRole` is an enum, so adding `MODERATOR` beneath `ADMIN`
later is a migration and a middleware check, not a redesign. Building the
hierarchy before there is anyone to put in it would be inventing constraints to
maintain.
