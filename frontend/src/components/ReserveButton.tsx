"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Countdown from "@/components/Countdown";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import { useCart } from "@/lib/CartContext";
import { getMyHolds, holdListing, releaseHold } from "@/lib/reservationsApi";

type Hold = { id: string; expiresAt: string; quantity: number };

export default function ReserveButton({
  listingId,
  status,
  quantity,
}: {
  listingId: string;
  status: string;
  quantity: number;
}) {
  const router = useRouter();
  const { user, loading } = useAuth();
  // Named to avoid colliding with this component's own `refresh`, which
  // re-reads whether the viewer holds *this* listing.
  const { refresh: refreshCart } = useCart();

  const [hold, setHold] = useState<Hold | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Does the viewer already hold this? Matters because the listing shows as
  // RESERVED either way, and "you have it" reads very differently from
  // "someone else does".
  const refresh = useCallback(async () => {
    if (!user) {
      setChecking(false);
      return;
    }
    try {
      const { reservations } = await getMyHolds();
      const mine = reservations.find((r) => r.listingId === listingId);
      setHold(mine ? { id: mine.id, expiresAt: mine.expiresAt, quantity: mine.quantity } : null);
    } catch {
      setHold(null);
    } finally {
      setChecking(false);
    }
  }, [user, listingId]);

  useEffect(() => {
    if (!loading) refresh();
  }, [loading, refresh]);

  async function onHold() {
    setError(null);
    setBusy(true);
    try {
      const { reservation } = await holdListing(listingId);
      setHold({
        id: reservation.id,
        expiresAt: reservation.expiresAt,
        quantity: reservation.quantity,
      });
      // The nav badge is rendered elsewhere and has no other way to know.
      void refreshCart();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't hold that item.");
      // Someone else may have taken it — re-read rather than guess.
      if (err instanceof ApiError && err.code === "INSUFFICIENT_STOCK") router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onRelease() {
    if (!hold) return;
    setError(null);
    setBusy(true);
    try {
      await releaseHold(hold.id);
      setHold(null);
      void refreshCart();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't release that hold.");
    } finally {
      setBusy(false);
    }
  }

  const box = "mt-8 rounded-2xl border p-5";

  if (status === "SOLD") {
    return (
      <div className={`${box} border-line bg-blush/40`}>
        <p className="text-sm font-medium text-ink">Sold</p>
        <p className="mt-2 text-sm text-ink-dim">
          This one has gone. There may be similar pieces below.
        </p>
      </div>
    );
  }

  if (loading || checking) {
    return (
      <div className={`${box} border-line bg-paper-card`}>
        <p className="text-sm text-ink-dim">Checking availability…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className={`${box} border-line bg-paper-card`}>
        <p className="text-sm font-medium text-ink">Log in to hold this item</p>
        <p className="mt-2 text-sm text-ink-dim">
          Holding keeps it off the shop for 15 minutes so nobody else can take it
          while you decide.
        </p>
        <Link
          href="/login"
          className="mt-4 inline-block rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90"
        >
          Log in
        </Link>
      </div>
    );
  }

  if (hold) {
    return (
      <div className={`${box} border-sage/50 bg-sage/20`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-ink">You&apos;re holding this</p>
          <p className="text-sm text-ink-dim">
            <Countdown expiresAt={hold.expiresAt} onExpire={refresh} />
          </p>
        </div>
        <p className="mt-2 text-sm text-ink-dim">
          It&apos;s off the shop while you decide. If the hold runs out it goes
          straight back — so check out before then if you want it.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link
            href="/cart"
            className="rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90"
          >
            View your cart
          </Link>
          <button
            type="button"
            onClick={onRelease}
            disabled={busy}
            className="rounded-full border border-line px-4 py-2 text-sm font-medium text-ink-dim transition hover:border-gold/50 hover:text-gold-dim disabled:opacity-60"
          >
            {busy ? "Releasing…" : "Release it"}
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-clay">{error}</p>}
      </div>
    );
  }

  // Held by somebody else: stock is gone and the status has flipped.
  if (status === "RESERVED" || quantity < 1) {
    return (
      <div className={`${box} border-line bg-blush/40`}>
        <p className="text-sm font-medium text-ink">On hold by another buyer</p>
        <p className="mt-2 text-sm text-ink-dim">
          Holds last 15 minutes. If it lapses, this comes back automatically —
          worth checking again shortly.
        </p>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="mt-4 rounded-full border border-line px-4 py-2 text-sm font-medium text-ink-dim transition hover:border-gold/50 hover:text-gold-dim"
        >
          Check again
        </button>
      </div>
    );
  }

  return (
    <div className={`${box} border-line bg-paper-card`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-ink">
          {quantity === 1 ? "Only one of these" : `${quantity} available`}
        </p>
      </div>
      <p className="mt-2 text-sm text-ink-dim">
        Hold it for 15 minutes and nobody else can take it meanwhile. That&apos;s
        long enough to check out — the hold stays until you&apos;ve paid.
      </p>
      <button
        type="button"
        onClick={onHold}
        disabled={busy}
        className="seam-glow mt-4 rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90 disabled:opacity-60"
      >
        {busy ? "Holding…" : "Hold this item"}
      </button>
      {error && <p className="mt-3 text-sm text-clay">{error}</p>}
    </div>
  );
}
