"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import AdminGate from "@/components/admin/AdminGate";
import { Card, EmptyState, Pill, Tabs, fullDate, money } from "@/components/admin/ui";
import ThreadView from "@/components/ThreadView";
import { ApiError } from "@/lib/api";
import {
  ADMIN_SLOT_LABEL,
  closeAdminThread,
  getAdminThread,
  getAdminThreads,
  reopenAdminThread,
  replyAsAdmin,
  type AdminThread,
  type AdminThreadDetail,
} from "@/lib/adminApi";

type Tab = "UNANSWERED" | "ALL";

export default function AdminMessagesPage() {
  return (
    <AdminGate title="Messages" subtitle="What sellers are asking">
      {() => (
        <Suspense fallback={<p className="text-sm text-ink-dim">Loading…</p>}>
          <Messages />
        </Suspense>
      )}
    </AdminGate>
  );
}

function Messages() {
  const params = useSearchParams();
  const requested = params.get("thread");

  const [tab, setTab] = useState<Tab>("UNANSWERED");
  const [threads, setThreads] = useState<AdminThread[] | null>(null);
  const [selected, setSelected] = useState<AdminThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** See the note in admin/placements: the fetch lives in the effect so no
   *  effect depends on a callback that setStates. */
  const [reloads, setReloads] = useState(0);
  const reload = () => setReloads((n) => n + 1);

  const open = useCallback(async (id: string) => {
    try {
      const { thread } = await getAdminThread(id);
      setSelected(thread);
      /**
       * One counter for the whole role, so reading it here clears the badge for
       * every moderator. ADR 0033 accepts that: the first to read takes it off
       * the queue for all of them.
       */
      setThreads((rows) => rows?.map((r) => (r.id === id ? { ...r, unread: 0 } : r)) ?? rows);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open that conversation.");
    }
  }, []);

  useEffect(() => {
    let alive = true;
    getAdminThreads(tab === "UNANSWERED")
      .then(({ threads: rows }) => {
        if (alive) setThreads(rows);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof ApiError ? err.message : "Could not load the queue.");
        setThreads([]);
      });
    return () => {
      alive = false;
    };
  }, [tab, reloads]);

  /**
   * Deep link from the placement queue, so a decision and its thread are one
   * click apart. Inlined for the same reason as the load above — `open` is a
   * callback that setStates, and an effect must not depend on one.
   */
  useEffect(() => {
    if (!requested) return;
    let alive = true;
    getAdminThread(requested)
      .then(({ thread }) => {
        if (!alive) return;
        setSelected(thread);
        setThreads((rows) => rows?.map((r) => (r.id === requested ? { ...r, unread: 0 } : r)) ?? rows);
      })
      .catch((err: unknown) => {
        if (alive) {
          setError(err instanceof ApiError ? err.message : "Could not open that conversation.");
        }
      });
    return () => {
      alive = false;
    };
  }, [requested]);

  return (
    <div className="flex flex-col gap-6">
      <Tabs
        value={tab}
        onChange={(t) => setTab(t)}
        options={[
          { key: "UNANSWERED", label: "Needs a reply" },
          { key: "ALL", label: "All open" },
        ]}
      />

      {error && <p className="text-sm text-clay">{error}</p>}

      <div className="grid gap-6 lg:grid-cols-[24rem_1fr]">
        <aside className="flex flex-col gap-2">
          {threads === null && <p className="text-sm text-ink-dim">Loading…</p>}
          {threads?.length === 0 && (
            <EmptyState title="Nothing waiting" body="No seller is waiting on a reply." />
          )}
          {threads?.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => void open(t.id)}
              className={`rounded border px-4 py-3 text-left transition ${
                selected?.id === t.id ? "border-ink bg-blush" : "border-line hover:border-ink"
              }`}
            >
              <p className="flex items-center gap-2 text-sm font-medium">
                {t.subject}
                {t.unread > 0 && (
                  <span className="rounded-full bg-clay px-2 py-0.5 text-xs text-paper">
                    {t.unread}
                  </span>
                )}
              </p>
              <p className="mt-1 text-xs text-ink-dim">
                {t.seller.shopName ?? "A seller"} · {fullDate(t.lastMessageAt)}
              </p>
              {t.placement && (
                <p className="mt-1 text-xs">
                  <Pill tone="warn">{t.placement.status}</Pill>{" "}
                  {ADMIN_SLOT_LABEL[t.placement.slot]} · {money(t.placement.offeredCents)}
                </p>
              )}
            </button>
          ))}
        </aside>

        <section>
          {selected === null ? (
            <EmptyState title="Pick a conversation" body="Its messages appear here." />
          ) : (
            <Card title={selected.subject}>
              <div className="flex flex-col gap-5">
                <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-dim">
                  <span>{selected.seller.shopName ?? "A seller"}</span>
                  <div className="flex gap-3">
                    {selected.closedAt === null ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          closeAdminThread(selected.id)
                            .then(() => open(selected.id))
                            .then(() => reload())
                            .catch((err: unknown) =>
                              setError(err instanceof ApiError ? err.message : "Could not close it.")
                            )
                            .finally(() => setBusy(false));
                        }}
                        className="underline disabled:opacity-50"
                      >
                        Close
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          reopenAdminThread(selected.id)
                            .then(() => open(selected.id))
                            .then(() => reload())
                            .catch((err: unknown) =>
                              setError(err instanceof ApiError ? err.message : "Could not reopen it.")
                            )
                            .finally(() => setBusy(false));
                        }}
                        className="underline disabled:opacity-50"
                      >
                        Reopen
                      </button>
                    )}
                  </div>
                </div>

                {selected.placement && (
                  <p className="rounded border border-line bg-blush px-4 py-3 text-sm">
                    {selected.placement.listing.title} · {ADMIN_SLOT_LABEL[selected.placement.slot]}{" "}
                    · offered {money(selected.placement.offeredCents)}
                    {selected.placement.agreedCents !== null &&
                      ` · at ${money(selected.placement.agreedCents)}`}{" "}
                    ·{" "}
                    <a href="/admin/placements" className="underline">
                      decide it
                    </a>
                  </p>
                )}

                <ThreadView
                  messages={selected.messages}
                  side="ADMIN"
                  closed={selected.closedAt !== null}
                  sending={busy}
                  onSend={async (text) => {
                    setBusy(true);
                    try {
                      await replyAsAdmin(selected.id, text);
                      await open(selected.id);
                      reload();
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
              </div>
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
