"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";

/**
 * Reporting a listing or a review.
 *
 * Deliberately understated — a small text link, not a button competing with
 * "Add to cart". Reporting should be findable when needed and invisible the
 * rest of the time; a prominent one invites use as a disagreement button.
 *
 * Requires signing in. Anonymous reports cannot be followed up, cannot be
 * weighed against a reporter's history, and are trivially abusable.
 */

const REASONS = [
  { value: "PROHIBITED_ITEM", label: "Shouldn't be sold here" },
  { value: "COUNTERFEIT", label: "Counterfeit or fake" },
  { value: "MISLEADING_DESCRIPTION", label: "Description is misleading" },
  { value: "SPAM", label: "Spam" },
  { value: "HARASSMENT", label: "Abusive or harassing" },
  { value: "OTHER", label: "Something else" },
] as const;

export default function ReportButton({
  targetType,
  targetId,
  label = "Report this listing",
}: {
  targetType: "LISTING" | "REVIEW" | "USER";
  targetId: string;
  label?: string;
}) {
  const router = useRouter();
  const { user } = useAuth();

  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(REASONS[0].value);
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType,
          targetId,
          reason,
          detail: detail.trim() || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(body.error ?? "Couldn't send that.", body.code);

      setSent(true);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send that report.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <p className="text-xs text-ink-dim">
        Reported. Someone will look at it.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => (user ? setOpen(true) : router.push("/login"))}
        className="text-xs text-ink-dim underline transition hover:text-clay"
      >
        {label}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-2 rounded-2xl border border-line bg-paper-card p-4">
      <p className="text-sm font-medium text-ink">What&apos;s wrong with it?</p>

      {error && <p className="mt-2 text-sm text-clay">{error}</p>}

      <label htmlFor={`reason-${targetId}`} className="mt-3 block text-xs text-ink-dim">
        Reason
      </label>
      <select
        id={`reason-${targetId}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={busy}
        className="mt-1 w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-gold/50 disabled:opacity-60"
      >
        {REASONS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>

      <label htmlFor={`detail-${targetId}`} className="mt-3 block text-xs text-ink-dim">
        Anything else? <span className="font-normal">Optional</span>
      </label>
      <textarea
        id={`detail-${targetId}`}
        value={detail}
        onChange={(e) => setDetail(e.target.value.slice(0, 1000))}
        rows={3}
        disabled={busy}
        placeholder="The more specific you are, the faster this gets sorted."
        className="mt-1 w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-dim/60 focus:border-gold/50 disabled:opacity-60"
      />

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded border border-clay/40 px-4 py-2 text-sm font-medium text-clay transition hover:bg-clay/10 disabled:opacity-60"
        >
          {busy ? "Sending…" : "Send report"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="rounded border border-line px-4 py-2 text-sm text-ink transition hover:border-gold/40 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
