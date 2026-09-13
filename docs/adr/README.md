# Architecture Decision Records

Each file records one decision that was not obvious, together with the
alternatives that were rejected and why. The point is that a future reader —
including a future me — can tell the difference between a deliberate choice and
an accident, and knows what would have to change for the decision to be
revisited.

Format follows [Michael Nygard's template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
Records are immutable: a decision that changes gets a new record that supersedes
the old one, rather than an edit.

> These were written retroactively, in one pass, after the features they
> describe were built. The decisions and their reasoning are real — the
> *documents* were not written at decision time, so treat the dates as "recorded
> on" rather than "decided on".

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-access-and-refresh-tokens.md) | Access + rotating refresh tokens with reuse detection | Accepted |
| [0002](0002-bff-proxy.md) | Next.js as a BFF instead of direct browser→API calls | Accepted |
| [0003](0003-unified-account.md) | One account type; selling is a capability | Accepted |
| [0004](0004-password-policy.md) | Length + breach check instead of composition rules | Accepted |
| [0005](0005-money-as-integer-minor-units.md) | Money as integer minor units | Accepted |
| [0006](0006-kyc-store-reference-not-document.md) | Store a verification reference, never the document | Accepted |
| [0007](0007-verification-gates-payouts.md) | Verification gates payouts, not listing creation | Accepted |
| [0008](0008-soft-delete-and-listing-status.md) | Soft delete plus a status enum, not a stock count | Accepted |
| [0009](0009-computed-ratings.md) | Compute ratings from review rows | Accepted |
| [0010](0010-strip-image-metadata.md) | Re-encode uploads to strip EXIF | Accepted |
| [0011](0011-avatars-in-object-storage.md) | Avatars in object storage, referenced by URL | Accepted |
| [0012](0012-row-locking-for-reservations.md) | Row-level locking for stock reservations | Accepted |
| [0013](0013-payment-provider-seam.md) | Payment provider seam; claim-then-charge over a distributed lock | Accepted |
| [0014](0014-one-order-fulfilment-per-line.md) | One order per basket, fulfilment per line; addresses snapshotted | Accepted |
| [0015](0015-admin-by-cli-grant-and-step-up.md) | Admin granted only by CLI; step-up with TOTP to open the panel | Accepted |
| [0016](0016-refunds-claim-then-refund.md) | Refunds: claim headroom atomically, then refund; per line, append-only | Accepted |
| [0017](0017-password-change-and-reset.md) | Password change and reset; no enumeration, sessions revoked, TOTP survives | Accepted |
| [0018](0018-redis-for-shared-ephemeral-state.md) | Redis for rate-limit counters; shared ephemeral state only, never a source of truth | Accepted |
| [0019](0019-cache-tiering-rule.md) | A tiering rule for what may be cached; amends 0018, which rejected caching | Accepted |
| [0020](0020-replication-and-backups.md) | A streaming standby for availability, and point-in-time recovery to object storage | Accepted |
| [0021](0021-refresh-race-grace-window.md) | Concurrent refresh handled by a grace window in Postgres, not a Redis lock | Accepted |
| [0022](0022-object-storage-for-uploads.md) | Object storage for uploads; the last thing blocking a second replica | Accepted |
| [0023](0023-one-dockerfile-many-targets.md) | One Dockerfile with a target per image; the all-in-one was built and removed | Accepted |
| [0024](0024-outbox-not-dual-writes.md) | Transactional outbox, not dual writes | Accepted |
| [0025](0025-kafka-topics-and-partitioning.md) | One topic keyed by user, consumer groups as fan-out, retries on delay topics | Accepted |
| [0026](0026-delivery-idempotency.md) | A delivery ledger, claimed before the provider is called | Accepted |
| [0027](0027-notification-consent-and-preferences.md) | Consent before delivery: verified numbers, per-type preferences, unsubscribe | Accepted |
| [0028](0028-sms-provider-twilio-behind-a-seam.md) | Twilio for SMS, behind the same seam as payments and identity | Accepted |
| [0029](0029-payouts-separate-transfers-not-destination-charges.md) | Pay sellers with separate transfers, not destination charges | Accepted |
| [0030](0030-payout-eligibility-and-hold.md) | What makes money payable, and the ledger that stops it being paid twice | Accepted |
| [0031](0031-buyer-initiated-returns.md) | Buyer-initiated returns, as a request the seller answers | Accepted |
| [0032](0032-kubernetes-manifests.md) | Kubernetes: an operator for Postgres, plain manifests for everything else | Accepted |
| [0033](0033-seller-admin-messaging.md) | Seller–admin messaging, as threads with a role on one side | Accepted |
| [0034](0034-paid-homepage-placement.md) | Paid homepage placement, recorded as an agreement and labelled as an ad | Accepted |

> **All thirty-two are implemented.** 0024 and 0025 landed with phase 1 of
> [plan 0001](../plans/0001-multi-channel-notifications.md), 0026 and 0027 with
> phases 2-4, and 0028 with phase 4. 0029 and 0030 were Proposed for one day and
> landed with [plan 0002](../plans/0002-seller-payouts.md), and 0031 with
> [plan 0003](../plans/0003-buyer-returns.md) the following day — it is the
> entry point the refund machinery had been missing since 0016. 0032 landed with
> [plan 0004](../plans/0004-kubernetes.md), and is the one whose claims are
> verified on kind rather than on a real cluster.
>
> **Accepted is not the same as proven against a provider.** The payout path in
> 0029 and 0030 is exercised end to end under `PAYOUT_PROVIDER=stub` and nothing
> more: no connected account has been created and no transfer has been issued.
> Two questions in those records are business decisions still open — who absorbs
> Connect's fees on a platform taking no cut, and whether seven days is the right
> hold. Neither blocks the code, and both could change the numbers.

## Adding one

Copy the structure of any existing record, take the next number, and add a row
above. Worth recording when: the choice has more than one defensible answer, it
is expensive to reverse, or someone would otherwise be tempted to "fix" it.
