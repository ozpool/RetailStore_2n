"use client";

import { useCallback, useEffect, useState } from "react";
import AdminGate, { useAdminGate } from "@/components/admin/AdminGate";
import {
  Card,
  EmptyState,
  Pagination,
  Pill,
  SearchBox,
  TableWrap,
  Tabs,
  Td,
  Th,
  Tr,
  fullDate,
  money,
} from "@/components/admin/ui";
import {
  getPayoutLog,
  type AdminPayoutRow,
  type Paged,
  type PayoutStatus,
  type PayoutTotals,
} from "@/lib/adminApi";
import { useDebounced } from "@/lib/useDebounced";

type StatusFilter = "ALL" | PayoutStatus;

export default function AdminPayoutsPage() {
  return (
    <AdminGate
      title="Payout log"
      subtitle="Money sent to sellers, what it covered, and what didn't land"
    >
      {() => <Payouts />}
    </AdminGate>
  );
}

/**
 * The reconciliation view.
 *
 * A seller's own payout page answers "where is my money". This answers the
 * question asked against a bank statement — what did we send, to whom, did it
 * land — which no seller can answer, because the interesting row is usually
 * somebody else's failed transfer.
 *
 * READ ONLY. There is no retry button: retrying a payout means moving money,
 * and the only safe way to do that is the seller's own claim-then-transfer
 * path, which cannot pay the same item twice. A button here that transferred
 * directly would bypass the claim and become the one way to double-pay.
 */
function Payouts() {
  const { handleError } = useAdminGate();
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [data, setData] = useState<
    | (Paged<AdminPayoutRow> & {
        byStatus: Record<string, number>;
        totals: PayoutTotals;
      })
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const search = useDebounced(q, 300);

  const load = useCallback(async () => {
    try {
      setData(await getPayoutLog({ q: search, status, page }));
      setError(null);
    } catch (err) {
      handleError(err);
      setError("Couldn't load the payout log.");
    }
  }, [search, status, page, handleError]);

  useEffect(() => {
    load();
  }, [load]);

  /** Page one on a filter change, at the source rather than in an effect. */
  const pickStatus = (v: StatusFilter) => {
    setStatus(v);
    setPage(1);
  };
  const pickQuery = (v: string) => {
    setQ(v);
    setPage(1);
  };

  const rows = data?.rows ?? [];
  const counts = data?.byStatus ?? {};

  return (
    <div className="grid gap-4">
      {/*
        PENDING is the status that needs watching. It means a transfer was
        claimed and the provider hasn't confirmed it — fine for a moment, a
        stuck payout after an hour. Nothing sweeps it automatically, so this
        count is how anybody finds out.
      */}
      <p className="text-xs text-ink-dim">
        One row per payout. <strong>Paid</strong> means the provider accepted the
        transfer. <strong>In flight</strong> means it was claimed and not yet
        confirmed — the items are locked to it, so nothing can be paid twice
        while it sits there. <strong>Failed</strong> released nothing: those
        items become payable again.
      </p>

      {data && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Figure
            label="Sent"
            value={money(data.totals.paidCents)}
            hint="Across every payout matching this filter."
          />
          <Figure
            label="Netted off"
            value={money(data.totals.nettedCents)}
            hint="Kept back to settle refunds. Never left the account."
          />
          <Figure
            label="Outstanding debt"
            value={money(data.totals.outstandingDebtCents)}
            hint="Refunded after payout, not yet recovered. Platform-wide."
          />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs<StatusFilter>
          value={status}
          onChange={pickStatus}
          options={[
            { key: "ALL", label: `Everything${data ? ` (${data.total})` : ""}` },
            { key: "PAID", label: `Paid${counts.PAID ? ` (${counts.PAID})` : ""}` },
            {
              key: "PENDING",
              label: `In flight${counts.PENDING ? ` (${counts.PENDING})` : ""}`,
            },
            { key: "FAILED", label: `Failed${counts.FAILED ? ` (${counts.FAILED})` : ""}` },
          ]}
        />
        <SearchBox
          value={q}
          onChange={pickQuery}
          placeholder="Seller email, name, payout or transfer id"
        />
      </div>

      {error && (
        <p className="rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      )}

      <Card>
        {data === null ? (
          <p className="px-5 py-14 text-center text-sm text-ink-dim">Loading…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing matches"
            body={
              q
                ? "No payout for that seller, payout id or transfer id."
                : "No payout has been requested yet."
            }
          />
        ) : (
          <>
            <TableWrap>
              <table className="w-full">
                <thead>
                  <tr className="bg-blush">
                    <Th>Seller</Th>
                    <Th>Amount</Th>
                    <Th>Outcome</Th>
                    <Th>Covered</Th>
                    <Th>Provider</Th>
                    <Th>When</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.id}>
                      <Td>
                        <span className="block whitespace-nowrap">{r.seller.name}</span>
                        <span className="block max-w-56 truncate text-xs text-ink-dim">
                          {r.seller.email}
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap">
                        <span className="font-medium">{money(r.amountCents, r.currency)}</span>
                        {r.nettedCents > 0 && (
                          <span className="block text-xs text-ink-dim">
                            {money(r.nettedCents, r.currency)} netted off
                          </span>
                        )}
                      </Td>
                      <Td>
                        <OutcomePill status={r.status} />
                        {r.failureReason && (
                          <span className="block max-w-64 text-xs text-clay">
                            {r.failureReason}
                          </span>
                        )}
                      </Td>
                      <Td>
                        <button
                          type="button"
                          onClick={() => setOpen(open === r.id ? null : r.id)}
                          className="text-left text-xs text-gold-dim hover:underline"
                        >
                          {r.itemCount} {r.itemCount === 1 ? "item" : "items"}
                          {open === r.id ? " ▴" : " ▾"}
                        </button>
                        {r.reversedCents > 0 && (
                          <span className="block text-xs text-clay">
                            {money(r.reversedCents, r.currency)} refunded since
                          </span>
                        )}
                        {open === r.id && (
                          <ul className="mt-2 grid gap-1">
                            {r.items.map((i) => (
                              <li key={i.orderItemId} className="text-xs text-ink-dim">
                                <span className="font-mono">{i.orderItemId.slice(0, 8)}</span>{" "}
                                {money(i.amountCents, r.currency)}
                                {i.reversedAt && (
                                  <span className="text-clay">
                                    {" "}
                                    · refunded {fullDate(i.reversedAt)}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </Td>
                      <Td>
                        {/* Both ids, because reconciliation ends in the
                            provider's dashboard and these are what it wants. */}
                        <span className="block max-w-48 truncate font-mono text-[11px] text-ink-dim">
                          {r.providerTransferId ?? "—"}
                        </span>
                        <span className="block max-w-48 truncate font-mono text-[11px] text-ink-dim">
                          {r.connectAccountId ?? "no account"}
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap text-ink-dim">
                        {fullDate(r.completedAt ?? r.createdAt)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <Pagination
              page={data.page}
              pages={data.pages}
              total={data.total}
              pageSize={data.pageSize}
              onPage={setPage}
            />
          </>
        )}
      </Card>
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border border-line bg-paper-card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-dim">{label}</p>
      <p className="mt-1 font-serif text-xl font-medium text-ink">{value}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-dim">{hint}</p>
    </div>
  );
}

function OutcomePill({ status }: { status: PayoutStatus }) {
  /**
   * PENDING is amber rather than neutral. Unlike a suppressed notification it
   * is not a settled outcome — it is money in an unknown state, and it should
   * look like something to check.
   */
  const tone = status === "PAID" ? "good" : status === "FAILED" ? "bad" : "warn";
  const label = status === "PENDING" ? "In flight" : status === "PAID" ? "Paid" : "Failed";
  return <Pill tone={tone}>{label}</Pill>;
}
