"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { formatPrice } from "@/lib/catalog";
import {
  confirmDelivery,
  getMyReturns,
  type MyReturn,
  type Order,
  type OrderItem,
} from "@/lib/ordersApi";
import { BUYER_FULFILMENT_LABEL } from "@/lib/salesApi";
import ReturnControl from "./ReturnControl";

/**
 * The lines of an order, shared by the payment page and the receipt.
 *
 * Everything shown comes from the order's own snapshot rather than the live
 * listing, so a seller renaming or repricing an item afterwards cannot rewrite
 * what someone sees they bought.
 *
 * Fulfilment is per line because a basket can span several sellers, and two
 * sellers cannot share one parcel — so "your order has shipped" is not a thing
 * that can honestly be said about a whole order.
 */
export default function OrderLines({
  order,
  onChanged,
}: {
  order: Order;
  /** Called after a delivery confirmation, so the parent can re-read. */
  onChanged?: () => void;
}) {
  const [returns, setReturns] = useState<MyReturn[]>([]);

  /**
   * Fetched here rather than passed in, so neither the payment page nor the
   * receipt has to know returns exist. One request for the whole order instead
   * of one per line: `GET /orders/returns` is already the buyer's whole list.
   */
  const loadReturns = useCallback(async () => {
    try {
      setReturns((await getMyReturns()).returns);
    } catch {
      // A return list that will not load must not break the receipt. The
      // control simply does not appear, which is the same as having none.
    }
  }, []);

  /**
   * Only once money has moved. Nothing is returnable on an unpaid order, so
   * asking would be a request that can only answer "none".
   */
  const settled = order.status === "PAID" || order.status === "REFUNDED";
  useEffect(() => {
    if (settled) void loadReturns();
  }, [settled, loadReturns]);

  const changed = useCallback(() => {
    void loadReturns();
    onChanged?.();
  }, [loadReturns, onChanged]);

  return (
    <ul className="grid gap-5">
      {order.items.map((item) => (
        <Line
          key={item.id}
          item={item}
          order={order}
          onChanged={changed}
          existingReturn={returns.find((r) => r.orderItemId === item.id)}
        />
      ))}
    </ul>
  );
}

function Line({
  item,
  order,
  onChanged,
  existingReturn,
}: {
  item: OrderItem;
  order: Order;
  onChanged?: () => void;
  existingReturn?: MyReturn;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paid = order.status === "PAID";

  async function confirm() {
    setError(null);
    setBusy(true);
    try {
      await confirmDelivery(item.id);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't confirm that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-start gap-4">
      <ItemImage item={item} />

      <div className="min-w-48 flex-1">
        {item.slug ? (
          <Link
            href={`/listing/${item.slug}`}
            className="text-sm font-medium text-ink transition hover:text-gold-dim"
          >
            {item.title}
          </Link>
        ) : (
          // The listing was hard-deleted. The order still has to name it.
          <span className="text-sm font-medium text-ink">{item.title}</span>
        )}
        <p className="mt-1 text-xs text-ink-dim">from {item.sellerName}</p>

        {/* Fulfilment only means anything once the money has moved. */}
        {paid && (
          <div className="mt-2">
            <span
              className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                item.fulfilment === "DELIVERED"
                  ? "border-sage/60 text-ink"
                  : item.fulfilment === "SHIPPED"
                    ? "border-gold/40 text-gold-dim"
                    : item.fulfilment === "UNFULFILLABLE"
                      ? "border-clay/40 text-clay"
                      : "border-line text-ink-dim"
              }`}
            >
              {BUYER_FULFILMENT_LABEL[item.fulfilment]}
            </span>

            {item.trackingNumber && (
              <p className="mt-1.5 text-xs text-ink-dim">
                {item.carrier ? `${item.carrier} · ` : ""}
                <span className="font-mono">{item.trackingNumber}</span>
              </p>
            )}

            {item.fulfilment === "UNFULFILLABLE" && (
              <div className="mt-2 rounded-xl border border-clay/30 bg-clay/10 px-3 py-2">
                <p className="text-xs text-clay">
                  {item.fulfilmentNote ?? "The seller couldn't send this."}
                </p>
                {/*
                  This used to say refunds "aren't automated yet", which stopped
                  being true when the seller-unfulfillable path started issuing
                  one automatically — the buyer was being told to chase a seller
                  for money already on its way back.
                */}
                <p className="mt-1 text-xs text-ink-dim">
                  You&apos;ve been refunded for this automatically. It can take a
                  few days to show on your statement.
                </p>
              </div>
            )}

            {item.fulfilment === "SHIPPED" && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={confirm}
                  disabled={busy}
                  className="rounded-full border border-line px-3 py-1 text-xs text-ink transition hover:border-gold/40 disabled:opacity-60"
                >
                  {busy ? "Confirming…" : "It arrived"}
                </button>
                {error && <p className="mt-1 text-xs text-clay">{error}</p>}
              </div>
            )}

            {item.fulfilment === "DELIVERED" && item.deliveredAt && (
              <p className="mt-1.5 text-xs text-ink-dim">
                Confirmed {new Date(item.deliveredAt).toLocaleDateString()}
              </p>
            )}

            {/*
              Returns start from the buyer's own delivery confirmation, so the
              control only exists once that has happened — which is also what
              starts the window the seller's payout hold is measured against.
              An existing request replaces the button with its own state.
            */}
            {(item.fulfilment === "DELIVERED" || existingReturn) && (
              <ReturnControl
                orderItemId={item.id}
                amountCents={item.unitPriceCents * item.quantity}
                currency={order.currency}
                existing={existingReturn}
                onChanged={onChanged}
              />
            )}
          </div>
        )}
      </div>

      <div className="text-right">
        <p className="text-sm text-ink-dim">
          {formatPrice(item.unitPriceCents, order.currency)}
          {item.quantity > 1 && ` × ${item.quantity}`}
        </p>
        {/* Only on a paid order, because that is the only state in which the
            API will accept a review. */}
        {paid && item.slug && (
          <Link
            href={`/listing/${item.slug}#reviews`}
            className="mt-1 inline-block text-xs text-gold-dim underline"
          >
            Write a review
          </Link>
        )}
      </div>
    </li>
  );
}

function ItemImage({ item }: { item: OrderItem }) {
  const frame =
    "relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-line";

  if (!item.image) {
    return (
      <span className={`${frame} flex items-center justify-center bg-blush`}>
        <span className="text-[10px] text-ink-dim">No photo</span>
      </span>
    );
  }

  const img = (
    <Image src={item.image} alt={item.title} fill sizes="64px" className="object-cover" />
  );

  return item.slug ? (
    <Link href={`/listing/${item.slug}`} className={frame}>
      {img}
    </Link>
  ) : (
    <span className={frame}>{img}</span>
  );
}
