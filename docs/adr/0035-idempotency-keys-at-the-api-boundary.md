# 35. Idempotency keys at the API boundary, claimed before the handler runs

- **Status:** Proposed — in progress on `feat/http_idempotency_keys`, not yet
  merged. `idempotency_keys`, `lib/idempotency.ts` and
  `middleware/idempotent.ts`; the `@@unique([userId, key])` constraint is the
  guard.
- **Recorded:** 2026-10-01

## Context

Every money-moving call this API makes to a provider already carries an
idempotency key — `intentKey(order.id)` and `confirmKey(order.id)` for payments
([ADR 0013](0013-payment-provider-seam.md)), the payout id for transfers
([ADR 0029](0029-payouts-separate-transfers-not-destination-charges.md)). So a
request this server *sends* can be retried safely.

A request this server *receives* cannot. The case that matters is ordinary: a
phone on a train submits checkout, the server creates the order, and the
response is lost on the way back. The client cannot tell "never arrived" from
"arrived and the answer was lost", so it does the only reasonable thing and
retries. What happens next depends on the endpoint:

| Endpoint | What a retry does today |
| --- | --- |
| `POST /reservations` | Fails or holds a second unit, depending on stock |
| `POST /orders` | Fails — the holds were already consumed by the first order, which the client never learned the id of |
| `POST /orders/:id/pay` | `409 ALREADY_PAID` or `PAYMENT_IN_PROGRESS` — safe, but the client cannot tell whether *its* attempt succeeded |
| `POST /orders/items/:itemId/return` | `409` — the return exists, the client does not know its id or deadline |

None of these double-charges anybody. The claim-then-act guards from ADR 0013
and [ADR 0016](0016-refunds-claim-then-refund.md) already make the dangerous
repeats impossible. What they cannot do is **give the retrying client the
answer to its first request**, and an answer the client never receives is, from
the buyer's side, a checkout that failed after it worked.

## Decision

Accept an optional **`Idempotency-Key`** request header on the endpoints above.
The first request with a given key runs; every later request with the same key
gets the first one's stored response back, marked `Idempotent-Replayed: true`.

The mechanism is the one this codebase already trusts — **claim before acting**,
the same shape as the delivery ledger in
[ADR 0026](0026-delivery-idempotency.md):

1. **Claim.** `INSERT ... ON CONFLICT ("userId", "key") DO NOTHING` a row in
   `IN_PROGRESS`. The unique constraint, not a read-then-write check, decides
   which of two concurrent requests runs the handler.
2. **Act.** Only the winner reaches the route handler.
3. **Record, then respond.** The response body and status are written to the
   row **before** the response is sent, so a client that has seen an answer can
   never retry into an `IN_PROGRESS` row for the same request.

A request that finds an existing row is answered from it:

| Row found | Answer |
| --- | --- |
| `COMPLETED`, same request | The stored status and body, `Idempotent-Replayed: true` |
| Same key, different method, path or body | `422 IDEMPOTENCY_KEY_REUSED` |
| `IN_PROGRESS`, lock still held | `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After` |
| `IN_PROGRESS`, lock expired | Taken over by a conditional `UPDATE`, then run |

**Keys are scoped to the user.** `(userId, key)` is unique, not `key` alone, so
one account cannot read another's stored response by guessing or reusing a key
string, and two clients that happen to pick the same UUID never collide.

**A key is bound to its request.** The row stores a SHA-256 of the method, the
concrete path and a canonical (key-sorted) JSON of the body. Reusing a key for a
different request is a client bug, and answering it with someone else's
response — even the same user's — would hide that bug behind a plausible lie.

**What gets stored.** Every outcome below 500 except 429. A `409 ALREADY_PAID`
or a `400` is a real, deterministic answer and is replayed like a `201`. A 5xx
and a 429 are released instead: the first is the server failing rather than
answering, the second says "not now", and replaying either would turn a
transient condition into a permanent one for that key.

**Retention: 24 hours.** Long enough to cover any client's retry loop; short
enough that `idempotency_keys` cannot grow without bound. A sweeper deletes
older rows on the same pattern as the other six, and a key past retention is
treated as unused.

## Consequences

- **The existing guards stay, and stay load-bearing.** The middleware is a
  replay layer, not a concurrency control. A claim whose lock expires while its
  handler is still running (two minutes) can be taken over and the handler run
  a second time; `claimOrderForPayment`, the reservation row lock and the return
  request's unique constraint are what keep that second run harmless. Nothing in
  `lib/orders.ts`, `lib/reservations.ts` or `lib/returns.ts` changes.
- **The header is optional.** Without it every endpoint behaves exactly as
  before, so no existing client breaks.
- **The BFF does not forward the header yet.** `frontend/src/lib/backendProxy.ts`
  passes `cookie` and `content-type` only, so for now the feature serves direct
  API clients. Forwarding it is a one-line frontend change, deliberately left out
  of this backend-only work.
- **A stored response is a snapshot.** Replaying `POST /orders` returns the order
  as it was when created, not its current state — the client should `GET` the
  order for that, exactly as it would after a first response.
- **Bookkeeping never fails a request.** If writing the result fails, the
  response is still sent and the row stays `IN_PROGRESS` until its lock expires.
  The cost is a retry that runs the handler again, which the guards above make
  safe.

## Alternatives considered

- **Redis instead of Postgres.** The rest of the shared ephemeral state lives in
  Redis ([ADR 0018](0018-redis-for-shared-ephemeral-state.md)), but this is not
  ephemeral in the same sense: a rate-limit counter lost in a Redis restart is a
  slightly generous limit, while a lost idempotency claim is a handler run
  twice. It needs the same durability as the order it protects.
- **Derive the key from the request body.** Two genuinely separate purchases of
  the same item with the same address would collide. Only the client knows
  whether two identical requests are one intention or two.
- **Make every endpoint naturally idempotent instead.** `POST /orders` would need
  a client-supplied id, which is an idempotency key under another name, spread
  across every create endpoint rather than in one place.
- **Global keys, not per user.** Simpler index, and a cross-account information
  leak the moment two users pick the same string.
