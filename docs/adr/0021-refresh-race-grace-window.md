# 21. A grace window for concurrent refresh, not a distributed lock

- **Status:** Accepted
- **Recorded:** 2026-09-02
- **Closes:** the outstanding item in [ADR 0018](0018-redis-for-shared-ephemeral-state.md)

## Context

Refresh tokens rotate on every use, and presenting an already-rotated token is
treated as theft: the whole family is revoked and the user is signed out of
every device ([ADR 0001](0001-access-and-refresh-tokens.md)). That is the right
response to a real replay.

It is the wrong response to something that happens routinely. Access tokens last
fifteen minutes, so a page with several requests in flight has all of them
expire at the same instant. Each retries with the same refresh cookie, because
it is the only one the browser has. The first rotates it; the rest present a
token that was revoked milliseconds ago.

The BFF hid this behind a per-process `Map`: the first caller performs the
refresh, the others await the same promise. That works because there is one
process — and stops working the moment there are two, which is the entire
premise of the scaling work in ADR 0018. It records the gap under Consequences:

> **The BFF refresh memo is NOT moved yet.** It has the same shape of problem
> and a different blast radius… Recorded here so the next person knows it is
> unfinished rather than overlooked.

ADR 0018 also proposed the fix: a `SET NX` lock in Redis, winner refreshes,
losers read the result from a second key.

## Decision

**Do not build the distributed lock. Fix it in Postgres, where the token state
already lives.**

Two changes, and the second was only found by testing the first.

### A grace window on rotation

A token superseded within the last **ten seconds** is treated as a race rather
than a replay. The racing request gets a new *access* token and no new refresh
token — `setAuthCookies` writes only the access cookie, leaving the refresh
cookie the winning request already set.

Two preconditions, both load-bearing:

- **`replacedByTokenHash` must be set.** Only rotation writes it, so its
  presence separates "superseded by a concurrent refresh" from "revoked by a
  logout or a password change". Those leave it null and are never graced —
  there is no concurrent refresh to be racing with.
- **The replacement must still be live.** Without this, a stolen token would
  keep working for ten seconds after the victim changed their password
  *specifically to stop it*.

Deliberately **no new refresh token** on the grace path. Issuing one would fork
the chain: two live refresh tokens for one session, each invalidating the other
on next use — a session that breaks on the *next* refresh instead of this one.

### Claim-then-mint, because the rotation itself was racy

The grace window made the ten-request case survive. It did not make it correct.

Rotation read `revokedAt`, found null, and then wrote — so ten concurrent
requests all passed the check before any of them wrote, and **four of ten minted
a token.** Four live refresh tokens for one session. Nobody was signed out, so
the grace window had hidden the damage rather than prevented it; the fork would
have surfaced later, as a session that died on an unrelated refresh.

The revocation is now the claim:

```sql
UPDATE refresh_tokens SET revoked_at = now(), replaced_by_token_hash = $new
 WHERE token_hash = $old AND revoked_at IS NULL
```

Postgres serialises the concurrent UPDATEs on the row lock, so the loser
re-evaluates the condition after the winner commits and matches nothing.
Exactly one caller sees `count = 1`. A caller that matches zero rows has lost
the race and asks the grace question instead.

The claim and the replacement's `INSERT` are one transaction, because a claim
whose replacement was never written leaves `replacedByTokenHash` pointing at
nothing — and since the grace check requires a live replacement, the next
racing request would be read as theft.

This is the same discipline as the payment claim
([ADR 0013](0013-payment-provider-seam.md)), refund headroom
([ADR 0016](0016-refunds-claim-then-refund.md)) and the TOTP period. It is a
little embarrassing that the token path did not already use it.

### The BFF memo stays

Now an optimisation rather than a correctness control. It saves N−1 unnecessary
HTTP round trips when several requests expire together, and a memo miss across
instances costs one extra round trip and nothing else.

## Consequences

**The frontend gains no datastore connection.** This was the reason to reject
the lock. Publishing the result key means putting the newly minted refresh
token — a live session credential — into Redis: the one store this codebase
treats as safe to lose, unauthenticated on the compose network, with no
persistence and no backup. [ADR 0019](0019-cache-tiering-rule.md)'s rule says
account access is Postgres-only, no exceptions, and a lock that has to publish
a credential to be useful is not an exception, it is the rule being broken.

**It fixes clients that are not our BFF.** A mobile app hitting the API directly
has the identical race, and no memo in the Next server would ever have helped
it. A lock in the BFF would have fixed the race for one client and left it for
every other.

**The attack surface does not grow.** The grace path is reachable only by
presenting a token that was valid ten seconds ago. Anyone holding that token
could have used it normally in that window anyway. The window does not extend
an attacker's reach; it declines to punish the legitimate client for the
server's own rotation timing. Outside it, a replay still revokes everything.

**Ten seconds is a judgement, and it is the tunable.** Long enough for several
requests that expired together plus a slow network; short enough that a token
found in a log, a proxy or a browser history is long past it.

**Rotation now has direct test coverage**, which it did not before — the most
destructive behaviour in the auth system (one request revoking every session a
user has) was entirely unasserted. `tests/api/refresh.ts`, 27 assertions, four
sections of which exist only to prove the window is a window and not a hole:

| Case | Expected |
| --- | --- |
| Ten simultaneous refreshes, same token | all 10 succeed, **exactly one** rotates, one live token |
| The same replay 11 seconds later | 401, **entire family revoked** |
| A token killed by logout, replayed instantly | 401, no grace |
| A token whose replacement was revoked by a password change | 401, no grace |
| An unknown token | 401, unrelated sessions untouched |

## Alternatives considered

**The Redis lock from ADR 0018.** Rejected on the credential grounds above. It
is also strictly more machinery — a lock key, a result key, two TTLs, a waiting
loop and a fallback for the waiter timing out — to solve a narrower version of
the same problem.

**Sticky sessions, so the memo stays coherent.** Rejected for the same reasons
ADR 0018 rejected them for rate limits: a replica restart silently loses the
memo, rebalancing loses it, and it constrains deployment forever to preserve an
implementation detail.

**Stop rotating refresh tokens.** Removes the race completely. Rejected: reuse
detection is the only thing that turns a stolen refresh token from permanent
access into a detectable event, and it depends on rotation.

**Make the access token last longer,** so fewer requests expire together.
Rejected as trading a real security property for a race that now has a proper
fix — fifteen minutes is already the window in which a leaked access token is
useful, and lengthening it is the wrong direction.

**Have the racing request return 401 and let the browser retry.** No grace
window, no forked chain, no new mechanism. Rejected because it converts a
server-side timing detail into a user-visible failure: one of the N parallel
requests on a page fails, and whether the page recovers depends on how each
call site handles it. The server knows the session is fine; it should say so.
