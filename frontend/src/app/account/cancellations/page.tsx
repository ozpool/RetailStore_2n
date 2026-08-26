"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import { getMyRefunds, type MyRefund } from "@/lib/ordersApi";

/**
 * Refunds, from the buyer's side.
 *
 * This was a placeholder for exactly as long as refunds did not exist. The
 * honest version of the old copy was "refunds aren't built"; the honest version
 * now is a list of them.
 *
 * WHY IT IS ONE FLAT LIST
 * Not grouped by order. A buyer coming here has one question — "where is my
 * money?" — and the answer is a row with an amount, a state, and a reason. The
 * order reference is on each row for anyone who needs to quote it.
 */
export default function MyCancellationsPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [refunds, setRefunds] = useState<MyRefund[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const { refunds } = await getMyRefunds();
      setRefunds(refunds);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your refunds.");
      setRefunds([]);
    }
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  if (loading || !user) {
    return (
      <Shell>
        <p className="text-sm text-ink-dim">Loading…</p>
      </Shell>
    );
  }

  const list = refunds ?? [];
  const settled = list.filter((r) => r.status === "SUCCEEDED");
  const total = settled.reduce((sum, r) => sum + r.amountCents, 0);
  const currency = settled[0]?.currency ?? "USD";

  return (
    <Shell>
      <Link href="/account" className="text-sm text-ink-dim transition hover:text-gold-dim">
        ← Your account
      </Link>

      <h1 className="mt-4 font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        Refunds
      </h1>
      <p className="mt-3 max-w-2xl text-sm text-ink-dim">
        Money sent back to you, and why. If a seller can&apos;t send something
        you&apos;ve paid for, the refund is issued automatically — you don&apos;t
        need to ask.
      </p>

      {error && (
        <p className="mt-6 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      )}

      {refunds === null ? (
        <p className="mt-10 text-sm text-ink-dim">Loading…</p>
      ) : list.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-line bg-blush p-10 text-center">
          <p className="text-ink">Nothing refunded</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-dim">
            Cancelled and failed orders appear under{" "}
            <Link href="/account/orders" className="text-gold-dim hover:underline">
              My orders
            </Link>{" "}
            with their status. Nothing has been refunded to you.
          </p>
        </div>
      ) : (
        <>
          {settled.length > 0 && (
            <p className="mt-8 rounded-2xl border border-sage-dim/30 bg-sage-dim/5 px-5 py-4 text-sm text-ink">
              <strong className="font-semibold">{money(total, currency)}</strong>{" "}
              refunded across {settled.length} refund{settled.length === 1 ? "" : "s"}.
              {/* Said once, here, rather than on every row. Banks are slow and
                  people check the same day. */}
              <span className="text-ink-dim">
                {" "}
                Refunds can take a few days to appear on your statement.
              </span>
            </p>
          )}

          <ul className="mt-6 grid gap-3">
            {list.map((r) => (
              <li
                key={r.id}
                className="rounded-2xl border border-line bg-paper-card p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-56 flex-1">
                    <p className="text-sm font-medium text-ink">
                      {r.itemTitle ?? "Whole order"}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-dim">
                      <Link
                        href={`/orders/${r.orderId}`}
                        className="hover:text-gold-dim hover:underline"
                      >
                        {r.orderReference}
                      </Link>{" "}
                      · {new Date(r.createdAt).toLocaleDateString("en-US", {
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </p>
                  </div>

                  <div className="text-right">
                    <p className="font-serif text-lg font-semibold tabular-nums text-ink">
                      {money(r.amountCents, r.currency)}
                    </p>
                    <StatusPill status={r.status} />
                  </div>
                </div>

                <p className="mt-3 rounded-xl bg-blush px-3 py-2 text-sm text-ink-dim">
                  {r.reason}
                </p>

                {/* Only shown when it means something. "Refunded by a moderator"
                    is worth knowing; "refunded because the seller couldn't send
                    it" is already obvious from the reason above. */}
                {r.trigger === "ADMIN" && (
                  <p className="mt-2 text-xs text-ink-dim">
                    Issued by RetailStore_2n after reviewing the order.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Shell>
  );
}

function StatusPill({ status }: { status: MyRefund["status"] }) {
  const map = {
    SUCCEEDED: { label: "Sent back", tone: "border-sage-dim/30 bg-sage-dim/10 text-sage-dim" },
    // "On its way" rather than "pending": the buyer cares whether their money
    // is coming, not which state machine it is in.
    PENDING: { label: "On its way", tone: "border-star/40 bg-star/10 text-[#8a5a00]" },
    FAILED: { label: "Didn't go through", tone: "border-clay/30 bg-clay/10 text-clay" },
  } as const;
  const { label, tone } = map[status];
  return (
    <span
      className={`mt-1 inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${tone}`}
    >
      {label}
    </span>
  );
}

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-3xl">{children}</div>
      </main>
      <Footer />
    </>
  );
}
