"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AdminGate, { useAdminGate } from "@/components/admin/AdminGate";
import {
  Card,
  EmptyState,
  OrderStatusPill,
  Pill,
  RowLink,
  TableWrap,
  Td,
  Th,
  Tr,
  fullDate,
  money,
  shortDate,
} from "@/components/admin/ui";
import { ApiError } from "@/lib/api";
import {
  getCustomer,
  reinstateUser,
  suspendUser,
  type CustomerDetail,
} from "@/lib/adminApi";

export default function AdminCustomerPage() {
  return (
    <AdminGate title="Customer" subtitle="One account, and what it has done">
      {() => <CustomerView />}
    </AdminGate>
  );
}

function CustomerView() {
  const { id } = useParams<{ id: string }>();
  const { handleError } = useAdminGate();
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { customer } = await getCustomer(id);
      setCustomer(customer);
      setError(null);
    } catch (err) {
      handleError(err);
      setError("Couldn't load that account.");
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
  if (!customer) return <p className="text-sm text-ink-dim">Loading…</p>;

  return (
    <div className="grid gap-5">
      <Back />

      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-serif text-2xl font-semibold text-ink">{customer.name}</h2>
        {customer.role === "ADMIN" && <Pill tone="info">Admin</Pill>}
        {customer.isSeller && <Pill tone="neutral">Seller</Pill>}
        {customer.suspendedAt && <Pill tone="bad">Suspended</Pill>}
        {!customer.emailVerified && <Pill tone="warn">Email unverified</Pill>}
      </div>
      <p className="-mt-3 break-all text-sm text-ink-dim">{customer.email}</p>

      {customer.suspendedAt && (
        <p className="rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          Suspended {fullDate(customer.suspendedAt)} — {customer.suspendedReason}
        </p>
      )}

      <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Lifetime spend" value={money(customer.lifetimeSpendCents)} note="Paid orders only" />
        <Stat label="Paid orders" value={String(customer.paidOrders)} />
        <Stat label="Joined" value={shortDate(customer.createdAt)} note={new Date(customer.createdAt).getFullYear().toString()} />
        <Stat
          label="Reports against"
          value={String(customer.reportsAgainst)}
          note={customer.reportsAgainst > 0 ? "Check the queue" : undefined}
        />
      </dl>

      <div className="grid gap-5 xl:grid-cols-3">
        {/* self-start: a short order list should not stretch to match the
            taller sidebar column. */}
        <Card title="Recent orders" className="self-start xl:col-span-2">
          {customer.recentOrders.length === 0 ? (
            <EmptyState title="Never ordered" />
          ) : (
            <TableWrap>
              <table className="w-full">
                <thead>
                  <tr className="bg-blush">
                    <Th>Order</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Total</Th>
                    <Th>Placed</Th>
                  </tr>
                </thead>
                <tbody>
                  {customer.recentOrders.map((o) => (
                    <Tr key={o.id} href={`/admin/orders/${o.id}`}>
                      <Td><RowLink href={`/admin/orders/${o.id}`}>{o.reference}</RowLink></Td>
                      <Td><OrderStatusPill status={o.status} /></Td>
                      <Td className="text-right tabular-nums">{money(o.subtotalCents)}</Td>
                      <Td className="whitespace-nowrap text-ink-dim">{shortDate(o.createdAt)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <div className="grid content-start gap-5">
          {customer.sellerProfile && (
            <Card title="Shop">
              <dl className="grid gap-2 px-5 py-4 text-sm">
                <Row label="Name">{customer.sellerProfile.shopName}</Row>
                <Row label="Listings">{customer.sellerProfile._count.listings}</Row>
                <Row label="Items sold">{customer.sellerProfile._count.sales}</Row>
                <Row label="ID check">
                  <Pill tone={customer.sellerProfile.kycStatus === "VERIFIED" ? "good" : customer.sellerProfile.kycStatus === "REJECTED" ? "bad" : "neutral"}>
                    {customer.sellerProfile.kycStatus}
                  </Pill>
                </Row>
                <Row label="Payouts">
                  <Pill tone={customer.sellerProfile.payoutsEnabled ? "good" : "neutral"}>
                    {customer.sellerProfile.payoutsEnabled ? "Unlocked" : "Locked"}
                  </Pill>
                </Row>
              </dl>
            </Card>
          )}

          <ModerationPanel customer={customer} onChanged={load} />
        </div>
      </div>
    </div>
  );
}

/**
 * Suspend or reinstate, with the reason the person will see.
 *
 * The action is disabled until a reason is typed. Not politeness — an audit row
 * that says only "suspended by sam" is unusable six months later when someone
 * asks why, and the person affected is entitled to know what they did.
 */
function ModerationPanel({
  customer,
  onChanged,
}: {
  customer: CustomerDetail;
  onChanged: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suspended = customer.suspendedAt !== null;
  const isAdmin = customer.role === "ADMIN";

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      setReason("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  // "Suspend" over a panel explaining that admins cannot be suspended reads as
  // a contradiction. The heading has to agree with what is underneath it.
  const heading = isAdmin ? "Account actions" : suspended ? "Reinstate" : "Suspend";

  return (
    <Card title={heading}>
      <div className="px-5 py-4">
        {isAdmin ? (
          <p className="text-sm text-ink-dim">
            Admins can&apos;t be suspended from here. Revoke the role first with{" "}
            <code className="rounded bg-blush px-1.5 py-0.5 font-mono text-xs">
              npm run admin:revoke
            </code>{" "}
            — which needs shell access to the server, not just this panel.
          </p>
        ) : (
          <>
            <label htmlFor="mod-reason" className="block text-xs text-ink-dim">
              Reason — {suspended ? "recorded in the audit log" : "the person sees this when they try to sign in"}
            </label>
            <textarea
              id="mod-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 1000))}
              rows={3}
              disabled={busy}
              placeholder={suspended ? "Appeal upheld." : "Repeatedly listing prohibited items."}
              className="mt-1.5 w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-dim/60 focus:border-gold/50 disabled:opacity-60"
            />

            {error && <p className="mt-2 text-sm text-clay">{error}</p>}

            <button
              type="button"
              disabled={busy || reason.trim().length < 3}
              onClick={() =>
                run(() =>
                  suspended
                    ? reinstateUser(customer.id, reason)
                    : suspendUser(customer.id, reason)
                )
              }
              className={`mt-3 w-full rounded px-4 py-2.5 text-sm font-semibold transition disabled:opacity-50 ${
                suspended
                  ? "bg-ink text-paper hover:brightness-125"
                  : "border border-clay/40 text-clay hover:bg-clay/10"
              }`}
            >
              {busy
                ? "Working…"
                : suspended
                  ? "Reinstate this account"
                  : "Suspend this account"}
            </button>

            <p className="mt-2 text-[11px] text-ink-dim">
              Suspending blocks sign-in. It does not delete anything — their
              orders and reviews stay, because other people&apos;s receipts
              depend on them.
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-line bg-paper-card p-4">
      <dt className="text-xs text-ink-dim">{label}</dt>
      <dd className="mt-1 font-serif text-2xl font-semibold tabular-nums text-ink">{value}</dd>
      {note && <p className="mt-0.5 text-[11px] text-ink-dim">{note}</p>}
    </div>
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
    <Link href="/admin/customers" className="text-sm text-ink-dim transition hover:text-gold-dim">
      ← All customers
    </Link>
  );
}
