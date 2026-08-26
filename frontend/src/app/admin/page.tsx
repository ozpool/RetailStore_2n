"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AdminGate, { useAdminGate } from "@/components/admin/AdminGate";
import SalesChart from "@/components/admin/SalesChart";
import {
  Card,
  EmptyState,
  OrderStatusPill,
  Pill,
  RowLink,
  TableWrap,
  Tabs,
  Td,
  Th,
  Tr,
  money,
  shortDate,
} from "@/components/admin/ui";
import { getMetrics, type Metrics, type Range } from "@/lib/adminApi";

export default function AdminDashboardPage() {
  return (
    <AdminGate title="Dashboard" subtitle="How the shop is doing">
      {() => <Dashboard />}
    </AdminGate>
  );
}

function Dashboard() {
  const { handleError } = useAdminGate();
  const [days, setDays] = useState<Range>(30);
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getMetrics(days));
      setError(null);
    } catch (err) {
      handleError(err);
      setError("Couldn't load the dashboard.");
    }
  }, [days, handleError]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return <p className="rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">{error}</p>;
  }
  if (!data) {
    return <p className="text-sm text-ink-dim">Loading…</p>;
  }

  const needs = data.attention;
  const totalNeeds =
    needs.openReports +
    needs.escalatedReturns +
    needs.unfulfilledOver3Days +
    needs.stuckPayments +
    needs.rejectedKyc;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs<Range>
          value={days}
          onChange={setDays}
          options={[
            { key: 7, label: "7 days" },
            { key: 30, label: "30 days" },
            { key: 90, label: "90 days" },
          ]}
        />
        {/* The countdown in the header says how much time is LEFT. This says
            what the session is — thirty minutes, separate from the shopping
            one, and recorded. Restyling dropped it, and a bare "29:41" does
            not tell a first-time moderator any of that. */}
        <p className="text-xs text-ink-dim">
          This session lasts thirty minutes and is separate from your shopping
          session. Every action is recorded with your name and reason.
        </p>
      </div>

      {/* ---- headline numbers ---- */}
      <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat
          label="Gross sales"
          value={money(data.grossCents)}
          delta={data.deltas.gross}
          note="Paid orders only"
        />
        <Stat label="Orders" value={data.orders.toLocaleString()} delta={data.deltas.orders} note={`${data.buyers} buyer${data.buyers === 1 ? "" : "s"}`} />
        <Stat label="Average order" value={money(data.aovCents)} delta={data.deltas.aov} />
        {/**
         * Refunds sit beside gross rather than being subtracted from it.
         *
         * A fully refunded order drops out of gross on its own; a partly
         * refunded one does not, because it is still PAID. Showing both means
         * the reader can subtract knowingly instead of being handed a net
         * figure that hides how much went back.
         */}
        <Stat
          label="Refunded"
          value={money(data.refundedCents)}
          delta={data.deltas.refunded}
          note="Not deducted above"
        />
        <Stat label="New accounts" value={data.newUsers.toLocaleString()} delta={data.deltas.newUsers} />
      </dl>

      {/* ---- chart + attention ---- */}
      <div className="grid gap-5 xl:grid-cols-3">
        <Card title="Gross sales" className="xl:col-span-2">
          <SalesChart series={data.series} />
          <p className="border-t border-line px-5 py-2.5 text-[11px] text-ink-dim">
            Money that moved through the shop. RetailStore_2n takes no cut, so this is
            what sellers earned — not platform revenue.
          </p>
        </Card>

        <Card title="Needs attention">
          {totalNeeds === 0 && needs.failedPayments === 0 ? (
            <EmptyState
              title="Nothing waiting"
              body="No open reports, no disputed returns, no late parcels, no stuck payments."
            />
          ) : (
            <ul className="divide-y divide-line">
              <Attention
                count={needs.openReports}
                label="Open reports"
                href="/admin/reports"
                tone="bad"
              />
              {/*
                First among equals in urgency: a buyer has disputed a seller's
                refusal and nothing in the system will ever move it on its own.
                There is no timer here, deliberately, so this count is the only
                thing that surfaces one.
              */}
              <Attention
                count={needs.escalatedReturns}
                label="Returns needing a decision"
                href="/admin/returns"
                tone="bad"
              />
              <Attention
                count={needs.unfulfilledOver3Days}
                label="Unsent for over 3 days"
                href="/admin/orders?status=PAID"
                tone="warn"
              />
              <Attention
                count={needs.stuckPayments}
                label="Payments stuck mid-flight"
                href="/admin/orders?status=PROCESSING"
                tone="bad"
                hint="The sweeper should clear these. A number that stays put means it isn't running."
              />
              <Attention
                count={needs.rejectedKyc}
                label="Sellers who failed ID checks"
                tone="warn"
              />
              <Attention
                count={needs.failedPayments}
                label="Failed payments this week"
                href="/admin/orders?status=FAILED"
                tone="neutral"
                hint="Declines are normal. A spike is not."
              />
            </ul>
          )}
        </Card>
      </div>

      {/* ---- recent orders + top sellers ---- */}
      <div className="grid gap-5 xl:grid-cols-3">
        <Card
          title="Recent orders"
          className="xl:col-span-2"
          action={
            <Link href="/admin/orders" className="text-xs font-medium text-gold-dim hover:underline">
              View all
            </Link>
          }
        >
          {data.recentOrders.length === 0 ? (
            <EmptyState title="No orders yet" />
          ) : (
            <TableWrap>
              <table className="w-full">
                <thead>
                  <tr className="bg-blush">
                    <Th>Order</Th>
                    <Th>Buyer</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Total</Th>
                    <Th>Placed</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentOrders.map((o) => (
                    <Tr key={o.id} href={`/admin/orders/${o.id}`}>
                      <Td>
                        <RowLink href={`/admin/orders/${o.id}`}>{o.reference}</RowLink>
                        <p className="text-xs text-ink-dim">
                          {o.units} item{o.units === 1 ? "" : "s"}
                        </p>
                      </Td>
                      <Td>
                        <span className="block max-w-56 truncate">{o.buyerName}</span>
                      </Td>
                      <Td><OrderStatusPill status={o.status} /></Td>
                      <Td className="text-right tabular-nums">{money(o.subtotalCents, o.currency)}</Td>
                      <Td className="whitespace-nowrap text-ink-dim">{shortDate(o.createdAt)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card title="Top sellers">
          {data.topSellers.length === 0 ? (
            <EmptyState title="Nothing sold yet" body="Sellers appear here once an order is paid for." />
          ) : (
            <ol className="divide-y divide-line">
              {data.topSellers.map((s, i) => (
                <li key={s.sellerId} className="flex items-center gap-3 px-5 py-3">
                  <span className="w-4 shrink-0 text-xs font-semibold text-ink-dim">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/admin/customers/${s.userId}`}
                      className="block truncate text-sm font-medium text-ink hover:text-gold-dim hover:underline"
                    >
                      {s.shopName}
                    </Link>
                    <p className="text-xs text-ink-dim">
                      {s.units} item{s.units === 1 ? "" : "s"}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">
                    {money(s.grossCents)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Stat({
  label,
  value,
  delta,
  note,
}: {
  label: string;
  value: string;
  delta?: number | null;
  note?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-paper-card p-4">
      <dt className="text-xs text-ink-dim">{label}</dt>
      <dd className="mt-1 font-serif text-2xl font-semibold tabular-nums text-ink">{value}</dd>
      <div className="mt-1.5 flex items-center gap-2">
        <Delta value={delta} />
        {note && <span className="text-[11px] text-ink-dim">{note}</span>}
      </div>
    </div>
  );
}

/**
 * Change against the period before this one.
 *
 * A null delta renders as a dash, not as +100%. The prior period having no
 * sales at all is not growth, and a dashboard that says otherwise is one
 * someone will eventually forecast against.
 */
function Delta({ value }: { value?: number | null }) {
  if (value === undefined) return null;
  if (value === null) {
    return <span className="text-[11px] text-ink-dim" title="Nothing to compare against">—</span>;
  }
  const up = value > 0;
  const flat = value === 0;
  return (
    <span
      className={`text-[11px] font-medium tabular-nums ${
        flat ? "text-ink-dim" : up ? "text-sage-dim" : "text-clay"
      }`}
    >
      {flat ? "no change" : `${up ? "↑" : "↓"} ${Math.abs(value)}%`}
    </span>
  );
}

function Attention({
  count,
  label,
  href,
  tone,
  hint,
}: {
  count: number;
  label: string;
  href?: string;
  tone: "bad" | "warn" | "neutral";
  hint?: string;
}) {
  // Zero rows stay visible but recede. Hiding them would make the panel's
  // shape change every load, and "no stuck payments" is worth seeing.
  const quiet = count === 0;
  const body = (
    <>
      <span className="flex items-center gap-2">
        <Pill tone={quiet ? "neutral" : tone}>{count}</Pill>
        <span className={`text-sm ${quiet ? "text-ink-dim" : "font-medium text-ink"}`}>{label}</span>
      </span>
      {hint && !quiet && <span className="mt-1 block text-[11px] text-ink-dim">{hint}</span>}
    </>
  );

  return (
    <li>
      {href && !quiet ? (
        <Link href={href} className="block px-5 py-3 transition hover:bg-blush">
          {body}
        </Link>
      ) : (
        <div className="px-5 py-3">{body}</div>
      )}
    </li>
  );
}
