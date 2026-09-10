# 27. Consent before delivery: verified numbers, per-type preferences, unsubscribe

- **Status:** Accepted — implemented in phases 2-4 of
  [plan 0001](../plans/0001-multi-channel-notifications.md). Preferences and
  unsubscribe landed with email; `phone`, `phoneVerifiedAt`, `smsConsentAt` and
  `PhoneVerification` landed with SMS.
- **Recorded:** 2026-09-04

## Context

`lib/mailer.ts` has worked since email verification was built. Nothing has ever
used it to send a notification. `lib/notifications.ts` says why, at the top of
the file:

> Email delivery exists now (lib/mailer.ts), and nothing here uses it. Mailing
> every sale, shipment, and moderation decision needs per-type preferences and
> an unsubscribe path first — without those it is the reason someone filters
> this domain to spam, and then they stop seeing the ones that matter.

That is the whole context. The transport was never the blocker. Consent was, and
the two channels being added now raise the stakes rather than lower them.

**Email** has a deliverability consequence. A domain that sends mail people did
not ask for gets filtered, and the filtering does not distinguish "your item
sold" from "a refund of $32 has been issued". Losing the second to protect
against the first is a bad trade made automatically by somebody else's spam
classifier.

**SMS** has a legal one. Sending an automated message to a number without
recorded consent is unlawful in most of the jurisdictions this would operate in,
and the platform — not the seller, not the buyer — is the sender.

And there is a trap sitting in the schema. `Address.phone` exists and looks like
a phone number for the user. It is not one. It is a delivery contact for a
parcel, typed into a checkout form with no verification of any kind, and it is
frequently a *third party's* number: a gift going to a friend, a delivery to a
workplace reception, an elderly relative's landline. Nothing distinguishes those
cases from the account holder's own mobile.

## Decision

Nothing is sent to any channel without a recorded basis for sending it.

### SMS requires a verified number and a consent timestamp

Three columns on `User` — `phone`, `phoneVerifiedAt`, `smsConsentAt` — and a
`PhoneVerification` table that mirrors `EmailVerificationToken` deliberately:
hashed, single-use, short expiry.

Shorter expiry than email's, because the threat model differs. An email
verification link needs an inbox. An SMS code is six digits that appear on a lock
screen, readable by anyone holding the phone, so it lives for minutes rather than
hours.

**`Address.phone` is never used for messaging.** Not as a fallback, not as a
default value in the phone field, not as a suggestion in the UI. Copying it into
the contact field would launder an unverified third-party number into a verified
one the moment the user pressed save without reading.

Both the send and the verify endpoints are rate-limited through
`lib/rateLimit.ts`. Send, because an unlimited send endpoint is a way to bill
this platform for texting an arbitrary number repeatedly. Verify, because an
unlimited verify endpoint is a six-digit oracle — the same reasoning that puts
`admin-stepup` at 8 per fifteen minutes in
[ADR 0018](0018-redis-for-shared-ephemeral-state.md).

### Preferences store deviations, not state

`NotificationPreference` is unique on `(userId, type, channel)` and holds only
explicit choices. **An absent row means "use the default for this type."**

The alternative — a row per user per type per channel, created at signup —
requires a backfill across every user before a new `NotificationType` can be sent
at all, and produces 11 × 3 rows per account to express "they never touched the
settings page". Resolution is: explicit row, else the channel policy table.

### Per type and per channel, not per channel alone

A single "email me" switch is too coarse in a way that matters. Somebody who
finds review notifications noisy would turn email off, and that same switch is
what carries `REFUND_ISSUED`. The setting that solves a minor annoyance would
silently disable the notice about their money.

### One-click unsubscribe, without a login

Every email carries a signed unsubscribe token and the `List-Unsubscribe` and
`List-Unsubscribe-Post` headers. The link works without signing in — an
unsubscribe that requires a password is an unsubscribe most people replace with
the spam button, which is worse for deliverability than the mail they were
objecting to.

The token scopes to one `(user, type)` pair by default, with an "all optional
email" option on the landing page. It never disables in-app notifications,
because those are the record rather than a delivery.

### Quiet hours are SMS-only, and defer rather than drop

Email and push are silent by nature. A text at 3am is not. A message suppressed
for quiet hours is deferred to the window opening, not discarded, and the
deferral is recorded as `SUPPRESSED` in the delivery ledger per
[ADR 0026](0026-delivery-idempotency.md).

### In-app is unconditional

Preferences govern delivery. `Notification` is the record, and it is written
regardless — the schema comment already commits to that table remaining the
source of truth, and a preference that could erase the record would break it.

## Consequences

**There is no timezone to evaluate quiet hours against.** `User` has no timezone
column and `Address.country` is the closest thing, which is both crude — a
country can span several zones — and wrong in the common case where the delivery
address is not where the user is. This is a genuine gap in the decision, not an
implementation detail: Phase 4 has to either collect a timezone or state a fixed
policy and accept it will be wrong for some people. Recorded rather than
discovered.

**Changing a default changes what existing users receive.** Because absent means
default, editing the channel policy table retroactively alters the settings of
every user who never expressed a preference, which is nearly all of them.
Loosening a default is therefore a product decision with an audience, not a
config change, and tightening one is safe. Anyone editing that table should read
this paragraph first.

**Two verification flows to keep honest.** Email and phone now both have a
send/verify pair with hashing, expiry, single use, and rate limits on both ends.
They are separate code paths with the same rules, and the second one will drift
from the first unless the suite covers both.

**Suppression makes the ledger the only complete picture.** "Did they get told?"
becomes a question about `NotificationDelivery`, not about `Notification`, which
is why surfacing that ledger in the admin panel is Phase 6 work rather than
optional polish.

**Nothing here is marketing, and this record does not open a door to it.** The
`NotificationType` enum comment states that every value is something that
actually happened to the recipient. A promotional channel would need its own
consent basis, its own storage, and its own record — it does not inherit this one.

## Alternatives considered

**Use `Address.phone`.** Ships SMS in a day with no verification flow and no new
columns. Rejected: it sends account notifications to people who never consented
and cannot unsubscribe, it is unlawful in most relevant jurisdictions, and it
would expose order details — an item title, a refund amount — to whoever holds a
number typed into a checkout form. Same reasoning as
[ADR 0006](0006-kyc-store-reference-not-document.md): the shortcut creates a
liability far larger than the work it avoids.

**One boolean per channel on `User`.** Three columns, no join, trivially fast.
Rejected on the coarseness above — the switch someone flips to stop review
notifications is the switch that carries their refund notice.

**Opt-in for everything, defaulting to off.** The most conservative reading of
consent, and it is wrong for transactional messages. A buyer who gave an email
address to receive an order expects to hear about that order; making them find a
settings page first means the refund notice does not arrive. Transactional
messages about a transaction the person initiated default on. `SALE_MADE` over
SMS — a standing subscription to future events rather than a message about a
completed one — defaults off, which is the line this table draws.

**Preferences in Redis for fast reads.** Rejected on
[ADR 0018](0018-redis-for-shared-ephemeral-state.md)'s line, and more sharply
than usual: a consent record that evaporates on restart would fail open, and
failing open here means messaging people who opted out. Preferences are read once
per delivery by a background worker, so the read cost is not on any request path
and there is nothing to optimise.

**A third-party preference centre.** Several ESPs offer one. Rejected because it
splits the answer to "may we message this person?" across two systems, and the
one holding the veto would not be the one holding the audit trail.
