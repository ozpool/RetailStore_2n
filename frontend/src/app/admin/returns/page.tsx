"use client";

import { useCallback, useEffect, useState } from "react";
import AdminGate, { useAdminGate } from "@/components/admin/AdminGate";
import {
  Card,
  EmptyState,
  Pagination,
  Pill,
  SearchBox,
  Tabs,
  fullDate,
  money,
} from "@/components/admin/ui";
import {
  decideReturn,
  getReturns,
  type AdminReturnRow,
  type Paged,
  type ReturnStatus,
} from "@/lib/adminApi";
import { useDebounced } from "@/lib/useDebounced";

type StatusFilter = "ALL" | ReturnStatus;

export default function AdminReturnsPage() {
  return (
    <AdminGate
      title="Returns"
      subtitle="What buyers have asked to send back, and the refusals waiting on a decision"
    >
      {() => <Returns />}
    </AdminGate>
  );
}

/**
 * The escalation queue.
 *
 * ESCALATED is the reason this page exists. A buyer asked for money back, the
 * seller said no, and nobody else can see it: a seller sees only requests
 * against their own lines and a buyer only their own. Without this, escalation
 * would be a state with nothing able to act on it.
 *
 * Unlike the payout log, this one is NOT read-only — settling an escalation is
 * the whole job. The safety is elsewhere: approving goes through the same
 * `issueRefund` as everything else, so the over-refund guard bounds it, and a
 * rejection is terminal so the same request cannot be shopped to a second
 * moderator.
 */
function Returns() {
  const { handleError } = useAdminGate();
  const [status, setStatus] = useState<StatusFilter>("ESCALATED");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<
    (Paged<AdminReturnRow> & { byStatus: Record<string, number> }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const search = useDebounced(q, 300);

  const load = useCallback(async () => {
    try {
      setData(await getReturns({ q: search, status, page }));
      setError(null);
    } catch (err) {
      handleError(err);
      setError("Couldn't load the returns.");
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
      <p className="text-xs text-ink-dim">
        A return is a request the seller answers. <strong>Escalated</strong> ones
        are here because the seller refused and the buyer disagreed — those need
        you. <strong>Open</strong> ones are still with the seller and usually
        need nothing from anyone. Approving refunds the buyer the full price of
        the item; declining is <strong>final</strong> and cannot be escalated
        again.
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs<StatusFilter>
          value={status}
          onChange={pickStatus}
          options={[
            {
              key: "ESCALATED",
              label: `Needs you${counts.ESCALATED ? ` (${counts.ESCALATED})` : ""}`,
            },
            { key: "OPEN", label: `With the seller${counts.OPEN ? ` (${counts.OPEN})` : ""}` },
            { key: "APPROVED", label: `Refunded${counts.APPROVED ? ` (${counts.APPROVED})` : ""}` },
            { key: "REFUSED", label: `Refused${counts.REFUSED ? ` (${counts.REFUSED})` : ""}` },
            { key: "ALL", label: `Everything${data ? ` (${data.total})` : ""}` },
          ]}
        />
        <SearchBox
          value={q}
          onChange={pickQuery}
          placeholder="Buyer email, name, or order reference"
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
            title={status === "ESCALATED" ? "Nothing needs deciding" : "Nothing matches"}
            body={
              status === "ESCALATED"
                ? "No buyer has disputed a seller's refusal."
                : q
                  ? "No return for that buyer or order."
                  : "No return has been asked for yet."
            }
          />
        ) : (
          <>
            <ul className="grid gap-0 divide-y divide-line">
              {rows.map((r) => (
                <ReturnRow key={r.id} row={r} onChanged={load} />
              ))}
            </ul>
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

const TONE: Record<ReturnStatus, "good" | "warn" | "bad" | "neutral" | "info"> = {
  OPEN: "neutral",
  APPROVED: "good",
  REFUSED: "info",
  ESCALATED: "warn",
  REJECTED: "bad",
  WITHDRAWN: "neutral",
};

const LABEL: Record<ReturnStatus, string> = {
  OPEN: "With the seller",
  APPROVED: "Refunded",
  REFUSED: "Seller refused",
  ESCALATED: "Needs a decision",
  REJECTED: "Declined",
  WITHDRAWN: "Withdrawn",
};

function ReturnRow({ row, onChanged }: { row: AdminReturnRow; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "approve" | "decline">(null);
  const [error, setError] = useState<string | null>(null);

  /** Only an escalation is ours to settle. */
  const actionable = row.status === "ESCALATED";

  async function decide(approve: boolean) {
    setError(null);
    setBusy(approve ? "approve" : "decline");
    try {
      await decideReturn(row.id, { approve, note: note.trim() || undefined });
      setNote("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't settle that.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-64">
          <p className="text-sm font-medium text-ink">{row.title}</p>
          <p className="mt-0.5 text-xs text-ink-dim">
            {money(row.amountCents)} · order {row.orderReference} ·{" "}
            {fullDate(row.createdAt)}
          </p>
          <p className="mt-1 text-xs text-ink-dim">
            {row.buyer.name} ({row.buyer.email}) →{" "}
            {row.seller.name ?? "seller since removed"}
            {row.seller.email ? ` (${row.seller.email})` : ""}
          </p>
        </div>
        <Pill tone={TONE[row.status]}>{LABEL[row.status]}</Pill>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-paper px-3 py-2">
          <p className="text-xs font-medium text-ink-dim">The buyer said</p>
          <p className="mt-1 text-sm text-ink">{row.reason}</p>
          {row.notAsDescribed && (
            <p className="mt-1 text-xs text-ink-dim">Marked as not matching the listing.</p>
          )}
        </div>
        {row.decisionNote && (
          <div className="rounded-xl border border-line bg-paper px-3 py-2">
            <p className="text-xs font-medium text-ink-dim">
              {row.status === "REJECTED" || row.status === "APPROVED"
                ? "The decision"
                : "The seller said"}
            </p>
            <p className="mt-1 text-sm text-ink">{row.decisionNote}</p>
          </div>
        )}
      </div>

      {actionable && (
        <div className="mt-3 border-t border-line pt-3">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Both sides see this. Say what decided it."
            className="w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-dim/60 focus:border-gold/50"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void decide(true)}
              disabled={busy !== null}
              className="rounded-full bg-gold-dim px-4 py-1.5 text-xs font-semibold text-paper transition hover:brightness-90 disabled:opacity-60"
            >
              {busy === "approve" ? "Refunding…" : `Refund ${money(row.amountCents)}`}
            </button>
            <button
              type="button"
              onClick={() => void decide(false)}
              disabled={busy !== null || note.trim().length < 3}
              className="rounded-full border border-line px-4 py-1.5 text-xs text-ink transition hover:border-clay/40 disabled:opacity-60"
            >
              {busy === "decline" ? "Sending…" : "Decline — final"}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-ink-dim">
            Declining cannot be escalated again, so a reason is required.
          </p>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-clay">{error}</p>}
    </li>
  );
}
