# 17. Password change and reset

- **Status:** Accepted
- **Recorded:** 2026-08-26

## Context

There was no way to change a password and no way to recover a forgotten one.
The account page said so out loud — "password changes aren't built yet" — which
was honest and also meant that anybody who suspected their account was
compromised had exactly one option available to them: nothing.

Two routes to the same destination, each proving something different. A change
proves you know the current password. A reset proves you control the inbox.
Both are usually triggered by the same worry, so both have to answer it.

The hard parts are not the forms. They are:

- what a reset endpoint reveals about which addresses have accounts
- whether the old sessions survive
- how long a link that *is* the account should live

## Decision

### Changing requires the current password

Even though the caller is already authenticated. Same reasoning as asking for
the password again before TOTP enrolment: a stolen session must not be enough to
take the account permanently. Without this, anyone holding a live cookie could
set their own password and lock the owner out for good.

Rate limited at 10 per 15 minutes, because a current-password check is a
password oracle for somebody holding a stolen session and guessing.

### Both routes end the other sessions

A password change is the standard response to "somebody else may be in my
account", and it is worthless if the intruder's session keeps working — they
would simply keep refreshing, and the owner would have locked out nobody.

A **change** keeps the caller's own session. Signing you out of the tab you are
using is a hostile response to good security hygiene.

A **reset** keeps none. There is no caller session to preserve, and if the
account was taken over then the intruder's is among the ones being revoked.

A change also burns any outstanding reset links. Somebody changing their
password because they suspect a compromise should not leave a working link in an
inbox the attacker may be reading.

### `/password/forgot` always answers identically

Registered address, unregistered address, malformed input, and rate-limited
request all return the same 200 with the same body.

Anything else makes this an account-enumeration oracle: feed it a list of
addresses, learn which have accounts here, and that list is precisely what a
credential-stuffing run wants. The rate-limit case matters too — a 429 would say
"this address is real and somebody keeps asking about it".

The UI had to be written to match. It says "if that address has an account, a
reset link is on its way", which reads slightly awkwardly and is the only
phrasing that does not leak.

### Reset links get one hour, not twenty-four

`EmailVerificationToken` lives a day. A verification link only proves an inbox
exists. A reset link **is the account** until it is used, so it gets an hour.

Only the hash is stored, like every other token here. A database leak must not
hand over working reset links for every account with one outstanding.

Asking again invalidates the previous unused link. Two live links means the
older one still works, and the older one is the more likely to have leaked —
forwarded mail, a shared screen, a scanner that follows URLs.

Unknown, expired and already-used tokens return one identical message. Telling
somebody a token is "expired" rather than "invalid" confirms it was real, which
is a small gift to anyone testing tokens they should not have.

### A reset does not sign you in

It sends you to the login page to type the password you just chose. Signing in
automatically would make a reset link a one-click login, and links leak. Typing
it once also confirms you know what you set.

### A reset verifies the email address

Redeeming the link proves control of the inbox, which is exactly what
verification asks for. Without this, somebody who signed up, never confirmed,
and later reset would be left unable to log in for a reason they had already
satisfied.

### A reset does NOT clear an admin's TOTP

Deliberately. Mail access must not be enough to strip a second factor — the
inbox is precisely where the reset link lands, so allowing it would make the
second factor decorative. Somebody who takes over an admin's email gets the
password and still cannot open the panel.

The consequence is that a lost authenticator remains a CLI problem
([ADR 0015](0015-admin-by-cli-grant-and-step-up.md)), which is the right place
for it.

## Consequences

**Changing a password does not kill a live admin session.** The admin cookie is
a separate 30-minute JWT with no revocation list, so it survives until it
expires. Exposure is bounded at half an hour and the holder already proved
password *and* TOTP to get it. Building token versioning to close a 30-minute
window on a route with one user would be disproportionate; this is written down
instead so the next person knows it was a decision.

**Other devices keep their access token until it expires.** Revocation kills the
*refresh* token, so a revoked session survives up to fifteen more minutes and
then cannot renew. That is what a short-lived bearer token means, and shortening
it further trades a real cost on every request for a marginal gain here.

**The forgot limiter is keyed by email, which outlives the account.** Deliberate:
deleting and recreating an account must not hand you a fresh allowance. It does
mean deterministic test addresses exhaust their budget across runs, which cost
an afternoon before the cause was understood — the test now uses a per-run
address.

**The reset limiter is a courtesy cap, not a guessing control.** Tokens are 256
bits, so the endpoint cannot be brute forced at any limit, and an invalid token
costs a hash and an indexed lookup before returning — no bcrypt, no breach-list
call. It was set at 20/hour per IP, which is tight enough to bite a corporate
NAT where many people share an egress address. Raised to 100 once that was
noticed.

## Alternatives considered

**Telling the user when an address is not registered.** Friendlier, and an
enumeration oracle. Rejected — the friendliness is worth less than the list.

**Signing the user in after a reset.** One fewer step, and it turns an emailed
link into a login. Rejected.

**Letting a reset clear TOTP so a lost authenticator is self-service.** Rejected
outright: it makes email access sufficient to defeat two-factor, which is the
one thing two-factor exists to prevent.

**Emailing a short code instead of a link.** Codes are easier to type on a phone
and much easier to brute force, needing their own attempt limiting to be safe. A
256-bit link needs none.

**Revoking all sessions on a change, including the caller's.** Simpler to
implement and reason about, and it punishes the user for doing the right thing.
Rejected.
