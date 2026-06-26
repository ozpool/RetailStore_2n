"use client";

import { useEffect, useState } from "react";

/**
 * Delays a fast-changing value so it can be used as a query key.
 *
 * Typing "cardigan" into a search box is eight renders. Without this, that is
 * eight round trips to a table scan, seven of whose results are thrown away —
 * and they can land out of order, so the list settles on whichever reply was
 * slowest rather than on what was typed last.
 */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);

  return settled;
}
