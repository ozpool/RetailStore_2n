# 19. A tiering rule for what may be cached

- **Status:** Accepted
- **Recorded:** 2026-09-02
- **Amends:** [ADR 0018](0018-redis-for-shared-ephemeral-state.md), which
  rejected caching

## Context

ADR 0018 introduced Redis for rate-limit counters and rejected using it as a
cache, in these words:

> **Redis as a cache too.** Rejected for now. The database is not the
> bottleneck, so a catalogue cache would produce a flattering graph and little
> else. Redis earns its place here for correctness, not speed, and mixing the
> two would blur why it is present.

That objection was correct and has not stopped being correct. The database is
still not the bottleneck at this scale. Adding a cache to make a number look
better would be exactly the mistake it describes.

What changed is that the cost of the read paths got measured rather than
assumed. `GET /catalog/listings/:slug` makes six ORM calls, which Prisma expands
into **eight to twelve database round trips** — each `include`d relation is
loaded as its own query rather than joined, and the page pulls a listing, its
category, seller, images and reviews, then four related listings and the same
relations again for each.

Twelve round trips for one product page is not a bottleneck today. It is,
however, the shape of thing that becomes one without warning, and the interesting
engineering question is not whether to cache it. It is what stops a cache from
quietly becoming a second, disagreeing source of truth — which is the real
content of ADR 0018's objection, and something a "we added caching" change
usually leaves unanswered.

## Decision

Cache, but only under a rule that decides placement, and record what the rule
excludes as carefully as what it admits.

### The rule

For any piece of state, ask: **if this store were wiped right now, mid-request,
what breaks?**

| Answer | Tier | Where it lives |
| --- | --- | --- |
| Nothing — it refills from Postgres | Derived | Redis as a *cache*; Postgres authoritative |
| Nothing — nobody needed it after a restart | Ephemeral | Redis as the *store*; no Postgres row behind it |
| Somebody's money, session, or account access | Record | **Postgres only**, no exceptions |

Rate-limit counters (ADR 0018) are Ephemeral. The four caches below are Derived.
Everything else is Record.

### What is cached

| What | Key | TTL | Invalidated by |
| --- | --- | --- | --- |
| Listing detail | `listing:{slug}` | 60s | Seller edits, photo changes, moderation |
| Rating aggregate | `rating:{listingId}` | 5m | Any review write |
| Category shelf | `catalog:categories` | 5m | TTL only |
| Unread badge | `notif:unread:{userId}` | 60s | Notify, read, read-all, delete |

Keys and TTLs live in one file, `lib/cacheKeys.ts`, because a value written in
one module is invalidated from others: a rating is cached by the catalogue and
dropped by the review routes. With the key built inline at each site, a rename
in one place silently stops matching the other, and the symptom is stale data
with no error anywhere.

### The mechanics that matter

**Cache-aside, never write-through.** The database commit happens first and
succeeds on its own; the cache is deleted afterwards. A failed `DEL` leaves
staleness bounded by the TTL. A failed commit after a cache write leaves a lie
with no expiry.

**Fail-open reads.** Every Redis error becomes a load from Postgres. A cache
that can fail a request converts an optional dependency into a required one, and
the entire argument for Redis being safe to add rests on it staying optional.

**Single entities get `DEL`; sets get a short TTL.** A listing edit knows which
key it dirties. A *new listing* does not — it invalidates an unknowable number
of cached search permutations, and no key-tracking scheme makes that
enumerable. There is deliberately no `invalidateByPrefix`: it would need `KEYS`
or `SCAN`, and `KEYS` is O(n) over the whole keyspace, so a routine listing edit
would walk every rate-limit counter in the same Redis.

**Versioned keys.** A global `CACHE_VERSION` prefix. When a serializer changes
shape, stored JSON becomes actively wrong and outlives the deploy that broke it;
bumping the version retires the generation and lets the old keys expire. One
global version rather than one per namespace, because a cached search result
*contains* serialized listings — the namespaces are not independent.

**Misses are cached too**, briefly. Without it a crawler walking unknown slugs
never touches a cached key, so every request reaches Postgres while the hit rate
reads as perfect.

**Stale-while-revalidate behind a `SET NX` lock.** When a hot key expires every
in-flight request misses at once and they all query Postgres together — a load
spike that arrives *because* the cache was working. One request takes the lock
and refreshes; the rest serve the stale value.

### Stock transitions expire rather than invalidate

Reserved, sold and released do **not** drop the listing key. Those happen inside
the checkout and reservation transactions, several per purchase, and threading
cache bookkeeping through code that has to stay simple enough to reason about
under a row lock is a bad trade.

This is safe because availability is not decided by the cached payload. The buy
path re-checks stock under `SELECT … FOR UPDATE` ([ADR 0012](0012-row-locking-for-reservations.md)),
so a stale "available" badge produces a clear refusal at checkout rather than an
oversell — which is already what happens to anyone who has had the page open for
a minute.

## Consequences

**Measured, not asserted.** `scripts/cache-demo.ts` fires the same load twice
against the same process — 120 requests across 120 distinct listing pages, eight
concurrent — and reports both columns. Database transactions are counted from
`pg_stat_database.xact_commit` rather than from instrumenting the app, because
an app-side counter measures what the code believes it did and the question is
whether the queries reached the database at all.

|  | Cold | Warm |
| --- | --- | --- |
| p50 | 103ms | 8ms |
| p95 | 276ms | 23ms |
| Database transactions | 928 | 0 |

Roughly **12× at p95**, and the database is not touched on a warm run. Across
runs the cold per-request count ranges 8–12: every page also renders four
related listings, whose rating aggregates share keys with the listing pages, so
partway through a cold run those are already warm from another page's related
strip.

**Two things were built and then removed**, which is the part of this record
worth keeping.

*Admin dashboard metrics* looked like the strongest candidate — seven aggregate
queries, the most expensive read in the codebase. A cache earns its place
against load, not against cost-per-query, and that page has one user opening it
a few times a day. Against that, its inputs are every order and refund on the
platform, so keeping it honest would mean invalidating from inside the checkout
path; a plain TTL instead made the dashboard disagree with the database, and
`tests/browser/admin-dashboard.ts` caught it reading **$65 in gross sales while
the database held $95.22**. A moderator deciding whether to refund somebody
needs the real number.

*A cached count beside a live list.* `GET /notifications` returns both the
unread list and the count. Serving a cached count there meant the page could
show three unread items under a badge reading zero — a contradiction inside a
single response, which reads as a bug in a way a slightly-late badge never does.
`countUnread` is now exact and `cachedUnreadCount` is opt-in, used only by the
endpoint every open tab polls.

**Search is not cached**, pending a decision on whether a newly published
listing must appear instantly. TTL-only invalidation would delay it by up to the
TTL. If instant is required the answer is a `tsvector` index rather than a
cache — which is the better answer anyway once ranking matters, since
`title ILIKE '%q%'` cannot use a B-tree index and every search is currently a
sequential scan.

**Redis still needs no backup**, and that is the dividend. Because nothing in it
is authoritative, the durability story is only about Postgres. Turning on
persistence to protect a cache would give that up.

## Alternatives considered

**Denormalise the rating onto the listing row.** Cheaper than a cache and always
consistent. Rejected: [ADR 0009](0009-computed-ratings.md) exists specifically so
a displayed rating traces back to review rows that exist, and a cached
computation preserves that while a stored column quietly replaces it.

**`relationJoins` so Prisma emits joins instead of per-relation queries.** This
attacks the actual cause — twelve round trips for one page is Prisma's loading
strategy, not the database struggling — and would help the uncached path, which
a cache never does. Not rejected, just not done: it is a preview feature and a
change to every query in the codebase, and it is complementary rather than an
alternative. Worth doing, separately.

**HTTP caching — `Cache-Control` and a CDN.** Would remove the request entirely
rather than making it cheaper, which is strictly better for anonymous catalogue
traffic. Rejected for now because the BFF sits between the browser and these
responses and would need its own revalidation story, and because it does nothing
for the authenticated reads. A reasonable later addition in front of this, not
instead of it.

**Cache in the Next.js layer instead.** Next has its own data cache and it is
where the catalogue pages are rendered. Rejected: it would put the cache on the
wrong side of the BFF boundary, so the Express API — the thing that actually
holds the business rules and is meant to be independently useful — would still
pay full price for every read.
