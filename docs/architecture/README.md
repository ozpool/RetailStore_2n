# Architecture

RetailStore_2n is a four-container system in its default setup: a Next.js server, an
Express API, PostgreSQL, and Redis. Object storage joins them for photos, and
four more services are opt-in behind two Compose profiles — a streaming
Postgres standby (`ha`), and a Kafka broker with its relay and its channel
workers (`messaging`). A third profile, `tools`, holds one-shot jobs rather than
services: seeding, base backups and the restore drill. The browser talks only to
Next.js.

```mermaid
flowchart LR
    B["Browser"]
    N["Next.js server<br/>(UI + BFF)"]
    E["Express API"]
    P[("PostgreSQL<br/><i>source of truth</i>")]
    R[("Redis<br/><i>safe to lose</i>")]
    S[("Standby<br/><i>opt-in, read-only</i>")]
    F[["Object storage<br/><i>photos, read by the browser</i>"]]
    K[/"Kafka<br/><i>opt-in, safe to lose</i>"/]
    W["Channel workers<br/><i>email, push, SMS</i>"]

    B -->|HTTPS, session cookies| N
    N -->|"server-to-server<br/>cookies relayed"| E
    E --> P
    E -.->|"counters, cache"| R
    E --> F
    B -.->|"img src only"| F
    P ==>|"streams WAL"| S
    P -.->|"relay publishes<br/>committed outbox rows"| K
    K -.-> W
    W --> P
```

The dotted lines are the point: pull Redis out and the site is slower and still
correct; pull Kafka out and notifications queue in the outbox until it returns.
Neither holds anything that must survive a restart — which is why the workers
write their results *back* to Postgres rather than treating the broker as a
record.

Nothing points *at* the standby, and that is also the point. It is a spare
primary, not a read replica — see
[ADR 0020](../adr/0020-replication-and-backups.md).

Documentation is split by the level of detail you need, following the
[C4 model](https://c4model.com)'s idea of separate diagrams for separate
audiences:

| Level | Document | Answers |
| --- | --- | --- |
| Context + Container | [hld.md](hld.md) | What are the moving parts, and how does a request flow through them? |
| Component + Code | [lld.md](lld.md) | What is each module responsible for, and how do the tricky flows actually work? |
| Data | [data-model.md](data-model.md) | What is stored, and what are the invariants? |
| Interface | [../api.md](../api.md) | What endpoints exist? |
| Rationale | [../adr/](../adr/README.md) | Why is it like this and not otherwise? |

## The seven ideas that explain most of the code

1. **The Next.js server is the only thing the browser trusts.** Every API call
   goes through a BFF route handler, so the Express address is never exposed
   and there is no CORS story on the client.
   → [ADR 0002](../adr/0002-bff-proxy.md)

2. **Selling is a capability, not an account type.** One `User` row; a
   `SellerProfile` appears when they start selling.
   → [ADR 0003](../adr/0003-unified-account.md)

3. **Money is integers.** `priceCents`, never a float, from the database to the
   HTTP boundary. Formatting happens in the UI only.
   → [ADR 0005](../adr/0005-money-as-integer-minor-units.md)

4. **Identity documents are never stored.** Verification is delegated; we keep
   a reference to the outcome and nothing else.
   → [ADR 0006](../adr/0006-kyc-store-reference-not-document.md)

5. **Displayed facts trace to rows.** Ratings are aggregated from `Review`
   records rather than stored as a number, so a rating always corresponds to
   reviews that exist.
   → [ADR 0009](../adr/0009-computed-ratings.md)

6. **Postgres is the only source of truth.** Anything that must be correct
   under concurrency arbitrates there — stock under a row lock, the payment
   claim, refund headroom, TOTP replay. Redis holds only counters that expire
   and copies that can be rebuilt, so losing it costs latency and never data.
   → [ADR 0018](../adr/0018-redis-for-shared-ephemeral-state.md)

7. **Claim it in the database before you act on the world.** Every irreversible
   outside call — charging a card, issuing a refund, sending a notification,
   transferring a payout — is preceded by a write that only one caller can win.
   The mechanism varies with the shape of the thing: `SELECT … FOR UPDATE` for
   stock, a conditional `UPDATE` for the payment claim and refund headroom, a
   unique-constraint insert for the delivery ledger and payout items. The point
   is always the same: two concurrent attempts must collide in Postgres, where
   it is free to lose, rather than at a provider, where it costs money.
   → [ADR 0013](../adr/0013-payment-provider-seam.md),
   [ADR 0016](../adr/0016-refunds-claim-then-refund.md),
   [ADR 0026](../adr/0026-delivery-idempotency.md),
   [ADR 0030](../adr/0030-payout-eligibility-and-hold.md)
