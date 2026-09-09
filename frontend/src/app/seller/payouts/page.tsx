"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import { formatPrice } from "@/lib/catalog";
import {
  completeStubOnboarding,
  getPayouts,
  refreshPayoutAccount,
  runPayout,
  startPayoutOnboarding,
  type PayableLine,
  type PayoutRow,
  type PayoutSummary,
} from "@/lib/sellerApi";

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Why a payout attempt did nothing, in the seller's terms.
 *
 * The API answers with a code per reason rather than one generic failure,
 * because each one is a different thing for the seller to do next. Repeating
 * that here keeps the mapping in one place instead of inline in the handler.
 */
const RUN_FAILURE: Record<string, string> = {
  NOTHING_PAYABLE: "Nothing is ready to pay out yet.",
  NO_ACCOUNT: "Connect a payout account first.",
  NOT_VERIFIED: "Your identity check hasn't been approved yet.",
  NOT_READY: "Your payout account isn't finished — check what's outstanding below.",
  ALREADY_RUNNING: "A payout is already being processed. Reload in a moment.",
  PROVIDER_REFUSED: "The transfer was refused. Check your payout account details.",
  RETRY_LATER: "Couldn't reach the payment provider. The payout is queued and will be retried.",
  ALREADY_SETTLED: "That payout has already been settled.",
};

const STATUS_TONE: Record<PayoutRow["status"], string> = {
  PAID: "border-sage/50 bg-sage/20 text-ink",
  PENDING: "border-gold/30 bg-gold/10 text-gold-dim",
  FAILED: "border-clay/30 bg-clay/10 text-clay",
};

/** One of the headline numbers. `hint` says what the figure actually means. */
function Figure({
  label,
  cents,
  currency,
  hint,
}: {
  label: string;
  cents: number;
  currency: string;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-line bg-paper-card p-5">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-dim">{label}</dt>
      <dd className="mt-1.5 font-serif text-2xl font-medium text-ink">
        {formatPrice(cents, currency)}
      </dd>
      <p className="mt-2 text-xs leading-relaxed text-ink-dim">{hint}</p>
    </div>
  );
}

export default function PayoutsPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [summary, setSummary] = useState<PayoutSummary | null>(null);
  const [payable, setPayable] = useState<PayableLine[]>([]);
  const [history, setHistory] = useState<PayoutRow[]>([]);
  const [holdDays, setHoldDays] = useState<number | null>(null);
  const [isStub, setIsStub] = useState(false);

  /** Set when the whole section is refused for want of a verified identity. */
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "connect" | "refresh" | "run">(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const data = await getPayouts();
      setLocked(false);
      setSummary(data.summary);
      setPayable(data.payable);
      setHistory(data.history);
      setHoldDays(data.holdDays);
      setIsStub(data.isStub);
    } catch (err) {
      if (err instanceof ApiError && err.code === "PAYOUTS_LOCKED") {
        setLocked(true);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Couldn't load your payouts.");
    }
  }, []);

  useEffect(() => {
    if (user?.isSeller) load();
  }, [user?.isSeller, load]);

  async function handleConnect() {
    setError(null);
    setNotice(null);
    setBusy("connect");
    try {
      const link = await startPayoutOnboarding();
      if (link.external) {
        // Stripe hosts onboarding. Bank details and tax identifiers are given
        // to them and never pass through this application.
        window.location.href = link.url;
        return;
      }
      // The stub has no hosted page to send anyone to.
      await completeStubOnboarding();
      setNotice("Stub payout account connected. No real account exists.");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start payout onboarding.");
    } finally {
      setBusy(null);
    }
  }

  async function handleRefresh() {
    setError(null);
    setNotice(null);
    setBusy("refresh");
    try {
      const status = await refreshPayoutAccount();
      setNotice(
        status.payoutsReady
          ? "Your payout account is ready."
          : status.pending.length > 0
            ? `Still outstanding: ${status.pending.join(", ")}`
            : "Your account isn't ready to receive payouts yet."
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't check your payout account.");
    } finally {
      setBusy(null);
    }
  }

  async function handleRun() {
    setError(null);
    setNotice(null);
    setBusy("run");
    try {
      const outcome = await runPayout();
      if (outcome.paid) {
        setNotice(
          `Paid ${formatPrice(outcome.amountCents ?? 0, summary?.currency ?? "USD")}.`
        );
      } else {
        // A 200 with paid:false is the ordinary "nothing to send" answer.
        setNotice(RUN_FAILURE.NOTHING_PAYABLE);
      }
      await load();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      setError(
        (code && RUN_FAILURE[code]) ??
          (err instanceof ApiError ? err.message : "Couldn't run the payout.")
      );
      // A refused or queued payout still wrote a row worth showing.
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (loading || !user) {
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-16">
          <div className="mx-auto max-w-4xl text-sm text-ink-dim">Loading…</div>
        </main>
        <Footer />
      </>
    );
  }

  if (!user.isSeller) {
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-16">
          <div className="mx-auto max-w-4xl">
            <h1 className="font-serif text-3xl font-medium text-ink">Seller accounts only</h1>
            <p className="mt-3 text-sm text-ink-dim">
              Payouts apply to sellers receiving money for items they&apos;ve sold.
            </p>
            <Link
              href="/account"
              className="mt-6 inline-block rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90"
            >
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
        <div className="mx-auto max-w-4xl">
          <Link href="/seller" className="text-sm text-ink-dim transition hover:text-gold-dim">
            ← Your listings
          </Link>

          <h1 className="mt-4 font-serif text-3xl font-medium tracking-tight text-ink sm:text-4xl">
            Payouts
          </h1>
          <p className="mt-3 text-sm text-ink-dim">
            Buyers pay RetailStore_2n, and RetailStore_2n pays you afterwards. Nothing is sent
            automatically — you ask for a payout and every line it covers is listed here.
          </p>

          {locked ? (
            <div className="mt-8 rounded-2xl border border-gold/40 bg-gold/10 p-6">
              <h2 className="text-base font-semibold text-ink">Verify your identity first</h2>
              <p className="mt-2 text-sm text-ink-dim">
                Money can only be sent to someone we&apos;ve checked. You can keep
                listing and selling in the meantime — earnings accrue and stay
                yours; they just can&apos;t be sent yet.
              </p>
              <Link
                href="/seller/verify"
                className="mt-5 inline-block rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90"
              >
                Start verification
              </Link>
            </div>
          ) : (
            <>
              {isStub && (
                <div className="mt-6 rounded-2xl border border-gold/40 bg-gold/10 p-5">
                  <p className="text-sm font-semibold text-ink">
                    Development stub — no money moves
                  </p>
                  <p className="mt-2 text-sm text-ink-dim">
                    No payout provider is connected, so every transfer below is
                    recorded but never sent. Swapping in Stripe Connect means
                    implementing one module; the ledger, the hold and the reversal
                    handling stay exactly as they are.
                  </p>
                </div>
              )}

              {error && (
                <p className="mt-6 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
                  {error}
                </p>
              )}
              {notice && (
                <p className="mt-6 rounded-xl border border-sage/50 bg-sage/20 px-4 py-3 text-sm text-ink">
                  {notice}
                </p>
              )}

              {summary === null ? (
                <p className="mt-8 text-sm text-ink-dim">Loading…</p>
              ) : (
                <>
                  <dl className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <Figure
                      label="Ready now"
                      cents={summary.payableCents}
                      currency={summary.currency}
                      hint="Delivered, past the hold, and clear to send."
                    />
                    <Figure
                      label="On hold"
                      cents={summary.heldCents}
                      currency={summary.currency}
                      hint={
                        holdDays === null
                          ? "Delivered, waiting out the return window."
                          : `Delivered, waiting out the ${holdDays}-day return window.`
                      }
                    />
                    <Figure
                      label="Not delivered yet"
                      cents={summary.inFlightCents}
                      currency={summary.currency}
                      hint="Sold and paid for, but not yet delivered to the buyer."
                    />
                    <Figure
                      label="Paid out"
                      cents={summary.paidCents}
                      currency={summary.currency}
                      hint="Everything sent to you so far, less reversals."
                    />
                  </dl>

                  {summary.heldUntil && (
                    <p className="mt-4 text-sm text-ink-dim">
                      The next money comes off hold on{" "}
                      <span className="font-medium text-ink">
                        {formatDay(summary.heldUntil)}
                      </span>
                      . There&apos;s no payout schedule — request one whenever you
                      like, as often as you like.
                    </p>
                  )}

                  {/*
                    Money inside an unsettled payout is in none of the figures
                    above: it has left "ready" and has not become "paid out".
                    It is listed under Past payouts as In flight, and saying so
                    is cheaper than a fifth figure that is almost always zero.
                  */}
                  {history.some((p) => p.status === "PENDING") && (
                    <p className="mt-3 text-sm text-ink-dim">
                      A payout is being processed. Until it settles its amount
                      isn&apos;t counted above — you&apos;ll find it under Past
                      payouts, marked <span className="font-medium text-ink">In flight</span>.
                    </p>
                  )}

                  {/* Two figures that only matter when they aren't zero. */}
                  {(summary.withheldCents > 0 ||
                    summary.debtCents > 0 ||
                    summary.notEarnedCents > 0) && (
                    <dl className="mt-5 grid gap-x-8 gap-y-3 rounded-2xl border border-line bg-paper-card p-5 text-sm sm:grid-cols-3">
                      {summary.withheldCents > 0 && (
                        <div>
                          <dt className="text-ink-dim">Withheld</dt>
                          <dd className="mt-0.5 font-medium text-ink">
                            {formatPrice(summary.withheldCents, summary.currency)}
                          </dd>
                          <p className="mt-1 text-xs text-ink-dim">
                            Yours, but your payout account can&apos;t receive it yet.
                          </p>
                        </div>
                      )}
                      {summary.debtCents > 0 && (
                        <div>
                          <dt className="text-ink-dim">Owed back</dt>
                          <dd className="mt-0.5 font-medium text-clay">
                            {formatPrice(summary.debtCents, summary.currency)}
                          </dd>
                          <p className="mt-1 text-xs text-ink-dim">
                            A refund landed after you were paid. It comes off your
                            next payout rather than being charged to you.
                          </p>
                        </div>
                      )}
                      {summary.notEarnedCents > 0 && (
                        <div>
                          <dt className="text-ink-dim">Never earned</dt>
                          <dd className="mt-0.5 font-medium text-ink">
                            {formatPrice(summary.notEarnedCents, summary.currency)}
                          </dd>
                          <p className="mt-1 text-xs text-ink-dim">
                            Refunded to the buyer, or a line you couldn&apos;t send.
                            Shown so the figures add up rather than quietly vanish.
                          </p>
                        </div>
                      )}
                    </dl>
                  )}

                  {/* ---- account + the button that moves money ---- */}
                  <section className="mt-10 rounded-2xl border border-line bg-paper-card p-6">
                    <h2 className="text-base font-semibold text-ink">Your payout account</h2>

                    <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3 text-sm">
                      <div>
                        <dt className="text-ink-dim">Identity</dt>
                        <dd className="mt-0.5 font-medium text-ink">
                          {summary.gates.payoutsEnabled ? "Verified" : "Not verified"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-ink-dim">Account</dt>
                        <dd className="mt-0.5 font-medium text-ink">
                          {summary.gates.payoutsReady
                            ? "Ready"
                            : summary.gates.onboarded
                              ? "Submitted, not yet ready"
                              : "Not connected"}
                        </dd>
                      </div>
                    </dl>

                    <p className="mt-4 text-sm text-ink-dim">
                      Both have to pass before anything is sent: we check who you
                      are, and the payment provider checks it can pay you.
                    </p>

                    <div className="mt-6 flex flex-wrap gap-3">
                      {!summary.gates.payoutsReady && (
                        <button
                          type="button"
                          onClick={handleConnect}
                          disabled={busy !== null}
                          className="rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90 disabled:opacity-60"
                        >
                          {busy === "connect"
                            ? "Opening…"
                            : summary.gates.onboarded
                              ? "Finish setting up"
                              : "Connect a payout account"}
                        </button>
                      )}

                      {summary.gates.onboarded && (
                        <button
                          type="button"
                          onClick={handleRefresh}
                          disabled={busy !== null}
                          className="rounded-full border border-line px-5 py-2.5 text-sm font-semibold text-ink transition hover:border-gold/40 disabled:opacity-60"
                        >
                          {busy === "refresh" ? "Checking…" : "Re-check account"}
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={handleRun}
                        disabled={busy !== null || summary.payableCents <= 0}
                        className="rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90 disabled:opacity-60"
                      >
                        {busy === "run"
                          ? "Sending…"
                          : summary.payableCents > 0
                            ? `Pay out ${formatPrice(summary.payableCents, summary.currency)}`
                            : "Nothing to pay out"}
                      </button>
                    </div>
                  </section>

                  {/* ---- the lines behind "ready now" ---- */}
                  <section className="mt-10">
                    <h2 className="font-serif text-xl font-medium text-ink">Ready to pay out</h2>
                    <p className="mt-1 text-sm text-ink-dim">
                      Every line the next payout would cover, so the total is never
                      a number you have to take on trust.
                    </p>

                    {payable.length === 0 ? (
                      <p className="mt-5 rounded-2xl border border-line bg-paper-card p-5 text-sm text-ink-dim">
                        Nothing is ready yet. Items appear here once they&apos;ve been
                        delivered and the return window has passed.
                      </p>
                    ) : (
                      <ul className="mt-5 grid gap-3">
                        {payable.map((line) => (
                          <li
                            key={line.orderItemId}
                            className="flex flex-wrap items-baseline justify-between gap-2 rounded-2xl border border-line bg-paper-card p-4 text-sm"
                          >
                            <div>
                              <p className="font-medium text-ink">{line.title}</p>
                              <p className="mt-0.5 text-xs text-ink-dim">
                                Delivered {formatDate(line.deliveredAt)} · order{" "}
                                {line.orderId.slice(0, 8)}
                              </p>
                            </div>
                            <span className="font-medium text-ink">
                              {formatPrice(line.amountCents, summary.currency)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  {/* ---- past payouts ---- */}
                  <section className="mt-10">
                    <h2 className="font-serif text-xl font-medium text-ink">Past payouts</h2>
                    <p className="mt-1 text-sm text-ink-dim">
                      Every payout is recorded with the exact items it covered. Money
                      that moved has to stay explainable after the fact.
                    </p>

                    {history.length === 0 ? (
                      <p className="mt-5 rounded-2xl border border-line bg-paper-card p-5 text-sm text-ink-dim">
                        No payouts yet.
                      </p>
                    ) : (
                      <ul className="mt-5 grid gap-3">
                        {history.map((payout) => (
                          <li
                            key={payout.id}
                            className="rounded-2xl border border-line bg-paper-card p-5 text-sm"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-serif text-lg font-medium text-ink">
                                {formatPrice(payout.amountCents, payout.currency)}
                              </span>
                              <span
                                className={`rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_TONE[payout.status]}`}
                              >
                                {payout.status === "PAID"
                                  ? "Paid"
                                  : payout.status === "PENDING"
                                    ? "In flight"
                                    : "Failed"}
                              </span>
                            </div>

                            <p className="mt-1 text-xs text-ink-dim">
                              Requested {formatDate(payout.createdAt)}
                              {payout.completedAt
                                ? ` · settled ${formatDate(payout.completedAt)}`
                                : ""}
                            </p>

                            {payout.nettedCents > 0 && (
                              <p className="mt-2 text-xs text-ink-dim">
                                {formatPrice(payout.nettedCents, payout.currency)} was
                                held back to cover a refund from an earlier payout.
                              </p>
                            )}

                            {payout.failureReason && (
                              <p className="mt-2 text-xs text-clay">{payout.failureReason}</p>
                            )}

                            <ul className="mt-3 grid gap-1.5 border-t border-line pt-3 text-xs">
                              {payout.items.map((item) => (
                                <li
                                  key={item.orderItemId}
                                  className="flex items-baseline justify-between gap-2"
                                >
                                  <span className="text-ink-dim">
                                    Item {item.orderItemId.slice(0, 8)}
                                    {item.reversedAt
                                      ? ` · refunded ${formatDay(item.reversedAt)}`
                                      : ""}
                                  </span>
                                  <span
                                    className={
                                      item.reversedAt
                                        ? "text-ink-dim line-through"
                                        : "font-medium text-ink"
                                    }
                                  >
                                    {formatPrice(item.amountCents, payout.currency)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </>
              )}
            </>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
