"use client";

import { useState } from "react";

const LABELS = ["", "Poor", "Not great", "Fine", "Good", "Excellent"];

/**
 * Choosing a star rating.
 *
 * Radio inputs rather than clickable icons, because this is a
 * pick-one-of-five and that is exactly what a radio group is. It arrives
 * keyboard-navigable and screen-reader-legible without any ARIA of my own, and
 * the word next to the stars means the choice never depends on counting shapes.
 */
export default function StarPicker({
  value,
  onChange,
  disabled = false,
  name = "rating",
}: {
  value: number;
  onChange: (rating: number) => void;
  disabled?: boolean;
  name?: string;
}) {
  const [hovered, setHovered] = useState(0);
  const shown = hovered || value;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <fieldset
        className="flex items-center gap-1"
        onMouseLeave={() => setHovered(0)}
        disabled={disabled}
      >
        <legend className="sr-only">Your rating</legend>
        {[1, 2, 3, 4, 5].map((n) => (
          <label
            key={n}
            className={`cursor-pointer p-0.5 ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
            onMouseEnter={() => !disabled && setHovered(n)}
          >
            <input
              type="radio"
              name={name}
              value={n}
              checked={value === n}
              onChange={() => onChange(n)}
              disabled={disabled}
              /* Not display:none — a hidden input can't be focused, which would
                 make this unreachable by keyboard. */
              className="sr-only peer"
            />
            <span className="sr-only">
              {n} star{n === 1 ? "" : "s"} — {LABELS[n]}
            </span>
            <svg
              viewBox="0 0 24 24"
              className={`h-7 w-7 transition peer-focus-visible:ring-2 peer-focus-visible:ring-gold rounded ${
                n <= shown ? "text-gold" : "text-line"
              }`}
              fill={n <= shown ? "currentColor" : "none"}
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5-5.9-3.1-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z" />
            </svg>
          </label>
        ))}
      </fieldset>

      <span className="text-sm text-ink-dim">
        {shown ? LABELS[shown] : "Pick a rating"}
      </span>
    </div>
  );
}
