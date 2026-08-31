"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import OrderLines from "@/components/OrderLines";
import ShipToCard from "@/components/ShipToCard";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import { useCart } from "@/lib/CartContext";
import { formatPrice } from "@/lib/catalog";
import {
  cancelOrder,
  getOrder,
  payOrder,
  STATUS_LABEL,
  TEST_CARDS,
  type Order,
} from "@/lib/ordersApi";

/**
 * Payment.
 *
 * The order already exists and already holds the stock by the time anyone gets
 * here, so nobody can be told their item is gone after paying for it.
 *
 * The card number lives in component state only for as long as the form is on
 * screen, and is cleared the moment a payment resolves. It is sent to our API,
 * which hands it to the provider and discards it — nothing about it is stored
 * or logged anywhere. See docs/adr/0013-payment-provider-seam.md.
 */
export default function CheckoutPage() {
  const router = useRouter();
  const params = useParams<{ orderId: string }>();
  const orderId = params.orderId;
  const { user, loading } = useAuth();
  const { refresh: refreshCart } = useCart();

  const [order, setOrder] = useState<Order | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cardNumber, setCardNumber] = useState("");
  const [paying, setPaying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const { order } = await getOrder(orderId);
      setOrder(order);
      // A finished order has nothing to pay, so send them to the receipt
      // rather than showing a card form that cannot do anything.
      if (order.status === "PAID") router.replace(`/orders/${order.id}`);
    } catch (err) {
      setLoadError(
        err instanceof ApiError ? err.message : "Couldn't load that order."
      );
    }
  }, [orderId, router]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  async function pay(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPaying(true);

    try {
      const result = await payOrder(orderId, cardNumber);
      // Cleared regardless of outcome — there is no reason to keep it around.
      setCardNumber("");
      setOrder(result.order);
      // Paid or failed, the order stops holding stock and leaves the cart.
      void refreshCart();

      if (result.outcome === "succeeded") {
        router.push(`/orders/${orderId}`);
        return;
      }
      if (result.outcome === "pending") {
        setNotice(
          result.reason ??
            "That card needs extra authentication. We'll settle this shortly."
        );
        return;
      }
      setError(result.reason ?? "That payment didn't go through.");
    } catch (err) {
      setCardNumber("");

      if (err instanceof ApiError) {
        // Someone already paid this — most likely a second tab, or a retry
        // that landed after the first succeeded.
        if (err.code === "ALREADY_PAID") {
          router.push(`/orders/${orderId}`);
          return;
        }
        if (err.code === "PAYMENT_IN_PROGRESS") {
          setNotice(
            "A payment for this order is already going through. Give it a moment — " +
              "starting another could charge you twice, so we won't."
          );
          await load();
          return;
        }
        if (err.code === "PAYMENT_UNCONFIRMED") {
          // We genuinely do not know whether the card was charged. Saying
          // "it failed" here would be a guess, and the wrong one half the time.
          setNotice(
            "We couldn't confirm that payment with the provider. Don't try again yet — " +
              "we're checking whether it went through, and this order will update itself."
          );
          await load();
          return;
        }
        setError(err.message);
        await load();
        return;
      }
      setError("Couldn't complete that payment.");
    } finally {
      setPaying(false);
    }
  }

  async function abandon() {
    setError(null);
    setCancelling(true);
    try {
      await cancelOrder(orderId);
      void refreshCart();
      router.push("/cart?cancelled=1");
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't cancel that order."
      );
      await load();
    } finally {
      setCancelling(false);
    }
  }

  if (loading || !user) {
    return <Shell><p className="text-sm text-ink-dim">Loading…</p></Shell>;
  }

  if (loadError) {
    return (
      <Shell>
        <h1 className="font-serif text-2xl font-semibold text-ink">
          We couldn&apos;t open that order
        </h1>
        <p className="mt-3 text-sm text-ink-dim">{loadError}</p>
        <Link
          href="/cart"
          className="mt-6 inline-block rounded bg-gold-dim px-5 py-2.5 text-sm font-medium text-paper transition hover:brightness-95"
        >
          Back to your cart
        </Link>
      </Shell>
    );
  }

  if (!order) {
    return <Shell><p className="text-sm text-ink-dim">Loading…</p></Shell>;
  }

  const payable = order.status === "PENDING_PAYMENT";
  const inFlight = order.status === "PROCESSING";
  const digits = cardNumber.replace(/\D/g, "");

  return (
    <Shell>
      <Link href="/cart" className="text-sm text-ink-dim transition hover:text-gold-dim">
        ← Your cart
      </Link>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Checkout
        </h1>
        <p className="text-sm text-ink-dim">
          Order <span className="font-medium text-ink">{order.reference}</span>
        </p>
      </div>

      {order.testMode && (
        <p className="mt-6 rounded-xl border border-gold/30 bg-gold/5 px-4 py-3 text-sm text-ink">
          <span className="font-medium">Sandbox payment.</span> No real money moves
          and no card is stored. Use one of the test numbers below.
        </p>
      )}

      {/* items-start so each card sizes to its own content — stretching them to
          match left a tall band of empty space under the shorter one. */}
      <div className="mt-8 grid items-start gap-8 lg:grid-cols-[1fr_360px]">
        {/* ---------------- Summary ---------------- */}
        <section className="rounded-2xl border border-line bg-paper-card p-6">
          <h2 className="text-sm font-semibold text-ink">
            {order.items.length} item{order.items.length === 1 ? "" : "s"}
          </h2>
          <div className="mt-5">
            <OrderLines order={order} />
          </div>
          <div className="mt-6 flex items-baseline justify-between border-t border-line pt-5">
            <span className="text-sm text-ink-dim">Total</span>
            <span className="text-xl font-semibold text-gold-dim">
              {formatPrice(order.subtotalCents, order.currency)}
            </span>
          </div>
          {/* Only true while the order still holds stock. A failed or cancelled
              order has already put these back in the shop, so saying otherwise
              would be a lie the buyer could check. */}
          {(payable || inFlight) && (
            <p className="mt-3 text-xs text-ink-dim">
              These items are held for you. Nobody else can buy them while this
              order is open.
            </p>
          )}
        </section>

        {/* Where it's going. On the summary side rather than the payment side,
            because it's a fact about the order, not a step in paying. */}
        <div className="lg:col-start-1">
          <ShipToCard
            shipTo={order.shipTo}
            /* Only offer a change while the order can still be replaced — the
               address is copied onto the order, so "change" means cancel and
               start again rather than edit in place. */
            changeHref={payable ? "/account/addresses" : undefined}
          />
          {payable && (
            <p className="mt-2 text-xs text-ink-dim">
              Changing your address updates your address book. This order keeps
              the address above — cancel and check out again to use a new one.
            </p>
          )}
        </div>

        {/* ---------------- Payment ---------------- */}
        <section className="rounded-2xl border border-line bg-paper-card p-6">
          {notice && (
            <p className="mb-5 rounded-xl border border-gold/30 bg-gold/5 px-4 py-3 text-sm text-ink">
              {notice}
            </p>
          )}
          {/* Suppressed when the terminal block below already states the same
              reason — a decline was being printed to the buyer twice. */}
          {error && error !== order.failureReason && (
            <p className="mb-5 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
              {error}
            </p>
          )}

          {inFlight ? (
            <>
              <h2 className="text-sm font-semibold text-ink">
                {STATUS_LABEL[order.status]}
              </h2>
              <p className="mt-3 text-sm text-ink-dim">
                A payment for this order is with the provider. We won&apos;t start
                another one — that&apos;s how people get charged twice.
              </p>
              <button
                type="button"
                onClick={load}
                className="mt-5 w-full rounded border border-line px-5 py-3 text-sm font-medium text-ink transition hover:border-gold/40"
              >
                Check again
              </button>
            </>
          ) : !payable ? (
            <>
              <h2 className="text-sm font-semibold text-ink">
                {STATUS_LABEL[order.status]}
              </h2>
              <p className="mt-3 text-sm text-ink-dim">
                {order.failureReason ??
                  "This order can no longer be paid. Your items have gone back into the shop."}
              </p>
              <Link
                href="/search"
                className="mt-5 block rounded bg-gold-dim px-5 py-3 text-center text-sm font-medium text-paper transition hover:brightness-95"
              >
                Back to the shop
              </Link>
            </>
          ) : (
            <form onSubmit={pay}>
              <h2 className="text-sm font-semibold text-ink">Card details</h2>

              <label htmlFor="cardNumber" className="mt-4 block text-xs text-ink-dim">
                Card number
              </label>
              <input
                id="cardNumber"
                name="cardNumber"
                inputMode="numeric"
                autoComplete="cc-number"
                placeholder="4242 4242 4242 4242"
                value={cardNumber}
                onChange={(e) => setCardNumber(formatCard(e.target.value))}
                className="mt-1.5 w-full rounded border border-line bg-paper px-3 py-2.5 font-mono text-sm text-ink outline-none transition placeholder:text-ink-dim/60 focus:border-gold/50"
              />

              {order.testMode && (
                <div className="mt-4">
                  <p className="text-xs text-ink-dim">Or fill a test card:</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {TEST_CARDS.map((card) => (
                      <button
                        key={card.number}
                        type="button"
                        onClick={() => setCardNumber(formatCard(card.number))}
                        className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-dim transition hover:border-gold/40 hover:text-ink"
                      >
                        {card.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={paying || digits.length < 12}
                className="mt-6 w-full rounded bg-gold-dim px-5 py-3 text-sm font-semibold text-paper transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {paying
                  ? "Taking payment…"
                  : `Pay ${formatPrice(order.subtotalCents, order.currency)}`}
              </button>

              <button
                type="button"
                onClick={abandon}
                disabled={paying || cancelling}
                className="mt-3 w-full rounded border border-line px-5 py-2.5 text-sm text-ink-dim transition hover:border-clay/40 hover:text-clay disabled:opacity-60"
              >
                {cancelling ? "Cancelling…" : "Cancel this order"}
              </button>

              <p className="mt-4 text-xs text-ink-dim">
                Cancelling puts these items straight back in the shop.
              </p>
            </form>
          )}
        </section>
      </div>
    </Shell>
  );
}

/** Groups digits in fours. Purely for legibility; the API gets the digits. */
function formatCard(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 19);
  return digits.replace(/(.{4})/g, "$1 ").trim();
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
      <Footer />
    </>
  );
}
