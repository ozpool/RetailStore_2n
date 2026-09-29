"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import ThreadView from "@/components/ThreadView";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import {
  STATUS_LABEL,
  getThread,
  getThreads,
  openThread,
  replyToThread,
  type ThreadDetail,
  type ThreadSummary,
} from "@/lib/messagingApi";

function when(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The seller's conversations with the platform.
 *
 * List on the left, the selected thread on the right. One page rather than a
 * route per thread because the list is short and the reply box is the point —
 * a navigation between reading and answering is a navigation a seller has to
 * come back from.
 */
export default function SellerMessagesPage() {
  const { user, loading: authLoading } = useAuth();
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [selected, setSelected] = useState<ThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [composing, setComposing] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");


  const open = useCallback(async (id: string) => {
    try {
      const { thread } = await getThread(id);
      setSelected(thread);
      // Opening it cleared the badge server-side; reflect that without a refetch.
      setThreads((rows) => rows?.map((r) => (r.id === id ? { ...r, unread: 0 } : r)) ?? rows);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open that conversation.");
    }
  }, []);

  /** See the note in admin/placements: the fetch lives in the effect so no
   *  effect depends on a callback that setStates. */
  const [reloads, setReloads] = useState(0);
  const reload = () => setReloads((n) => n + 1);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    getThreads()
      .then(({ threads: rows }) => {
        if (alive) setThreads(rows);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof ApiError ? err.message : "Could not load your messages.");
        setThreads([]);
      });
    return () => {
      alive = false;
    };
  }, [user, reloads]);

  if (authLoading) return null;

  if (!user?.isSeller) {
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h1 className="font-serif text-3xl font-semibold">Seller messages</h1>
            <p className="mt-4 text-ink-dim">
              Start selling to talk to us about listings and homepage placement.
            </p>
            <Link href="/account" className="mt-6 inline-block text-clay underline">
              Go to your account
            </Link>
          </div>
        </main>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs tracking-widest text-ink-dim uppercase">Seller</p>
              <h1 className="mt-2 font-serif text-3xl font-semibold">Messages</h1>
              <p className="mt-1 text-sm text-ink-dim">
                Conversations with RetailStore_2n about your shop.
              </p>
            </div>
            <div className="flex gap-3">
              <Link href="/seller/placements" className="text-sm text-clay underline">
                Homepage placement
              </Link>
              <button
                type="button"
                onClick={() => setComposing((c) => !c)}
                className="rounded bg-ink px-4 py-2 text-sm font-medium text-paper"
              >
                {composing ? "Cancel" : "New conversation"}
              </button>
            </div>
          </div>

          {error && <p className="mt-6 text-sm text-clay">{error}</p>}

          {composing && (
            <div className="mt-6 rounded border border-line bg-blush p-5">
              <div className="flex flex-col gap-3">
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Subject"
                  className="rounded border border-line bg-paper px-3 py-2 text-sm"
                />
                <textarea
                  rows={4}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="What would you like to ask?"
                  className="rounded border border-line bg-paper px-3 py-2 text-sm"
                />
                <div>
                  <button
                    type="button"
                    disabled={sending || subject.trim().length < 3 || body.trim().length === 0}
                    onClick={() => {
                      setSending(true);
                      setError(null);
                      openThread({ subject, body })
                        .then(async ({ threadId }) => {
                          setComposing(false);
                          setSubject("");
                          setBody("");
                          reload();
                          await open(threadId);
                        })
                        .catch((err: unknown) =>
                          setError(err instanceof ApiError ? err.message : "Could not send that.")
                        )
                        .finally(() => setSending(false));
                    }}
                    className="rounded bg-clay px-4 py-2 text-sm font-medium text-paper disabled:opacity-50"
                  >
                    {sending ? "Sending…" : "Send"}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="mt-8 grid gap-8 lg:grid-cols-[22rem_1fr]">
            <aside className="flex flex-col gap-2">
              {threads === null && <p className="text-sm text-ink-dim">Loading…</p>}
              {threads?.length === 0 && (
                <p className="rounded border border-line bg-blush px-4 py-6 text-sm text-ink-dim">
                  No conversations yet.
                </p>
              )}
              {threads?.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => void open(t.id)}
                  className={`rounded border px-4 py-3 text-left transition ${
                    selected?.id === t.id
                      ? "border-ink bg-blush"
                      : "border-line hover:border-ink"
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
                    {when(t.lastMessageAt)}
                    {t.placement && ` · ${STATUS_LABEL[t.placement.status]}`}
                    {t.closedAt && " · closed"}
                  </p>
                </button>
              ))}
            </aside>

            <section>
              {selected === null ? (
                <p className="rounded border border-line bg-blush px-4 py-10 text-center text-sm text-ink-dim">
                  Pick a conversation to read it.
                </p>
              ) : (
                <div className="flex flex-col gap-5">
                  <div>
                    <h2 className="font-serif text-2xl font-semibold">{selected.subject}</h2>
                    {selected.placement && (
                      <p className="mt-1 text-sm text-ink-dim">
                        {selected.placement.listing.title} ·{" "}
                        {STATUS_LABEL[selected.placement.status]}
                      </p>
                    )}
                  </div>
                  <ThreadView
                    messages={selected.messages}
                    side="SELLER"
                    closed={selected.closedAt !== null}
                    sending={sending}
                    onSend={async (text) => {
                      setSending(true);
                      try {
                        await replyToThread(selected.id, text);
                        await open(selected.id);
                        reload();
                      } finally {
                        setSending(false);
                      }
                    }}
                  />
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
