# 18. Redis for shared ephemeral state

- **Status:** Accepted
- **Recorded:** 2026-08-27

## Context

Everything that must be correct under concurrency already arbitrates through
Postgres: stock under `SELECT … FOR UPDATE`, the payment claim, refund headroom,
TOTP replay, refresh-token rotation. Those are correct with one instance or
thirty, because one database decides.

Two pieces of state are not like that. Both are shared across requests and both
live in a `Map` inside a single process.

**Rate-limit counters** — `lib/rateLimit.ts`, guarding eleven endpoints. Several
are security controls rather than politeness:

| Key | Limit | What it actually protects |
| --- | --- | --- |
| `admin-stepup` | 8 / 15 min | The only reason a six-digit TOTP is not brute-forceable |
| `password-change` | 10 / 15 min | A password oracle for anyone holding a stolen session |
| `forgot` | 3 / hour per email | Using the endpoint to flood somebody's inbox |

**The single-flight refresh memo** — `frontend/src/lib/backendProxy.ts`. Refresh
tokens rotate on use and presenting an already-rotated one is treated as theft,
which revokes the whole family. The memo exists so that N concurrent requests
share one refresh instead of racing.

With one instance both are coherent by accident. With three replicas:

- every rate limit is silently **three times looser** — `admin-stepup` allows 24
  attempts per fifteen minutes, not 8
- two concurrent requests can land on different frontend instances, both
  refresh, and the second looks like a replay — **logging the user out of every
  device**

The first is a security control that scaling quietly weakens. The second is a
correctness bug that only appears behind a load balancer.

## Decision

Move shared ephemeral state to Redis. Specifically: **counters that expire and
short-lived coordination, and nothing else.**

Redis is not the system of record for anything. Nothing placed in it needs to
survive a restart — that constraint is what stops it becoming a second source of
truth competing with Postgres.

### Atomic, in one round trip

The obvious implementation is `INCR` then `EXPIRE`, which is two commands. A
crash or a dropped connection between them leaves a key with **no TTL** — a
counter that never resets and locks the user out permanently. The increment and
the expiry therefore happen in one Lua script, evaluated server-side:

```lua
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { n, redis.call('PTTL', KEYS[1]) }
```

### The interface becomes async

`checkRateLimit` was synchronous. Redis is not, so every one of the eleven call
sites gains an `await`. That is churn, and it is the honest cost of the state
being somewhere else — a version that pretended to stay synchronous would be
lying about where the counter lives.

### Failure policy is per-limit, and deliberately not uniform

When Redis is unreachable there are only two options and both are bad.

Most limits **fail open**: the request is allowed and the failure is logged
loudly. This matches how `isPasswordBreached` already behaves — a defence in
depth should not take the site down when it is unavailable.

`admin-stepup` **fails closed**. Unlimited guesses at the admin panel is a worse
outcome than nobody being able to open it during an outage, and the panel has
exactly one user who can wait.

Encoding that as a per-call flag rather than a global setting keeps the decision
next to the thing being protected, where somebody changing a limit will see it.

### In-memory stays, as a fallback

With no `REDIS_URL` configured the limiter uses the existing `Map`. Development
and the test suite then need no extra service, and a single-instance deployment
is not forced to run one. The startup banner says which is in use, so nobody has
to guess whether their limits are shared.

## Consequences

**A new dependency and a new failure mode.** Redis being down is now a thing
that happens, with a defined and tested answer rather than an assumed one.

**Limits are only as correct as the clock.** A fixed window still allows a burst
across a boundary — up to 2× the limit in a short span straddling the reset.
That is inherent to fixed windows, not to Redis, and a sliding window is a
larger change than this problem currently justifies.

**The in-memory path must keep working.** Two implementations means two things
to keep honest, so the suite exercises both.

**The BFF refresh memo is NOT moved yet.** It has the same shape of problem and
a different blast radius, and moving it means the Next server talks to Redis
too. Recorded here so the next person knows it is unfinished rather than
overlooked.

> **Resolved, and not this way** — see
> [ADR 0021](0021-refresh-race-grace-window.md). The lock proposed above would
> have had to publish the newly minted refresh token through Redis for the
> waiters to use, putting a live session credential in the store this codebase
> treats as safe to lose. The race is instead handled in Postgres, where the
> token state already lives, so the Next server still talks to no datastore —
> and clients that are not our BFF, which no memo could ever have helped, are
> fixed too.

## Alternatives considered

**A counters table in Postgres.** It is already there and already the arbiter
for everything else. Rejected: it puts a write on the durable store on every
rate-limited request, produces row churn for vacuum to chase, and makes expiry
something to implement rather than something the store provides. Data that
should evaporate in fifteen minutes does not belong in the system of record.

**Sticky sessions at the load balancer.** Pin each user to one replica and the
in-memory counters are coherent again. Rejected as fragile in the ways that
matter: a replica restart silently resets somebody's allowance, rebalancing
loses counters, and it constrains deployment forever to preserve an
implementation detail. It also does nothing for the IP-keyed limits.

**Accept the multiplication.** Rejected. `admin-stepup` at 8 per fifteen minutes
is what makes the second factor meaningful; at 24 it is a different security
posture arrived at by accident.

**Redis as a cache too.** Rejected for now. The database is not the bottleneck,
so a catalogue cache would produce a flattering graph and little else. Redis
earns its place here for correctness, not speed, and mixing the two would blur
why it is present.

> **Revisited.** This was later reversed — see
> [ADR 0019](0019-cache-tiering-rule.md). The objection above was not wrong and
> is quoted in full there: the database is still not the bottleneck. What
> changed is that the read paths were measured (eight to twelve round trips per
> listing page) and that a placement rule with written exclusions now exists,
> which is what stops the cache becoming the second source of truth this
> paragraph was guarding against.
