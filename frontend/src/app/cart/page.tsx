"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Countdown from "@/components/Countdown";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import { useCart } from "@/lib/CartContext";
import { formatPrice } from "@/lib/catalog";
import { getMyOrders, isOpen, startCheckout, type Order } from "@/lib/ordersApi";
import {
  getMyHolds,
  releaseHold,
  type HeldReservation,
} from "@/lib/reservationsApi";

export default function CartPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { refresh: refreshCart } = useCart();

  const [holds, setHolds] = useState<HeldReservation[] | null>(null);
  const [holdMinutes, setHoldMinutes] = useState(15);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  /**
   * An order already awaiting payment.
   *
   * Checking out converts the holds, so the cart legitimately empties. Without
   * surfacing the order here, a buyer who closed the tab mid-payment would
   * come back to an empty cart and no sign of the items they still have
   * reserved — which reads as "my things vanished".
   */
  const [openOrder, setOpenOrder] = useState<Order | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const data = await getMyHolds();
      setHolds(data.reservations);
      setHoldMinutes(data.holdMinutes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your cart.");
      setHolds([]);
    }

    try {
      const { orders } = await getMyOrders();
      setOpenOrder(orders.find(isOpen) ?? null);
    } catch {
      // Non-essential to the cart itself; a failure here must not blank it.
    }
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  // Read from location rather than useSearchParams so this page needs no
  // Suspense boundary for a one-off confirmation message.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("cancelled")) {
      setNotice("That order was cancelled. Your items are back in the shop.");
      window.history.replaceState({}, "", "/cart");
    }
  }, []);

  async function checkout() {
    setError(null);
    setCheckingOut(true);
    try {
      const { order } = await startCheckout();
      // Holds became order lines. The total is unchanged, but where it comes
      // from isn't, so the badge has to be re-read rather than assumed.
      void refreshCart();
      router.push(`/checkout/${order.id}`);
    } catch (err) {
      /**
       * No address yet is not an error, it's a missing step. Sending them to
       * the form with ?next means they land back here with one saved, rather
       * than reading a message and having to work out where to go.
       */
      if (err instanceof ApiError && err.code === "NO_ADDRESS") {
        router.push("/account/addresses?next=/cart");
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't start checkout. Please try again."
      );
      // A hold may have expired out from under them, so re-read the truth.
      await load();
      setCheckingOut(false);
    }
  }

  async function release(id: string) {
    setError(null);
    setBusyId(id);
    try {
      await releaseHold(id);
      await load();
      void refreshCart();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't release that hold.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading || !user) {
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-16">
          <div className="mx-auto max-w-[1400px] text-sm text-ink-dim">Loading…</div>
        </main>
        <Footer />
      </>
    );
  }

  const items = holds ?? [];
  const total = items.reduce(
    (sum, h) => sum + h.listing.priceCents * h.quantity,
    0
  );
  const currency = items[0]?.listing.currency ?? "USD";

  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-4xl">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h1 className="font-serif text-3xl font-medium tracking-tight text-ink sm:text-4xl">
              Your cart
            </h1>
            {items.length > 0 && (
              <p className="text-sm text-ink-dim">
                {items.length} item{items.length === 1 ? "" : "s"} on hold
              </p>
            )}
          </div>

          <p className="mt-3 max-w-2xl text-sm text-ink-dim">
            Adding something here puts a {holdMinutes}-minute hold on it, so nobody
            else can buy it while you decide. Most things on RetailStore_2n are
            one-of-a-kind, so the hold is the part that actually matters.
          </p>

          {notice && (
            <p className="mt-6 rounded-xl border border-line bg-blush px-4 py-3 text-sm text-ink">
              {notice}
            </p>
          )}

          {error && (
            <p className="mt-6 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
              {error}
            </p>
          )}

          {openOrder && (
            <div className="mt-6 rounded-2xl border border-gold/30 bg-gold/5 p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-ink">
                  You have an order waiting to be paid
                </p>
                <span className="text-sm text-ink-dim">{openOrder.reference}</span>
              </div>
              <p className="mt-2 text-sm text-ink-dim">
                {openOrder.items.length} item
                {openOrder.items.length === 1 ? "" : "s"} ·{" "}
                {formatPrice(openOrder.subtotalCents, openOrder.currency)}. These
                are still held for you.
              </p>
              <Link
                href={`/checkout/${openOrder.id}`}
                className="mt-4 inline-block rounded bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-95"
              >
                {openOrder.status === "PROCESSING"
                  ? "Check that payment"
                  : "Finish paying"}
              </Link>
            </div>
          )}

          {holds === null ? (
            <p className="mt-10 text-sm text-ink-dim">Loading…</p>
          ) : items.length === 0 ? (
            <div className="mt-10 rounded-3xl border border-line bg-paper-card p-10 text-center">
              <p className="text-ink">Nothing on hold right now.</p>
              <p className="mx-auto mt-2 max-w-md text-sm text-ink-dim">
                Find something worth a second life and hold it while you think.
              </p>
              <Link
                href="/search"
                className="mt-6 inline-block rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90"
              >
                Browse the shop
              </Link>
            </div>
          ) : (
            <>
              <ul className="mt-8 grid gap-4">
                {items.map((hold) => (
                  <li
                    key={hold.id}
                    className="flex flex-wrap items-center gap-5 rounded-2xl border border-line bg-paper-card p-4"
                  >
                    <Link
                      href={`/listing/${hold.listing.slug}`}
                      className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-line"
                    >
                      {hold.listing.image ? (
                        <Image
                          src={hold.listing.image}
                          alt={hold.listing.title}
                          fill
                          sizes="80px"
                          className="object-cover"
                        />
                      ) : (
                        <span className="flex h-full items-center justify-center bg-blush text-center text-[10px] text-ink-dim">
                          No photo
                        </span>
                      )}
                    </Link>

                    <div className="min-w-48 flex-1">
                      <Link
                        href={`/listing/${hold.listing.slug}`}
                        className="text-sm font-medium text-ink transition hover:text-gold-dim"
                      >
                        {hold.listing.title}
                      </Link>
                      <p className="mt-1 text-sm text-ink-dim">
                        {formatPrice(hold.listing.priceCents, hold.listing.currency)}
                        {hold.quantity > 1 && ` × ${hold.quantity}`}
                      </p>
                      <p className="mt-1 text-xs text-ink-dim">
                        Hold: <Countdown expiresAt={hold.expiresAt} onExpire={load} />
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => release(hold.id)}
                      disabled={busyId === hold.id}
                      className="rounded-full border border-line px-4 py-1.5 text-sm text-ink-dim transition hover:border-clay/40 hover:text-clay disabled:opacity-60"
                    >
                      {busyId === hold.id ? "Releasing…" : "Release"}
                    </button>
                  </li>
                ))}
              </ul>

              <div className="mt-8 rounded-2xl border border-line bg-paper-card p-6">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-ink-dim">Total held</span>
                  <span className="text-xl font-semibold text-gold-dim">
                    {formatPrice(total, currency)}
                  </span>
                </div>

                <div className="mt-5 border-t border-line pt-5">
                  <button
                    type="button"
                    onClick={checkout}
                    disabled={checkingOut}
                    className="w-full rounded bg-gold-dim px-5 py-3 text-sm font-semibold text-paper transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {checkingOut ? "Starting checkout…" : "Proceed to checkout"}
                  </button>
                  <p className="mt-3 text-xs text-ink-dim">
                    Your items stay held while you pay, so nobody can buy them out
                    from under you. You can still cancel from the next step.
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
