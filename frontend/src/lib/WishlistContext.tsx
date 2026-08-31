"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAuth } from "@/lib/AuthContext";
import {
  getWishlistIds,
  removeFromWishlist,
  saveToWishlist,
} from "@/lib/wishlistApi";

/**
 * Which listings the signed-in viewer has saved.
 *
 * WHY THIS IS SHARED STATE
 * A catalog page draws a heart on every tile. If each heart fetched its own
 * status that would be twenty requests to render one grid, and toggling one
 * would leave the same item's heart on another shelf showing the opposite
 * state. So the set of saved ids is loaded once per session and lives here.
 *
 * OPTIMISTIC, BUT HONEST
 * The heart flips immediately, because waiting on a round trip for a heart
 * feels broken. If the request then fails the flip is reverted and the error is
 * surfaced — the UI never keeps a state the server rejected.
 */

type WishlistContextValue = {
  /** null until the first load finishes, so hearts can avoid flashing. */
  ids: Set<string> | null;
  count: number;
  loading: boolean;
  has: (listingId: string) => boolean;
  /** Returns the new saved state, or throws. */
  toggle: (listingId: string) => Promise<boolean>;
  refresh: () => Promise<void>;
};

const WishlistContext = createContext<WishlistContextValue | null>(null);

export function WishlistProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [ids, setIds] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(false);

  // Keyed on the id rather than the user object: AuthContext replaces `user`
  // with a fresh object every revalidation, which would otherwise refetch the
  // whole wishlist every 13 minutes for no reason.
  const userId = user?.id ?? null;

  const refresh = useCallback(async () => {
    if (!userId) {
      setIds(null);
      return;
    }
    setLoading(true);
    try {
      const { listingIds } = await getWishlistIds();
      setIds(new Set(listingIds));
    } catch {
      // A wishlist that won't load must not break browsing. Hearts render
      // unsaved, and the next toggle will surface the real error.
      setIds(new Set());
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (authLoading) return;
    void refresh();
  }, [authLoading, refresh]);

  const has = useCallback(
    (listingId: string) => ids?.has(listingId) ?? false,
    [ids]
  );

  const toggle = useCallback(
    async (listingId: string) => {
      const wasSaved = ids?.has(listingId) ?? false;
      const next = !wasSaved;

      // Optimistic flip.
      setIds((current) => {
        const copy = new Set(current ?? []);
        if (next) copy.add(listingId);
        else copy.delete(listingId);
        return copy;
      });

      try {
        if (next) await saveToWishlist(listingId);
        else await removeFromWishlist(listingId);
        return next;
      } catch (err) {
        // Put it back. Showing a filled heart for something the server refused
        // to save is worse than the toggle appearing not to work.
        setIds((current) => {
          const copy = new Set(current ?? []);
          if (wasSaved) copy.add(listingId);
          else copy.delete(listingId);
          return copy;
        });
        throw err;
      }
    },
    [ids]
  );

  const value = useMemo<WishlistContextValue>(
    () => ({ ids, count: ids?.size ?? 0, loading, has, toggle, refresh }),
    [ids, loading, has, toggle, refresh]
  );

  return <WishlistContext.Provider value={value}>{children}</WishlistContext.Provider>;
}

export function useWishlist() {
  const ctx = useContext(WishlistContext);
  if (!ctx) throw new Error("useWishlist must be used inside a WishlistProvider");
  return ctx;
}
