"use client";

import { useEffect, useState } from "react";
import AdminGate from "@/components/admin/AdminGate";
import { Card, EmptyState, Pill, Tabs, fullDate, money } from "@/components/admin/ui";
import { ApiError } from "@/lib/api";
import {
  ADMIN_SLOT_LABEL,
  acceptPlacement,
  activatePlacement,
  counterPlacement,
  declinePlacement,
  endPlacement,
  getPlacementQueue,
  type AdminPlacement,
  type AdminPlacementStatus,
  type LiveSlot,
} from "@/lib/adminApi";

type Tab = "PENDING" | "ALL";

const TONE: Partial<Record<AdminPlacementStatus, "good" | "warn" | "bad" | "neutral">> = {
  REQUESTED: "warn",
  COUNTERED: "warn",
  AGREED: "neutral",
  LIVE: "good",
  ENDED: "neutral",
  DECLINED: "bad",
  WITHDRAWN: "neutral",
};

export default function AdminPlacementsPage() {
  return (
    <AdminGate title="Placements" subtitle="What sellers have asked to promote">
      {() => <Placements />}
    </AdminGate>
  );
}

function Placements() {
  const [tab, setTab] = useState<Tab>("PENDING");
  const [rows, setRows] = useState<AdminPlacement[] | null>(null);
  const [live, setLive] = useState<LiveSlot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [counter, setCounter] = useState("");
  const [note, setNote] = useState("");

  /**
   * The fetch lives in the effect rather than in a `useCallback` the effect
   * calls, and `reload` is a counter rather than a function that refetches.
   *
   * That is not a style preference: `react-hooks/set-state-in-effect` traces
   * through a callback that setStates when an effect depends on it, and the
   * repository's eslint config says in as many words that the answer to a
   * rising count is the refactor rather than another exception. This is that
   * refactor, for the pages this feature added. See eslint.config.mjs.
   */
  const [reloads, setReloads] = useState(0);
  const reload = () => setReloads((n) => n + 1);

  useEffect(() => {
    let alive = true;
    getPlacementQueue(tab === "PENDING")
      .then((data) => {
        if (!alive) return;
        setRows(data.placements);
        setLive(data.live);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof ApiError ? err.message : "Could not load the queue.");
        setRows([]);
      });
    return () => {
      alive = false;
    };
  }, [tab, reloads]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await fn();
      setOpen(null);
      setCounter("");
      setNote("");
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/*
        WHAT IS ON THE HOMEPAGE RIGHT NOW, before the queue.
        Choosing what to promote is the first PRODUCTIVE admin power in this
        application — every other one removes something — so the screen opens
        with the consequences of past decisions rather than the next decision.
      */}
      <Card title="Live on the homepage">
        {live.length === 0 ? (
          <EmptyState title="Nothing promoted" body="The homepage is showing its derived shelves only." />
        ) : (
          <ul className="flex flex-col gap-2">
            {live.map((l) => (
              <li key={l.id} className="flex items-center gap-3 text-sm">
                <Pill tone="good">{ADMIN_SLOT_LABEL[l.slot]}</Pill>
                <span className="text-ink-dim">position {l.position + 1}</span>
                <a href={`/listing/${l.slug}`} className="underline">
                  {l.slug}
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Tabs
        value={tab}
        onChange={(t) => setTab(t)}
        options={[
          { key: "PENDING", label: "Needs you" },
          { key: "ALL", label: "All" },
        ]}
      />

      {error && <p className="text-sm text-clay">{error}</p>}

      {rows === null && <p className="text-sm text-ink-dim">Loading…</p>}
      {rows?.length === 0 && (
        <EmptyState title="Nothing waiting" body="No seller is asking for a slot right now." />
      )}

      <div className="flex flex-col gap-3">
        {rows?.map((p) => (
          <Card key={p.id} title={p.listing.title}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="text-sm">
                <p className="text-ink-dim">
                  {p.seller.shopName ?? "A seller"} · {ADMIN_SLOT_LABEL[p.slot]} · position{" "}
                  {p.position + 1}
                </p>
                <p className="mt-1">
                  offered <strong>{money(p.offeredCents)}</strong>
                  {p.agreedCents !== null && (
                    <>
                      {" · "}
                      {p.status === "COUNTERED" ? "countered at " : "agreed at "}
                      <strong>{money(p.agreedCents)}</strong>
                    </>
                  )}
                </p>
                <p className="mt-1 text-ink-dim">
                  {p.startsAt ? fullDate(p.startsAt) : "no start date"} —{" "}
                  {p.endsAt ? fullDate(p.endsAt) : "no end date"}
                </p>
              </div>
              <Pill tone={TONE[p.status] ?? "neutral"}>{p.status}</Pill>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <a href={`/admin/messages?thread=${p.threadId}`} className="text-sm underline">
                Open the conversation
              </a>

              {(p.status === "REQUESTED" || p.status === "COUNTERED") && (
                <button
                  type="button"
                  onClick={() => setOpen(open === p.id ? null : p.id)}
                  className="rounded border border-line px-3 py-1.5 text-sm"
                >
                  {open === p.id ? "Cancel" : "Counter or decline"}
                </button>
              )}

              {p.status === "REQUESTED" && (
                <button
                  type="button"
                  disabled={busy === p.id}
                  onClick={() => void act(p.id, () => acceptPlacement(p.id))}
                  className="rounded bg-ink px-3 py-1.5 text-sm text-paper disabled:opacity-50"
                >
                  Accept as offered
                </button>
              )}

              {p.status === "AGREED" && (
                <button
                  type="button"
                  disabled={busy === p.id}
                  onClick={() => void act(p.id, () => activatePlacement(p.id))}
                  className="rounded bg-clay px-3 py-1.5 text-sm text-paper disabled:opacity-50"
                >
                  Make it live
                </button>
              )}

              {p.status === "LIVE" && (
                <button
                  type="button"
                  disabled={busy === p.id}
                  onClick={() => void act(p.id, () => endPlacement(p.id))}
                  className="rounded border border-line px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  End it
                </button>
              )}
            </div>

            {open === p.id && (
              <div className="mt-4 flex flex-col gap-3 rounded border border-line bg-blush p-4">
                <label className="flex flex-col gap-1 text-sm">
                  Counter at (USD)
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={counter}
                    onChange={(e) => setCounter(e.target.value)}
                    className="rounded border border-line bg-paper px-3 py-2"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  Message to the seller
                  <textarea
                    rows={3}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="They read this, so say what you are offering or why not."
                    className="rounded border border-line bg-paper px-3 py-2"
                  />
                </label>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    disabled={busy === p.id || counter === "" || note.trim().length === 0}
                    onClick={() =>
                      void act(p.id, () =>
                        counterPlacement(p.id, {
                          agreedCents: Math.round(Number(counter) * 100),
                          note,
                        })
                      )
                    }
                    className="rounded bg-ink px-3 py-1.5 text-sm text-paper disabled:opacity-50"
                  >
                    Send counter-offer
                  </button>
                  <button
                    type="button"
                    /* A reason is required to decline — the seller reads it. */
                    disabled={busy === p.id || note.trim().length === 0}
                    onClick={() => void act(p.id, () => declinePlacement(p.id, note))}
                    className="rounded border border-clay px-3 py-1.5 text-sm text-clay disabled:opacity-50"
                  >
                    Decline
                  </button>
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
