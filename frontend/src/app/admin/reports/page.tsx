"use client";

import { useCallback, useEffect, useState } from "react";
import AdminGate, { useAdminGate } from "@/components/admin/AdminGate";
import { Card, EmptyState, Pill, Tabs, fullDate } from "@/components/admin/ui";
import { ApiError } from "@/lib/api";
import {
  REASON_LABEL,
  getReports,
  removeListing,
  removeReview,
  resolveReport,
  suspendUser,
  type Report,
} from "@/lib/adminApi";

type Tab = "OPEN" | "RESOLVED" | "DISMISSED" | "ALL";

export default function AdminReportsPage() {
  return (
    <AdminGate title="Reports" subtitle="What people have flagged">
      {() => <Reports />}
    </AdminGate>
  );
}

/**
 * The report queue, oldest first.
 *
 * Worked newest-first, the oldest complaint stays permanently at the bottom —
 * the person who waited longest is the one who keeps waiting.
 */
function Reports() {
  const { handleError } = useAdminGate();
  const [tab, setTab] = useState<Tab>("OPEN");
  const [reports, setReports] = useState<Report[] | null>(null);
  const [counts, setCounts] = useState({ open: 0, resolved: 0, dismissed: 0 });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getReports(tab);
      setReports(data.reports);
      setCounts(data.counts);
      setError(null);
    } catch (err) {
      handleError(err);
      setError("Couldn't load reports.");
      setReports([]);
    }
  }, [tab, handleError]);

  useEffect(() => {
    load();
  }, [load]);

  const list = reports ?? [];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { key: "OPEN", label: "Open", count: counts.open },
            { key: "RESOLVED", label: "Resolved" },
            { key: "DISMISSED", label: "Dismissed" },
            { key: "ALL", label: "All" },
          ]}
        />
        <p className="text-xs text-ink-dim">
          Every action needs a reason, and the person affected sees what you write.
        </p>
      </div>

      {error && (
        <p className="rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">{error}</p>
      )}

      {reports === null ? (
        <Card><p className="px-5 py-14 text-center text-sm text-ink-dim">Loading…</p></Card>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            title={tab === "OPEN" ? "Nothing waiting" : "Nothing here"}
            body={
              tab === "OPEN"
                ? "The queue is empty."
                : "Reports appear here once they've been closed."
            }
          />
        </Card>
      ) : (
        <ul className="grid gap-4">
          {list.map((r) => (
            <ReportCard key={r.id} report={r} onChanged={load} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ReportCard({ report, onChanged }: { report: Report; onChanged: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = report.status === "OPEN";

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

  /**
   * Acting and closing happen together.
   *
   * A removal that leaves the report open means the next moderator sees it and
   * has to work out whether anything was done. Closing it with the same reason
   * keeps the two in step.
   */
  async function actAndClose(action: () => Promise<unknown>, outcome: string) {
    await run(async () => {
      await action();
      await resolveReport(report.id, outcome, false);
    });
  }

  const TARGET_LABEL = { LISTING: "Listing", REVIEW: "Review", USER: "Account" } as const;

  return (
    <li>
      <Card className={open ? "border-gold/40" : undefined}>
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
          <div className="min-w-56 flex-1">
            <p className="text-sm font-medium text-ink">
              {TARGET_LABEL[report.targetType]}: {report.targetLabel}
            </p>
            <p className="mt-1 text-sm text-gold-dim">
              {REASON_LABEL[report.reason] ?? report.reason}
            </p>
            {report.detail && (
              <p className="mt-2 rounded-lg bg-blush px-3 py-2 text-sm text-ink-dim">
                &ldquo;{report.detail}&rdquo;
              </p>
            )}
            <p className="mt-2 text-xs text-ink-dim">
              Reported by {report.reporterName} · {fullDate(report.createdAt)}
            </p>
          </div>

          <Pill tone={open ? "info" : report.status === "DISMISSED" ? "neutral" : "good"}>
            {report.status}
          </Pill>
        </div>

        {report.resolution && (
          <p className="border-t border-line bg-blush px-5 py-2.5 text-xs text-ink-dim">
            Outcome: {report.resolution}
          </p>
        )}

        {open && (
          <div className="border-t border-line px-5 py-4">
            {error && <p className="mb-3 text-sm text-clay">{error}</p>}

            <label htmlFor={`reason-${report.id}`} className="block text-xs text-ink-dim">
              Reason — the person affected sees this
            </label>
            <textarea
              id={`reason-${report.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 1000))}
              rows={2}
              disabled={busy}
              placeholder="Photos don't match the description."
              className="mt-1 w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-dim/60 focus:border-gold/50 disabled:opacity-60"
            />

            <div className="mt-3 flex flex-wrap gap-2">
              {report.targetType === "LISTING" && (
                <Danger
                  disabled={busy || reason.trim().length < 3}
                  onClick={() =>
                    actAndClose(
                      () => removeListing(report.targetId, reason, report.id),
                      `Listing removed: ${reason}`
                    )
                  }
                >
                  Remove listing
                </Danger>
              )}

              {report.targetType === "REVIEW" && (
                <Danger
                  disabled={busy || reason.trim().length < 3}
                  onClick={() =>
                    actAndClose(
                      () => removeReview(report.targetId, reason, report.id),
                      `Review removed: ${reason}`
                    )
                  }
                >
                  Remove review
                </Danger>
              )}

              {report.targetType === "USER" && (
                <Danger
                  disabled={busy || reason.trim().length < 3}
                  onClick={() =>
                    actAndClose(
                      () => suspendUser(report.targetId, reason, report.id),
                      `Account suspended: ${reason}`
                    )
                  }
                >
                  Suspend account
                </Danger>
              )}

              <button
                type="button"
                disabled={busy || reason.trim().length < 3}
                onClick={() => run(() => resolveReport(report.id, reason, true))}
                className="rounded border border-line px-4 py-2 text-sm text-ink transition hover:border-gold/40 disabled:opacity-50"
              >
                Nothing wrong — dismiss
              </button>
            </div>

            <p className="mt-2 text-[11px] text-ink-dim">
              Dismissing is a decision too. It records that someone looked and
              found nothing, rather than leaving the queue looking unfinished.
            </p>
          </div>
        )}
      </Card>
    </li>
  );
}

function Danger({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded border border-clay/40 px-4 py-2 text-sm font-medium text-clay transition hover:bg-clay/10 disabled:opacity-50"
    >
      {children}
    </button>
  );
}
