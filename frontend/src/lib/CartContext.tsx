"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "@/lib/AuthContext";
import { getCartSummary, type CartSummary } from "@/lib/reservationsApi";

/**
 * How many things are in the cart, for the nav badge.
 *
 * WHY A CONTEXT RATHER THAN A FETCH IN THE NAV
 * The count changes from places that aren't the nav: holding an item on a
 * listing page, releasing one in the cart, starting checkout, cancelling an
 * order. Every one of those has to be able to say "that number is stale now".
 *
 * WHY IT EXPIRES ON A TIMER
 * Unlike the wishlist, cart contents lapse on their own. Holds last fifteen
 * minutes, and nothing tells the browser when they go. A badge that only
 * refreshes on navigation would sit there claiming two items long after both
 * holds had expired and the items were back in the shop. So the server sends
 * the soonest expiry and this schedules a refresh for that moment — one timer,
 * not polling.
 */

type CartContextValue = {
  count: number;
  summary: CartSummary | null;
  loading: boolean;
  /** Call after anything that changes the cart. */
  refresh: () => Promise<void>;
};

const CartContext = createContext<CartContextValue | null>(null);

const EMPTY: CartSummary = {
  count: 0,
  heldCount: 0,
  openOrderItems: 0,
  nextExpiresAt: null,
  openOrder: null,
};

export function CartProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [summary, setSummary] = useState<CartSummary | null>(null);
  const [loading, setLoading] = useState(false);

  // Keyed on the id, not the user object: AuthContext hands back a fresh object
  // on every revalidation, which would otherwise refetch this every 13 minutes.
  const userId = user?.id ?? null;

  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) {
      setSummary(null);
      return;
    }
    setLoading(true);
    try {
      setSummary(await getCartSummary());
    } catch {
      // A cart count that won't load must not break the nav. Showing nothing is
      // better than showing a number we can't stand behind.
      setSummary(EMPTY);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (authLoading) return;
    void refresh();
  }, [authLoading, refresh]);

  /**
   * Re-check the moment the soonest hold lapses.
   *
   * A second of slack, because the server decides expiry and a client clock
   * running slightly fast would otherwise fire early and get the same answer
   * back — then have nothing scheduled.
   */
  useEffect(() => {
    if (expiryTimer.current) clearTimeout(expiryTimer.current);
    if (!summary?.nextExpiresAt) return;

    const due = new Date(summary.nextExpiresAt).getTime() - Date.now() + 1_000;
    // Already past: the hold lapsed between the response and this effect.
    if (due <= 0) {
      void refresh();
      return;
    }

    expiryTimer.current = setTimeout(() => void refresh(), due);
    return () => {
      if (expiryTimer.current) clearTimeout(expiryTimer.current);
    };
  }, [summary?.nextExpiresAt, refresh]);

  /** Timers don't fire on a sleeping machine, so re-check on return. */
  useEffect(() => {
    if (!userId) return;
    function onVisible() {
      if (document.visibilityState === "visible") void refresh();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [userId, refresh]);

  const value = useMemo<CartContextValue>(
    () => ({ count: summary?.count ?? 0, summary, loading, refresh }),
    [summary, loading, refresh]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside a CartProvider");
  return ctx;
}
