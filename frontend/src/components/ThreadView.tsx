"use client";

import { useState } from "react";

export type ViewMessage = {
  id: string;
  author: "SELLER" | "ADMIN";
  body: string;
  createdAt: string;
};

function when(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * One conversation, from either side.
 *
 * `side` is who is looking, not who wrote what — it decides which messages sit
 * on the right. The same component serves the seller and the moderator, because
 * a thread that reads differently to each of them is a thread where somebody is
 * going to misremember what was agreed.
 */
export default function ThreadView({
  messages,
  side,
  closed,
  onSend,
  sending,
}: {
  messages: ViewMessage[];
  side: "SELLER" | "ADMIN";
  closed: boolean;
  onSend: (body: string) => Promise<void>;
  sending?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setError(null);
    try {
      await onSend(body);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send that.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-3">
        {messages.map((m) => {
          const mine = m.author === side;
          return (
            <li key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-lg px-4 py-3 text-sm whitespace-pre-wrap ${
                  mine ? "bg-ink text-paper" : "bg-blush text-ink"
                }`}
              >
                <p className="mb-1 text-xs opacity-70">
                  {m.author === "SELLER" ? "Seller" : "RetailStore_2n"} · {when(m.createdAt)}
                </p>
                {m.body}
              </div>
            </li>
          );
        })}
      </ol>

      {closed ? (
        <p className="rounded border border-line bg-blush px-4 py-3 text-sm text-ink-dim">
          This conversation is closed.
          {side === "SELLER" ? " Start a new one if you need to." : " Reopen it to reply."}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <label htmlFor="reply" className="text-xs tracking-wide text-ink-dim uppercase">
            Reply
          </label>
          <textarea
            id="reply"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full rounded border border-line bg-paper px-3 py-2 text-sm"
            placeholder="Write a message…"
          />
          {error && <p className="text-sm text-clay">{error}</p>}
          <div>
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || draft.trim().length === 0}
              className="rounded bg-clay px-4 py-2 text-sm font-medium text-paper disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
