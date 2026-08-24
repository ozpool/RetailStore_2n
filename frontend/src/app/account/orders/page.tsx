"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { OrdersIcon } from "@/components/AccountIcons";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import OrderStatusPill from "@/components/OrderStatusPill";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import { formatPrice } from "@/lib/catalog";
import { getMyOrders, isOpen, type Order } from "@/lib/ordersApi";

export default function MyOrdersPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const { orders } = await getMyOrders();
      setOrders(orders);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your orders.");
      setOrders([]);
    }
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  if (loading || !user) {
    return <Shell><p className="text-sm text-ink-dim">Loading…</p></Shell>;
  }

  return (
    <Shell>
      <Link href="/account" className="text-sm text-ink-dim transition hover:text-gold-dim">
        ← Your account
      </Link>

      <h1 className="mt-4 font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        My orders
      </h1>
      <p className="mt-3 max-w-2xl text-sm text-ink-dim">
        Every purchase you&apos;ve made, with its status and what you paid.
      </p>

      {error && (
        <p className="mt-6 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      )}

      {orders === null ? (
        <p className="mt-10 text-sm text-ink-dim">Loading…</p>
      ) : orders.length === 0 ? (
        <div className="mt-10 border border-line bg-blush p-10 text-center">
          <span
            className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-paper text-ink-dim"
            aria-hidden="true"
          >
            <OrdersIcon />
          </span>
          <p className="mt-5 text-ink">No orders yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-dim">
            Anything you buy will appear here. Items you&apos;re still holding are
            in your cart.
          </p>
          <Link
            href="/search"
            className="mt-6 inline-block rounded bg-gold-dim px-6 py-3 text-sm font-medium text-paper transition hover:brightness-95"
          >
            Browse the shop
          </Link>
        </div>
      ) : (
        <ul className="mt-8 grid gap-4">
          {orders.map((order) => (
            <li
              key={order.id}
              className="rounded-2xl border border-line bg-paper-card p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <Link
                    href={`/orders/${order.id}`}
                    className="text-sm font-medium text-ink transition hover:text-gold-dim"
                  >
                    {order.reference}
                  </Link>
                  <p className="mt-1 text-xs text-ink-dim">
                    {new Date(order.createdAt).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                    {" · "}
                    {order.items.length} item{order.items.length === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <OrderStatusPill status={order.status} />
                  <span className="text-sm font-semibold text-gold-dim">
                    {formatPrice(order.subtotalCents, order.currency)}
                  </span>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                {order.items.slice(0, 5).map((item) =>
                  item.image ? (
                    <span
                      key={item.id}
                      title={item.title}
                      className="relative h-12 w-12 overflow-hidden rounded-lg border border-line"
                    >
                      <Image
                        src={item.image}
                        alt={item.title}
                        fill
                        sizes="48px"
                        className="object-cover"
                      />
                    </span>
                  ) : (
                    <span
                      key={item.id}
                      title={item.title}
                      className="flex h-12 w-12 items-center justify-center rounded-lg border border-line bg-blush text-[9px] text-ink-dim"
                    >
                      No photo
                    </span>
                  )
                )}
                {order.items.length > 5 && (
                  <span className="text-xs text-ink-dim">
                    +{order.items.length - 5} more
                  </span>
                )}

                {isOpen(order) && (
                  <Link
                    href={`/checkout/${order.id}`}
                    className="ml-auto rounded-full border border-gold/40 px-4 py-1.5 text-xs font-medium text-gold-dim transition hover:bg-gold/5"
                  >
                    {order.status === "PROCESSING" ? "Check payment" : "Finish paying"}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-4xl">{children}</div>
      </main>
      <Footer />
    </>
  );
}
