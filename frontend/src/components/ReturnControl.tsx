"use client";

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { formatPrice } from "@/lib/catalog";
import {
  escalateReturn,
  startReturn,
  withdrawReturn,
  type MyReturn,
  type ReturnStatus,
} from "@/lib/ordersApi";

/**
 * Asking for money back, on one line of an order.
 *
 * Renders one of two things: the state of a request that exists, or the control
 * to open one. Both live here rather than in `OrderLines` so that file stays
 * about what was bought.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. Nothing about return labels or tracking a
 * parcel back — neither is built, and the help page was rewritten for the same
 * reason. The refund happens when the seller or a moderator approves, and this
 * says exactly that.
 */

const STATUS_COPY: Record<
  ReturnStatus,
  { label: string; tone: string; body: (r: MyReturn) => string }
> = {
  OPEN: {
    label: "Return requested",
    tone: "border-gold/40 bg-gold/10",
    body: () => "The seller has been asked and hasn't answered yet.",
  },
  APPROVED: {
    label: "Return approved",
    tone: "border-sage/50 bg-sage/20",
    body: () =>
      "You've been refunded the full price of this item. How long it takes to show on your statement is up to your bank.",
  },
  REFUSED: {
    label: "Return refused",
    tone: "border-clay/30 bg-clay/10",
    body: () => "The seller said no. If you disagree, you can ask us to look at it.",
  },
  ESCALATED: {
    label: "With us to decide",
    tone: "border-gold/40 bg-gold/10",
    body: () => "You've asked us to look at the seller's refusal. We'll decide and let you know.",
  },
  REJECTED: {
    label: "Return declined",
    tone: "border-clay/30 bg-clay/10",
    body: () => "We looked at this and agreed with the seller. That decision is final.",
  },
  WITHDRAWN: {
    label: "Return withdrawn",
    tone: "border-line bg-paper-card",
    body: () => "You withdrew this request.",
  },
};

export default function ReturnControl({
  orderItemId,
  amountCents,
  currency,
  existing,
  onChanged,
}: {
  orderItemId: string;
  /** The whole line, which is what a return refunds. */
  amountCents: number;
  currency: string;
  /** The request for this line, if one has been opened. */
  existing?: MyReturn;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [notAsDescribed, setNotAsDescribed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>, fallback: string) {
    setError(null);
    setBusy(true);
    try {
      await fn();
      setOpen(false);
      setReason("");
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  /* ---- a request already exists: show where it got to ---- */
  if (existing) {
    const copy = STATUS_COPY[existing.status];
    return (
      <div className={`mt-2 rounded-xl border px-3 py-2 ${copy.tone}`}>
        <p className="text-xs font-semibold text-ink">{copy.label}</p>
        <p className="mt-1 text-xs text-ink-dim">{copy.body(existing)}</p>

        {/* The buyer's own words, so they can see what the seller was told. */}
        <p className="mt-1.5 text-xs text-ink-dim">
          You said: <span className="text-ink">{existing.reason}</span>
        </p>

        {/*
          The answer, verbatim. A refusal with no reason would make escalating
          the only rational response, which is why the API requires one.
        */}
        {existing.decisionNote && (
          <p className="mt-1 text-xs text-ink-dim">
            Their answer: <span className="text-ink">{existing.decisionNote}</span>
          </p>
        )}

        {existing.status === "OPEN" && (
          <button
            type="button"
            onClick={() => void run(() => withdrawReturn(existing.id), "Couldn't withdraw that.")}
            disabled={busy}
            className="mt-2 rounded-full border border-line px-3 py-1 text-xs text-ink transition hover:border-gold/40 disabled:opacity-60"
          >
            {busy ? "Withdrawing…" : "Withdraw the request"}
          </button>
        )}

        {existing.status === "REFUSED" && (
          <button
            type="button"
            onClick={() => void run(() => escalateReturn(existing.id), "Couldn't escalate that.")}
            disabled={busy}
            className="mt-2 rounded-full bg-gold-dim px-3 py-1 text-xs font-semibold text-paper transition hover:brightness-90 disabled:opacity-60"
          >
            {busy ? "Sending…" : "Ask us to look at it"}
          </button>
        )}

        {error && <p className="mt-1 text-xs text-clay">{error}</p>}
      </div>
    );
  }

  /* ---- no request yet ---- */
  if (!open) {
    return (
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-full border border-line px-3 py-1 text-xs text-ink transition hover:border-gold/40"
        >
          Start a return
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-xl border border-line bg-paper-card p-3">
      <label className="block text-xs font-medium text-ink" htmlFor={`why-${orderItemId}`}>
        What&apos;s wrong with it?
      </label>
      <p className="mt-0.5 text-xs text-ink-dim">
        The seller reads this exactly as you write it.
      </p>
      <textarea
        id={`why-${orderItemId}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="The rim is chipped and it wasn't in the photos."
        className="mt-2 w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-dim/60 focus:border-gold/50"
      />

      <label className="mt-2 flex items-start gap-2 text-xs text-ink-dim">
        <input
          type="checkbox"
          checked={notAsDescribed}
          onChange={(e) => setNotAsDescribed(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          It doesn&apos;t match the listing — damaged, wrong item, or not the
          condition described.
        </span>
      </label>

      <p className="mt-2 text-xs text-ink-dim">
        If the seller agrees, you&apos;ll be refunded{" "}
        <span className="font-medium text-ink">
          {formatPrice(amountCents, currency)}
        </span>{" "}
        — the full price of this item. Send it back to the seller directly; we
        don&apos;t provide return labels.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || reason.trim().length < 10}
          onClick={() =>
            void run(
              () => startReturn(orderItemId, { reason, notAsDescribed }),
              "Couldn't open that return."
            )
          }
          className="rounded-full bg-gold-dim px-4 py-1.5 text-xs font-semibold text-paper transition hover:brightness-90 disabled:opacity-60"
        >
          {busy ? "Sending…" : "Request a return"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={busy}
          className="rounded-full border border-line px-4 py-1.5 text-xs text-ink transition hover:border-gold/40 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>

      {reason.trim().length > 0 && reason.trim().length < 10 && (
        <p className="mt-1.5 text-xs text-ink-dim">
          A little more detail — the seller has to be able to act on it.
        </p>
      )}
      {error && <p className="mt-1.5 text-xs text-clay">{error}</p>}
    </div>
  );
}
