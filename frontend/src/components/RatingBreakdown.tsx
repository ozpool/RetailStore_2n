import StarRating from "@/components/StarRating";

/**
 * The distribution behind an average.
 *
 * 3.0 from twenty 3-star reviews and 3.0 from ten 5s and ten 1s are very
 * different things to buy from, and on a secondhand marketplace that gap is
 * most of the signal. The average alone hides it.
 */
export default function RatingBreakdown({
  average,
  count,
  breakdown,
}: {
  average: number | null;
  count: number;
  breakdown: Record<string, number>;
}) {
  if (count === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-8 rounded-2xl border border-line bg-paper-card p-5">
      <div className="text-center">
        <p className="font-serif text-4xl font-semibold text-ink">
          {average?.toFixed(1) ?? "—"}
        </p>
        <div className="mt-1 flex justify-center">
          <StarRating rating={average ?? 0} />
        </div>
        <p className="mt-1 text-xs text-ink-dim">
          {count} review{count === 1 ? "" : "s"}
        </p>
      </div>

      <ul className="min-w-56 flex-1">
        {[5, 4, 3, 2, 1].map((star) => {
          const n = breakdown[String(star)] ?? 0;
          const pct = count === 0 ? 0 : Math.round((n / count) * 100);
          return (
            <li key={star} className="flex items-center gap-3 py-0.5">
              <span className="w-10 shrink-0 text-xs text-ink-dim">
                {star} star
              </span>
              {/* The bar is decoration; the count beside it carries the number,
                  so this reads the same without colour or width. */}
              <span
                aria-hidden="true"
                className="h-2 flex-1 overflow-hidden rounded-full bg-blush"
              >
                <span
                  className="block h-full rounded-full bg-gold"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="w-8 shrink-0 text-right text-xs text-ink-dim">{n}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
