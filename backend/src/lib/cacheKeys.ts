/**
 * Every cache key and TTL in the codebase, in one file.
 *
 * WHY THESE ARE NOT DEFINED WHERE THEY ARE USED
 * A cached value is written in one module and invalidated in others — a rating
 * is cached by the catalogue and dropped by the review routes; a listing is
 * cached by the catalogue and dropped by the seller routes and moderation. With
 * the key built inline at each site, a rename in one place silently stops
 * matching the other, and the symptom is stale data with no error anywhere.
 *
 * Keeping them here also means the answer to "what does this codebase cache,
 * and for how long?" is one file rather than a grep.
 *
 * See docs/adr/0018-redis-for-shared-ephemeral-state.md
 */

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

/**
 * The category shelf.
 *
 * FIVE MINUTES RATHER THAN AN HOUR, and the reason is the count.
 * The categories themselves change roughly never, but each carries a live
 * `listingCount` of what is currently buyable in it. That number moves whenever
 * anything is published, sold, or removed — so the TTL is set by the most
 * volatile field in the payload, not the least. Five minutes of a tile reading
 * "42 items" when it is 43 is invisible; an hour starts to look wrong.
 */
export const CATEGORIES_KEY = "catalog:categories";
export const CATEGORY_TTL = 300;

/**
 * One listing's full detail payload.
 *
 * INVALIDATED ON CONTENT CHANGES, EXPIRED ON STOCK CHANGES — deliberately.
 *
 * Seller edits and moderation actions call `invalidate(listingKey(slug))`
 * directly, because those change what the page *says* and a minute of the wrong
 * price or a removed listing still being readable is not acceptable.
 *
 * Stock transitions — reserved, sold, released — do not. They happen inside the
 * checkout and reservation transactions, several of them per purchase, and
 * threading invalidation through those would put cache bookkeeping inside the
 * code that has to stay simple enough to reason about under a row lock.
 *
 * That is safe here specifically because availability is NOT decided by this
 * payload. The buy path re-checks stock under `SELECT … FOR UPDATE`
 * (ADR 0012), so a stale "available" badge produces a clear refusal at
 * checkout rather than an oversell — exactly what already happens to anyone who
 * has had the page open for a minute.
 */
export const LISTING_TTL = 60;
export const listingKey = (slug: string) => `listing:${slug}`;

/**
 * Average and count of a listing's reviews.
 *
 * Written through `cachedMany`, so a catalogue page of twenty-four cards is one
 * MGET rather than twenty-four round trips or a `groupBy` per render.
 *
 * Five minutes is generous because the underlying number barely moves: a review
 * is a rare event, and every write path invalidates this anyway.
 */
export const RATING_TTL = 300;
export const RATING_PREFIX = "rating";

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */

/**
 * The unread count behind the nav bell.
 *
 * The only endpoint whose load scales with TABS OPEN rather than with anything
 * anyone does — every signed-in tab polls it on a timer, forever, including the
 * ones nobody is looking at.
 *
 * Short, and invalidated on every write that could change it, so the badge
 * stays honest. A minute of a stale count on an idle tab is the failure mode,
 * and the tab was going to be a minute out of date anyway between polls.
 */
export const UNREAD_TTL = 60;
export const unreadKey = (userId: string) => `notif:unread:${userId}`;

/* ------------------------------------------------------------------ *
 * Not cached, and why
 *
 * Worth recording next to what IS cached, because both were tried.
 *
 * ADMIN DASHBOARD METRICS — the most expensive queries in the codebase, and
 * still not worth caching. A cache earns its place against load, and that page
 * has one user. Against that: its inputs are every order and refund, so keeping
 * it honest would mean invalidating from inside the checkout path, and a plain
 * TTL instead makes the dashboard disagree with the database. The browser suite
 * caught precisely that — $65 shown against $95.22 held. A moderator deciding
 * whether to refund someone needs the real number. See lib/adminStats.ts.
 *
 * SEARCH RESULTS — pending a decision on whether a newly published listing must
 * appear instantly. If it must, the answer is a tsvector index rather than a
 * cache, because the keys a new listing dirties cannot be enumerated.
 * ------------------------------------------------------------------ */
