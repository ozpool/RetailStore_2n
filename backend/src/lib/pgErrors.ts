/**
 * Postgres error shapes this codebase reacts to rather than logs.
 *
 * Extracted because it was written twice — `deliveryLedger.ts` and `returns.ts`
 * each carried a local copy, and the placement work needed a third. The two
 * copies had drifted: one checked the raw SQLSTATE as well as Prisma's code,
 * the other did not.
 */

/**
 * A unique-violation, from either layer.
 *
 * `P2002` is Prisma's; `23505` is Postgres's own, which is what surfaces from
 * `$executeRaw` and from a constraint Prisma does not know about — the partial
 * unique index on live placements being exactly that case (ADR 0034).
 *
 * Everywhere this is used, a collision is the mechanism working: two callers
 * raced for one thing and the loser is being told so, not failing.
 */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "P2002" || code === "23505";
}
