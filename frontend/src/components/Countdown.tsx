"use client";

import { useEffect, useState } from "react";

function remaining(iso: string) {
  return Math.max(0, new Date(iso).getTime() - Date.now());
}

function format(ms: number) {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Ticks down to an expiry timestamp and fires `onExpire` once.
 *
 * The server is still the authority — a hold is only really gone when the API
 * says so. This just stops the UI claiming a hold is live after it isn't.
 */
export default function Countdown({
  expiresAt,
  onExpire,
}: {
  expiresAt: string;
  onExpire?: () => void;
}) {
  const [ms, setMs] = useState(() => remaining(expiresAt));

  useEffect(() => {
    setMs(remaining(expiresAt));

    const id = setInterval(() => {
      const next = remaining(expiresAt);
      setMs(next);
      if (next === 0) {
        clearInterval(id);
        onExpire?.();
      }
    }, 1000);

    return () => clearInterval(id);
    // onExpire is intentionally excluded: callers pass inline closures, and
    // re-running this would restart the timer on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt]);

  if (ms === 0) return <span className="text-clay">expired</span>;

  return (
    <span className={ms < 60_000 ? "text-clay" : undefined}>
      {format(ms)} left
    </span>
  );
}
