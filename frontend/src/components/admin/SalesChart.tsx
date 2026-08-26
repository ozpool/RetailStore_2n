"use client";

import { useId, useState } from "react";
import { money } from "@/components/admin/ui";

/**
 * Daily gross sales, drawn as an SVG area chart.
 *
 * Hand-drawn rather than pulled from a charting library. Recharts and friends
 * are 100–400 kB to render one line, they mount a ResizeObserver per chart, and
 * they need their own dark-mode wiring. A path built from a viewBox is a few
 * dozen lines, scales with the container for free, and adds nothing to the
 * bundle.
 *
 * The x-axis is date-continuous — the series arrives with empty days already
 * filled in as zero, so a quiet fortnight looks quiet instead of being skipped.
 */
export default function SalesChart({
  series,
  currency = "USD",
}: {
  series: Array<{ date: string; grossCents: number; orders: number }>;
  currency?: string;
}) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  if (series.length === 0) {
    return <p className="px-5 py-16 text-center text-sm text-ink-dim">No sales yet.</p>;
  }

  const W = 800;
  const H = 220;
  const PAD = { top: 16, right: 8, bottom: 26, left: 8 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const peak = Math.max(...series.map((d) => d.grossCents));
  // A flat-zero series would divide by zero and collapse every point onto the
  // baseline; 1 keeps the line on the floor where it belongs.
  const scaleMax = peak > 0 ? peak : 1;

  const x = (i: number) =>
    PAD.left + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const y = (cents: number) => PAD.top + plotH - (cents / scaleMax) * plotH;

  const line = series.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.grossCents).toFixed(1)}`).join(" ");
  const area = `${line} L${x(series.length - 1).toFixed(1)},${PAD.top + plotH} L${x(0).toFixed(1)},${PAD.top + plotH} Z`;

  const active = hover !== null ? series[hover] : null;
  const label = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div className="relative px-2 pb-2 pt-1">
      {/* Reserves its own height so the card does not jump when a value appears. */}
      <div className="flex h-9 items-baseline gap-2 px-3">
        {active ? (
          <>
            <span className="text-sm font-semibold text-ink">
              {money(active.grossCents, currency)}
            </span>
            <span className="text-xs text-ink-dim">
              {active.orders} order{active.orders === 1 ? "" : "s"} · {label(active.date)}
            </span>
          </>
        ) : (
          <span className="text-xs text-ink-dim">Peak day {money(peak, currency)}</span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`Daily gross sales for the last ${series.length} days. Peak ${money(peak, currency)}.`}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-gold)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--color-gold)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Quartile guides. Unlabelled on purpose — the numbers that matter are
            in the stat row above and in the hover readout. */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={PAD.left}
            x2={W - PAD.right}
            y1={PAD.top + plotH * f}
            y2={PAD.top + plotH * f}
            stroke="var(--color-line)"
            strokeWidth="1"
          />
        ))}

        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={line}
          fill="none"
          stroke="var(--color-gold)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {active && hover !== null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="var(--color-ink-dim)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <circle
              cx={x(hover)}
              cy={y(active.grossCents)}
              r="4"
              fill="var(--color-paper)"
              stroke="var(--color-gold)"
              strokeWidth="2"
            />
          </>
        )}

        {/* One transparent hit area per day, so the pointer never has to find a
            2px line. */}
        {series.map((d, i) => (
          <rect
            key={d.date}
            x={x(i) - plotW / series.length / 2}
            y={PAD.top}
            width={plotW / series.length}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}

        {/* First, middle, last. More ticks than that turn to mush at this width. */}
        {[0, Math.floor((series.length - 1) / 2), series.length - 1]
          .filter((i, n, arr) => arr.indexOf(i) === n)
          .map((i) => (
            <text
              key={i}
              x={x(i)}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === series.length - 1 ? "end" : "middle"}
              className="fill-[var(--color-ink-dim)] text-[11px]"
            >
              {label(series[i].date)}
            </text>
          ))}
      </svg>
    </div>
  );
}
