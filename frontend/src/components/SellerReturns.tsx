"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { formatPrice } from "@/lib/catalog";
import {
  getSellerReturns,
  respondToReturn,
  type SellerReturn,
} from "@/lib/salesApi";

/**
 * The returns a seller has been asked to answer.
 *
 * Lives above the sales list because an unanswered return is the most urgent
 * thing on the page: somebody is waiting on a decision about their money, and a
 * seller who never answers leaves the buyer to escalate.
 *
 * Renders nothing at all when there are none — a permanent empty section would
 * be noise for the sellers who have never had one, which is most of them.
 */
export default function SellerReturns() {
  const [returns, setReturns] = useState<SellerReturn[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReturns((await getSellerReturns()).returns);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your returns.");
      setReturns([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (returns === null || returns.length === 0) return null;

  const waiting = returns.filter((r) => r.status === "OPEN");
  const settled = returns.filter((r) => r.status !== "OPEN");

  return (
    <section className="mt-8">
      <h2 className="font-serif text-xl font-medium text-ink">
        Returns
        {waiting.length > 0 && (
          <span className="ml-2 rounded-full bg-gold-dim px-2 py-0.5 align-middle text-xs font-semibold text-paper">
            {waiting.length} to answer
          </span>
        )}
      </h2>
      <p className="mt-1 text-sm text-ink-dim">
        A buyer has asked for their money back. Approving refunds them the full
        price of the item; refusing needs a reason, which they see. If you
        refuse, they can ask us to decide.
      </p>

      {error && (
        <p className="mt-4 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      )}

      <ul className="mt-5 grid gap-3">
        {[...waiting, ...settled].map((r) => (
          <ReturnCard key={r.id} request={r} onChanged={load} />
        ))}
      </ul>
    </section>
  );
}

const STATUS_LABEL: Record<SellerReturn["status"], { text: string; tone: string }> = {
  OPEN: { text: "Waiting on you", tone: "border-gold/40 bg-gold/10 text-gold-dim" },
  APPROVED: { text: "Approved — refunded", tone: "border-sage/50 bg-sage/20 text-ink" },
  REFUSED: { text: "You refused", tone: "border-line bg-blush text-ink-dim" },
  ESCALATED: { text: "With us to decide", tone: "border-gold/40 bg-gold/10 text-gold-dim" },
  REJECTED: { text: "We agreed with you", tone: "border-sage/50 bg-sage/20 text-ink" },
  WITHDRAWN: { text: "Buyer withdrew it", tone: "border-line bg-blush text-ink-dim" },
};

function ReturnCard({
  request,
  onChanged,
}: {
  request: SellerReturn;
  onChanged: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "approve" | "refuse">(null);
  const [error, setError] = useState<string | null>(null);

  const label = STATUS_LABEL[request.status];

  async function respond(approve: boolean) {
    setError(null);
    setBusy(approve ? "approve" : "refuse");
    try {
      await respondToReturn(request.id, { approve, note: note.trim() || undefined });
      setNote("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send that answer.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="rounded-2xl border border-line bg-paper-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-ink">{request.title}</p>
          <p className="mt-0.5 text-xs text-ink-dim">
            {formatPrice(request.amountCents)}
            {request.orderReference ? ` · order ${request.orderReference}` : ""}
            {request.deliveredAt
              ? ` · delivered ${new Date(request.deliveredAt).toLocaleDateString()}`
              : ""}
          </p>
        </div>
        <span
          className={`rounded-full border px-2.5 py-1 text-xs font-medium ${label.tone}`}
        >
          {label.text}
        </span>
      </div>

      {/* Verbatim. They wrote it for the seller to read. */}
      <p className="mt-3 rounded-xl border border-line bg-paper px-3 py-2 text-sm text-ink">
        {request.reason}
      </p>
      {request.notAsDescribed && (
        <p className="mt-1.5 text-xs text-ink-dim">
          They&apos;ve marked this as not matching the listing.
        </p>
      )}

      {request.decisionNote && (
        <p className="mt-2 text-xs text-ink-dim">
          Your answer: <span className="text-ink">{request.decisionNote}</span>
        </p>
      )}

      {request.status === "OPEN" && (
        <div className="mt-4 border-t border-line pt-4">
          <label
            className="block text-xs font-medium text-ink"
            htmlFor={`note-${request.id}`}
          >
            Your reply
          </label>
          <p className="mt-0.5 text-xs text-ink-dim">
            Required if you&apos;re refusing. The buyer sees it word for word.
          </p>
          <textarea
            id={`note-${request.id}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="The chip is visible in the third photo."
            className="mt-2 w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-dim/60 focus:border-gold/50"
          />

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void respond(true)}
              disabled={busy !== null}
              className="rounded-full bg-gold-dim px-4 py-1.5 text-xs font-semibold text-paper transition hover:brightness-90 disabled:opacity-60"
            >
              {busy === "approve"
                ? "Refunding…"
                : `Approve and refund ${formatPrice(request.amountCents)}`}
            </button>
            <button
              type="button"
              onClick={() => void respond(false)}
              disabled={busy !== null || note.trim().length < 3}
              className="rounded-full border border-line px-4 py-1.5 text-xs text-ink transition hover:border-clay/40 disabled:opacity-60"
            >
              {busy === "refuse" ? "Sending…" : "Refuse"}
            </button>
          </div>

          <p className="mt-2 text-xs text-ink-dim">
            Arrange getting the item back with the buyer directly — we
            don&apos;t generate return labels or track the parcel.
          </p>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-clay">{error}</p>}
    </li>
  );
}
