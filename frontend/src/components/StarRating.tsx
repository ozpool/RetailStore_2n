function Star({ fill }: { fill: number }) {
  return (
    <span className="relative inline-block h-3.5 w-3.5">
      <svg viewBox="0 0 20 20" className="absolute inset-0 h-full w-full text-line" fill="currentColor">
        <path d="M10 1.5l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.6-4.1 6.1-.6z" />
      </svg>
      <span
        className="absolute inset-0 overflow-hidden"
        style={{ width: `${fill * 100}%` }}
      >
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 text-star" fill="currentColor">
          <path d="M10 1.5l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.6-4.1 6.1-.6z" />
        </svg>
      </span>
    </span>
  );
}

/**
 * `count` is the number of reviews behind the average. Omit it when showing a
 * single review's own stars — there's no aggregate to report there.
 */
export default function StarRating({
  rating,
  count,
}: {
  rating: number;
  count?: number;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-0.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Star key={i} fill={Math.max(0, Math.min(1, rating - i))} />
        ))}
      </div>
      {count !== undefined && (
        <span className="text-xs text-ink-dim">
          {rating.toFixed(1)} ({count})
        </span>
      )}
    </div>
  );
}
