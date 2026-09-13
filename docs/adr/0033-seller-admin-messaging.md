# 33. Seller–admin messaging, as threads with a role on one side

- **Status:** Accepted — `lib/messaging.ts` implemented 2026-09-11, covered by
  `tests/api/messaging.ts` (38 assertions). Routes and UI are phases 4 and 6 of
  [plan 0005](../plans/0005-placement-and-messaging.md).
- **Recorded:** 2026-09-11

## Context

There is no way for a seller and the platform to talk to each other.

Everything the application says to a seller today is a *notification*: a
one-way, templated, per-event message with no reply path
([ADR 0027](0027-notification-consent.md)). Eleven event types, three channels,
and not one of them accepts an answer. When a seller needs to ask something —
why a listing was removed, whether an order can be cancelled, what it would
take to appear on the homepage — the honest answer today is "email an address
that does not exist".

Two things make this worth building now rather than later:

- [ADR 0034](0034-paid-homepage-placement.md) needs somewhere for a negotiation
  to happen. A placement request that can be countered is a conversation, and
  without a thread to carry it the counter-offer has nowhere to live.
- Moderation is already two-way in every respect except this one. A moderator
  can remove a listing, suspend an account, refuse an escalated return — each
  of those writes a `moderation_actions` row with a note the seller never sees.

## Decision

### A thread has a seller on one side and a ROLE on the other

`MessageThread.sellerId` names the seller. The other participant is not a user
id — it is "whichever moderator is reading". Each `Message` records
`author: SELLER | ADMIN` plus the `authorUserId` that wrote it, for audit.

**Rejected: a participants table, or a second user id on the thread.** Both
model the admin side as a *person*, and it is not one. Moderation is a shift,
not an assignment: the moderator who answers on Tuesday is not the one who
answers on Thursday, and a thread owned by a specific admin becomes unanswerable
the moment that account is suspended or revoked. Naming the role keeps the
thread readable by whoever currently holds it, which is exactly how the admin
panel already treats every other moderation surface.

`authorUserId` carries **no foreign key**, the same decision and the same
reasoning as `notification_deliveries` ([ADR 0026](0026-delivery-ledger.md)):
"an admin who has since been deleted wrote this" must remain a true and
answerable statement, and a cascade would erase the audit trail that the
moderation log exists to keep.

### Unread is two counters on the thread, not a read-receipt table

`sellerUnread` and `adminUnread` are integers on `MessageThread`, incremented
in the same transaction as the message insert and zeroed when that side opens
the thread.

**Rejected: a `MessageRead` row per message per reader.** That is the correct
shape for a group chat and the wrong one here. There are exactly two sides, one
of which is a role shared by every moderator, so "has the admin side read this"
is a single fact rather than a set of facts. The per-message table would store a
row for each of N moderators to answer a question the product never asks, and
the count the UI actually needs would become an aggregate over it.

The cost is honest and accepted: **two moderators reading the same thread cannot
be distinguished**, and the first to open it clears the badge for all of them.
That is the same trade the admin panel already makes everywhere else.

### A seller writing reaches EVERY live moderator

Decided while implementing, because "the admin side is a role" does not by
itself say who gets the notification. A notification needs a `userId`, and there
is no admin user id on the thread to use.

So a seller's message raises one notification and one outbox event per
non-suspended `ADMIN`. **Rejected: notifying one arbitrary moderator**, which
works perfectly until the person it picked is on holiday, and whose failure mode
is a thread nobody knows about. **Rejected: a nullable recipient**, which is the
same thing as having no notification.

Suspended admins are excluded, for the reason `ACCOUNT_SUSPENDED` has no push
channel: a notification whose link leads to a login screen that refuses you is
worse than silence.

The cost is that N moderators produce N events for one message. At this scale
that is a handful of rows; at a scale where it is not, the answer is a single
"moderators" recipient with its own delivery preferences, which is a different
decision record.

### Messages are notified through the existing pipeline, not a new one

A new message raises a `MESSAGE_RECEIVED` notification event, which goes into
the outbox in the same transaction as the message
([ADR 0024](0024-transactional-outbox.md)) and reaches the recipient on whatever
channels they have consented to.

**Rejected: WebSockets, or polling for live chat.** The application has no
realtime transport and adding one for this is a large amount of new surface —
connection auth, fan-out across API replicas, reconnection — to make a
low-frequency, asynchronous conversation feel synchronous. A seller asking about
homepage placement does not need sub-second delivery; they need to know a reply
arrived, which the notification pipeline already does across three channels.

**Rejected: replying by email.** Inbound mail means an address, a parser, spoof
handling, and quoted-reply stripping. The seams are outbound only
([ADR 0028](0028-twilio-sms.md)) and this would be the first inbound one.

### Seller ↔ admin only

No buyer ↔ seller messaging.

**Rejected: order-scoped buyer–seller conversations.** It sounds like the same
feature and is a much larger one. Two strangers talking about a transaction
needs abuse reporting, blocking, and contact-detail scrubbing — the last of
these because a marketplace whose members can swap phone numbers has invented a
way to take the transaction off-platform, which means outside the refund and
return guarantees the rest of this repository exists to provide. It also
overlaps the returns flow, which already carries a buyer's reason and a seller's
note on the request itself ([ADR 0031](0031-buyer-initiated-returns.md)).

## Consequences

**The notification catalogue grows from eleven event types to thirteen**
(`MESSAGE_RECEIVED` here, `PLACEMENT_DECIDED` in ADR 0034). Every counted claim
of "eleven" in the README, `docs/api.md`, `docs/architecture/lld.md` and the
published architecture reference has to move with it, or the repository starts
lying about its own size.

**A thread is not a support queue.** There is no assignment, no SLA, no status
beyond open and closed. If this grows into real support tooling, that is a
different decision record.

**Nothing is rate-limited by default except opening threads.** Messages within
an existing thread are capped per hour per author, on the same reasoning as
return requests: each one is a message a human has to read. The cap lives in the
routes, where every other rate limit in this codebase lives — not in
`lib/messaging`, which is called by the placement library too and must not
refuse a system-generated message.

**`lib/messaging` does not use `notify()`**, and that is a deliberate departure
from every other caller in the codebase. `notify()` opens its own transaction
and swallows its own errors so that failing to announce a sale cannot roll back
the sale. Here the message *is* the thing being announced: a message nobody was
told about leaves a seller waiting for a reply the moderator queue never showed.
So the message, the unread counters, the notification rows and the outbox events
commit together, and a failure propagates to the caller.
