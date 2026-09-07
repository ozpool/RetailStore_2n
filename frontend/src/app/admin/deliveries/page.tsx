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
} from "@/components/admin/ui";
import {
  getDeliveries,
  type DeliveryRow,
  type DeliveryStatus,
  type Paged,
} from "@/lib/adminApi";
import { useDebounced } from "@/lib/useDebounced";

type ChannelFilter = "ALL" | "EMAIL" | "PUSH" | "SMS";
type StatusFilter = "ALL" | DeliveryStatus;

export default function AdminDeliveriesPage() {
  return (
    <AdminGate
      title="Delivery log"
      subtitle="Which notifications reached whom, on which channel, and why not"
    >
      {() => <Deliveries />}
    </AdminGate>
  );
}

/**
 * The page that exists so "did the buyer get the refund email?" has an answer.
 *
 * Until this existed the only way to answer it was a database console, which in
 * practice meant guessing — or resending and hoping, which for SMS costs money
 * and for email costs deliverability.
 */
function Deliveries() {
  const { handleError } = useAdminGate();
  const [channel, setChannel] = useState<ChannelFilter>("ALL");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<
    (Paged<DeliveryRow> & { byStatus: Record<string, number> }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const search = useDebounced(q, 300);

  const load = useCallback(async () => {
    try {
      setData(await getDeliveries({ q: search, channel, status, page }));
      setError(null);
    } catch (err) {
      handleError(err);
      setError("Couldn't load the delivery log.");
    }
  }, [search, channel, status, page, handleError]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Changing a filter resets to page one HERE, not in an effect.
   *
   * The effect version — `setPage(1)` whenever a filter changes — renders
   * twice: once with the new filter against the old page number, then again
   * corrected. Doing it at the source is one render, and it is one fewer
   * setState-inside-an-effect for the lint ceiling to carry.
   */
  const pickChannel = (v: ChannelFilter) => {
    setChannel(v);
    setPage(1);
  };
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
        SUPPRESSED is the one that needs explaining, because it is the only
        status that is neither a success nor a fault — and somebody reading this
        table while on the phone should not have to guess.
      */}
      <p className="text-xs text-ink-dim">
        One row per notification per channel. <strong>Sent</strong> means the
        provider accepted it, not that it was read.{" "}
        <strong>Suppressed</strong> is a decision, not a fault — the recipient
        turned that channel off, had no verified number, or it was quiet hours.{" "}
        <strong>Deferred</strong> is still owed and will be sent when the quiet
        window opens.
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs<ChannelFilter>
          value={channel}
          onChange={pickChannel}
          options={[
            { key: "ALL", label: "All channels" },
            { key: "EMAIL", label: "Email" },
            { key: "PUSH", label: "Push" },
            { key: "SMS", label: "SMS" },
          ]}
        />
        <SearchBox value={q} onChange={pickQuery} placeholder="Email, name, or event id" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs<StatusFilter>
          value={status}
          onChange={pickStatus}
          options={[
            { key: "ALL", label: `Everything${data ? ` (${data.total})` : ""}` },
            { key: "SENT", label: `Sent${counts.SENT ? ` (${counts.SENT})` : ""}` },
            { key: "FAILED", label: `Failed${counts.FAILED ? ` (${counts.FAILED})` : ""}` },
            {
              key: "SUPPRESSED",
              label: `Suppressed${counts.SUPPRESSED ? ` (${counts.SUPPRESSED})` : ""}`,
            },
            {
              key: "DEFERRED",
              label: `Deferred${counts.DEFERRED ? ` (${counts.DEFERRED})` : ""}`,
            },
            {
              key: "PENDING",
              label: `In flight${counts.PENDING ? ` (${counts.PENDING})` : ""}`,
            },
          ]}
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
                ? "No delivery for that recipient or event id."
                : "No notification has been delivered on any channel yet."
            }
          />
        ) : (
          <>
            <TableWrap>
              <table className="w-full">
                <thead>
                  <tr className="bg-blush">
                    <Th>Recipient</Th>
                    <Th>Notification</Th>
                    <Th>Channel</Th>
                    <Th>Outcome</Th>
                    <Th>Why</Th>
                    <Th>When</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.id}>
                      <Td>
                        {r.recipient ? (
                          <>
                            <span className="block whitespace-nowrap">
                              {r.recipient.name}
                            </span>
                            <span className="block max-w-56 truncate text-xs text-ink-dim">
                              {r.recipient.email}
                            </span>
                          </>
                        ) : (
                          /* The delivery outlives the account, on purpose. */
                          <span className="text-ink-dim">account deleted</span>
                        )}
                      </Td>
                      <Td>
                        <span className="block max-w-64 truncate">
                          {r.notification?.title ?? "—"}
                        </span>
                        <span className="block text-xs text-ink-dim">
                          {r.notification?.type ?? r.eventId.slice(0, 8)}
                        </span>
                      </Td>
                      <Td className="whitespace-nowrap">{r.channel}</Td>
                      <Td>
                        <OutcomePill status={r.status} />
                        {r.attempts > 1 && (
                          <span className="block text-xs text-ink-dim">
                            {r.attempts} attempts
                          </span>
                        )}
                      </Td>
                      <Td>
                        <Reason row={r} />
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

function OutcomePill({ status }: { status: DeliveryStatus }) {
  /**
   * SUPPRESSED is neutral, not bad. It is the recipient's choice or a policy
   * working as intended, and painting it red would make the table look like an
   * incident every time somebody turns off review emails.
   */
  const tone =
    status === "SENT"
      ? "good"
      : status === "FAILED"
        ? "bad"
        : status === "DEFERRED" || status === "PENDING"
          ? "warn"
          : "neutral";

  const label =
    status === "PENDING" ? "In flight" : status.charAt(0) + status.slice(1).toLowerCase();

  return <Pill tone={tone}>{label}</Pill>;
}

/**
 * The reason column, which is most of the value of this page.
 *
 * "FAILED" on its own sends the reader back to a database. The provider's own
 * words are what let somebody decide whether to fix an address or wait.
 */
function Reason({ row }: { row: DeliveryRow }) {
  if (row.status === "DEFERRED") {
    return (
      <span className="block max-w-80 text-xs text-ink-dim">
        {row.suppressReason ?? "waiting"}
        {row.notBefore && <> — due {fullDate(row.notBefore)}</>}
      </span>
    );
  }
  if (row.suppressReason) {
    return <span className="block max-w-80 text-xs text-ink-dim">{row.suppressReason}</span>;
  }
  if (row.lastError) {
    return <span className="block max-w-80 text-xs text-clay">{row.lastError}</span>;
  }
  if (row.status === "SENT" && row.providerMessageId) {
    /* A reference to the provider's message, never its content. */
    return (
      <span className="block max-w-80 truncate font-mono text-[11px] text-ink-dim">
        {row.providerMessageId}
      </span>
    );
  }
  return <span className="text-ink-dim">—</span>;
}
