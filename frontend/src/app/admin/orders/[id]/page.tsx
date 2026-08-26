"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AdminGate, { useAdminGate } from "@/components/admin/AdminGate";
import {
  Card,
  FulfilmentPill,
  OrderStatusPill,
  Pill,
  TableWrap,
  Td,
  Th,
  Tr,
  fullDate,
  money,
} from "@/components/admin/ui";
import { ApiError } from "@/lib/api";
import { getOrder, refundOrder, type OrderDetail } from "@/lib/adminApi";

export default function AdminOrderPage() {
  return (
    <AdminGate title="Order" subtitle="Everything recorded about one order">
      {() => <OrderView />}
    </AdminGate>
  );
}

function OrderView() {
  const { id } = useParams<{ id: string }>();
  const { handleError } = useAdminGate();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { order } = await getOrder(id);
      setOrder(order);
      setError(null);
    } catch (err) {
      handleError(err);
      setError("Couldn't load that order.");
    }
  }, [id, handleError]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div>
        <Back />
        <p className="mt-4 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      </div>
    );
  }
  if (!order) return <p className="text-sm text-ink-dim">Loading…</p>;

  return (
    <div className="grid gap-5">
      <Back />

      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-serif text-2xl font-semibold text-ink">{order.reference}</h2>
        <OrderStatusPill status={order.status} />
        <span className="text-sm text-ink-dim">{fullDate(order.createdAt)}</span>
      </div>

      {order.failureReason && (
        <p className="rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          Payment failed: {order.failureReason}
        </p>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        {/* ---- lines ---- */}
        {/* self-start so a short item list does not stretch to match the
            taller sidebar column, leaving a panel of empty white. */}
        <Card title="Items" className="self-start xl:col-span-2">
          <TableWrap>
            <table className="w-full">
              <thead>
                <tr className="bg-blush">
                  <Th>Item</Th>
                  <Th>Seller</Th>
                  <Th>Fulfilment</Th>
                  <Th className="text-right">Qty</Th>
                  <Th className="text-right">Line total</Th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((i) => (
                  <Tr key={i.id}>
                    <Td>
                      {i.listingSlug && !i.listingGone ? (
                        <Link
                          href={`/listing/${i.listingSlug}`}
                          className="font-medium text-ink hover:text-gold-dim hover:underline"
                        >
                          {i.title}
                        </Link>
                      ) : (
                        <span className="font-medium text-ink">{i.title}</span>
                      )}
                      {i.listingGone && (
                        <p className="mt-0.5 text-xs text-ink-dim">
                          Listing no longer exists — the title and price here are
                          the order&apos;s own copy.
                        </p>
                      )}
                      {i.fulfilmentNote && (
                        <p className="mt-1 rounded bg-blush px-2 py-1 text-xs text-ink-dim">
                          Seller: {i.fulfilmentNote}
                        </p>
                      )}
                      {i.trackingNumber && (
                        <p className="mt-1 text-xs text-ink-dim">
                          {i.carrier ?? "Tracking"} · {i.trackingNumber}
                        </p>
                      )}
                    </Td>
                    <Td>
                      {i.sellerUserId ? (
                        <Link
                          href={`/admin/customers/${i.sellerUserId}`}
                          className="hover:text-gold-dim hover:underline"
                        >
                          {i.sellerName}
                        </Link>
                      ) : (
                        i.sellerName
                      )}
                    </Td>
                    <Td>
                      {/* Fulfilment only means something once money moved. On a
                          cancelled order "Not sent" reads as a job somebody
                          still owes, when in fact there is nothing to send and
                          never was.
                          REFUNDED counts: a refunded order usually got there
                          BECAUSE the seller marked it unfulfillable, so hiding
                          that state would hide the reason. */}
                      {order.status === "PAID" || order.status === "REFUNDED" ? (
                        <>
                          <FulfilmentPill status={i.fulfilment} />
                          {i.shippedAt && (
                            <p className="mt-0.5 text-xs text-ink-dim">{fullDate(i.shippedAt)}</p>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-dim">—</span>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">{i.quantity}</Td>
                    <Td className="text-right tabular-nums">
                      {money(i.unitPriceCents * i.quantity, order.currency)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line bg-blush">
                  <Td className="font-semibold" />
                  <Td />
                  <Td />
                  <Td className="text-right text-xs font-semibold uppercase tracking-wide text-ink-dim">
                    Total
                  </Td>
                  <Td className="text-right font-semibold tabular-nums">
                    {money(order.subtotalCents, order.currency)}
                  </Td>
                </tr>
              </tfoot>
            </table>
          </TableWrap>
        </Card>

        <div className="grid content-start gap-5">
          {/* ---- buyer ---- */}
          <Card title="Buyer">
            <div className="px-5 py-4">
              <Link
                href={`/admin/customers/${order.buyer.id}`}
                className="text-sm font-medium text-ink hover:text-gold-dim hover:underline"
              >
                {order.buyer.name}
              </Link>
              <p className="mt-0.5 break-all text-sm text-ink-dim">{order.buyer.email}</p>
              <p className="mt-2 text-xs text-ink-dim">
                Joined {fullDate(order.buyer.createdAt)}
              </p>
              {order.buyer.suspendedAt && (
                <div className="mt-2">
                  <Pill tone="bad">Account suspended</Pill>
                </div>
              )}
            </div>
          </Card>

          {/* ---- address ---- */}
          <Card title="Shipping to">
            {order.shipTo ? (
              <address className="px-5 py-4 text-sm not-italic text-ink">
                {order.shipTo.name && <p className="font-medium">{order.shipTo.name}</p>}
                <p className="text-ink-dim">{order.shipTo.line1}</p>
                {order.shipTo.line2 && <p className="text-ink-dim">{order.shipTo.line2}</p>}
                <p className="text-ink-dim">
                  {[order.shipTo.city, order.shipTo.region, order.shipTo.postcode]
                    .filter(Boolean)
                    .join(", ")}
                </p>
                <p className="text-ink-dim">{order.shipTo.country}</p>
                {order.shipTo.phone && <p className="mt-1 text-ink-dim">{order.shipTo.phone}</p>}
                <p className="mt-3 border-t border-line pt-2 text-[11px] text-ink-dim">
                  A copy taken at checkout. Editing the saved address later does
                  not move a parcel that already shipped.
                </p>
              </address>
            ) : (
              <p className="px-5 py-4 text-sm text-ink-dim">
                No address — this order was never paid for.
              </p>
            )}
          </Card>

          {/* ---- payment ---- */}
          <Card title="Payment">
            <dl className="grid gap-2 px-5 py-4 text-sm">
              <Row label="Status"><OrderStatusPill status={order.status} /></Row>
              <Row label="Provider">{order.paymentProvider ?? "—"}</Row>
              <Row label="Paid at">{order.paidAt ? fullDate(order.paidAt) : "—"}</Row>
              <Row label="Reference">
                <code className="break-all font-mono text-xs text-ink-dim">
                  {order.paymentIntentId ?? "—"}
                </code>
              </Row>
            </dl>
            <p className="border-t border-line px-5 py-2.5 text-[11px] text-ink-dim">
              A pointer to the payment at the provider. No card details are
              stored here, so none can be shown — or leaked.
            </p>
          </Card>

          <RefundPanel order={order} onChanged={load} />
        </div>
      </div>
    </div>
  );
}

/**
 * Refunds already issued, and a form to issue another.
 *
 * WHY THE AMOUNT IS TYPED RATHER THAN A "REFUND EVERYTHING" BUTTON
 * The common dispute is about one line in a basket that spans several sellers.
 * A one-click full refund is the wrong default there — it takes money from
 * sellers who did their part. Typing the figure makes the decision explicit,
 * and the remaining headroom is shown so it does not have to be worked out.
 */
function RefundPanel({
  order,
  onChanged,
}: {
  order: OrderDetail;
  onChanged: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refunds = order.refunds ?? [];
  const left = order.refundableCents;

  // Typed in whole currency units because that is how a person thinks about
  // money; converted to minor units at the boundary, where every other amount
  // in this codebase lives.
  const cents = Math.round(Number(amount.replace(/[^0-9.]/g, "")) * 100);
  const valid =
    Number.isFinite(cents) && cents > 0 && cents <= left && reason.trim().length >= 3;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await refundOrder(order.id, cents, reason);
      setAmount("");
      setReason("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That refund didn't go through.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Refunds">
      {refunds.length > 0 && (
        <ul className="divide-y divide-line">
          {refunds.map((r) => (
            <li key={r.id} className="px-5 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium tabular-nums text-ink">
                  {money(r.amountCents, r.currency)}
                </span>
                <Pill
                  tone={
                    r.status === "SUCCEEDED" ? "good" : r.status === "PENDING" ? "warn" : "bad"
                  }
                >
                  {r.status === "SUCCEEDED"
                    ? "Sent"
                    : r.status === "PENDING"
                      ? "In flight"
                      : "Failed"}
                </Pill>
              </div>
              <p className="mt-1 text-xs text-ink-dim">{r.reason}</p>
              <p className="mt-0.5 text-[11px] text-ink-dim">
                {r.trigger === "SELLER_UNFULFILLABLE" ? "Automatic — seller couldn't send" : "Issued here"}
                {" · "}
                {fullDate(r.createdAt)}
              </p>
              {r.failureReason && (
                <p className="mt-1 text-[11px] text-clay">{r.failureReason}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-line px-5 py-4">
        {order.status !== "PAID" && order.status !== "REFUNDED" ? (
          <p className="text-sm text-ink-dim">
            Nothing to refund — this order was never paid for.
          </p>
        ) : left === 0 ? (
          <p className="text-sm text-ink-dim">
            Fully refunded. There is nothing left to send back.
          </p>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="refund-amount" className="block text-xs text-ink-dim">
              Amount — {money(left, order.currency)} still refundable
            </label>
            <input
              id="refund-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
              placeholder={(left / 100).toFixed(2)}
              className="mt-1.5 w-full rounded border border-line bg-paper px-3 py-2 text-sm tabular-nums text-ink outline-none placeholder:text-ink-dim/60 focus:border-gold/50 disabled:opacity-60"
            />

            <label htmlFor="refund-reason" className="mt-3 block text-xs text-ink-dim">
              Reason — the buyer sees this
            </label>
            <textarea
              id="refund-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 1000))}
              rows={2}
              disabled={busy}
              placeholder="Arrived damaged, seller unresponsive."
              className="mt-1.5 w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-dim/60 focus:border-gold/50 disabled:opacity-60"
            />

            {error && <p className="mt-2 text-sm text-clay">{error}</p>}

            <button
              type="submit"
              disabled={busy || !valid}
              className="mt-3 w-full rounded border border-clay/40 px-4 py-2.5 text-sm font-semibold text-clay transition hover:bg-clay/10 disabled:opacity-50"
            >
              {busy ? "Sending it back…" : "Refund this amount"}
            </button>

            <p className="mt-2 text-[11px] text-ink-dim">
              Recorded permanently, with your name against it. Money can take a
              few days to reach the buyer&apos;s statement.
            </p>
          </form>
        )}
      </div>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs text-ink-dim">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}

function Back() {
  return (
    <Link href="/admin/orders" className="text-sm text-ink-dim transition hover:text-gold-dim">
      ← All orders
    </Link>
  );
}
