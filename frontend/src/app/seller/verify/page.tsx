"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import {
  DOCUMENT_TYPE_OPTIONS,
  getVerification,
  startVerification,
  type KycAttempt,
  type Verification,
} from "@/lib/sellerApi";

/** Raw enum values shouldn't leak into the UI. */
function documentLabel(value: string | null) {
  if (!value) return null;
  return DOCUMENT_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const STATUS_COPY: Record<string, { title: string; body: string; tone: string }> = {
  UNSTARTED: {
    title: "Not verified yet",
    body: "You can list items right now. Verification is only needed before money can be paid out to you.",
    tone: "border-line bg-paper-card",
  },
  PENDING: {
    title: "Verification in progress",
    body: "You have a verification session open. Finish it to unlock payouts.",
    tone: "border-gold/30 bg-gold/10",
  },
  VERIFIED: {
    title: "Identity verified",
    body: "Payouts are unlocked, and your listings now show a verified badge to buyers.",
    tone: "border-sage/50 bg-sage/20",
  },
  REJECTED: {
    title: "Verification didn't go through",
    body: "Nothing is lost — you can start a new check whenever you're ready.",
    tone: "border-clay/30 bg-clay/10",
  },
};

export default function VerifyPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [verification, setVerification] = useState<Verification | null>(null);
  const [attempts, setAttempts] = useState<KycAttempt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const data = await getVerification();
      setVerification(data.verification);
      setAttempts(data.attempts);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't load your verification status."
      );
    }
  }, []);

  useEffect(() => {
    if (user?.isSeller) load();
  }, [user?.isSeller, load]);

  async function handleStart() {
    setError(null);
    setBusy(true);
    try {
      const { session } = await startVerification();
      if (session.external) {
        // Stripe hosts the capture. Leaving the site is the point: the document
        // is uploaded to them and never passes through this application.
        window.location.href = session.redirectUrl;
        return;
      }
      router.push(session.redirectUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start verification.");
      setBusy(false);
    }
  }

  if (loading || !user) {
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-16">
          <div className="mx-auto max-w-3xl text-sm text-ink-dim">Loading…</div>
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
          <div className="mx-auto max-w-3xl">
            <h1 className="font-serif text-3xl font-medium text-ink">
              Seller accounts only
            </h1>
            <p className="mt-3 text-sm text-ink-dim">
              Identity verification applies to sellers receiving payouts.
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

  const copy = verification ? STATUS_COPY[verification.status] : null;

  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-3xl">
          <Link href="/seller" className="text-sm text-ink-dim transition hover:text-gold-dim">
            ← Your listings
          </Link>

          <h1 className="mt-4 font-serif text-3xl font-medium tracking-tight text-ink sm:text-4xl">
            Identity verification
          </h1>
          <p className="mt-3 text-sm text-ink-dim">
            We never store your ID document. The check is run by a verification
            provider, and we keep only the result.
          </p>

          {verification?.isStub && (
            <div className="mt-6 rounded-2xl border border-gold/40 bg-gold/10 p-5">
              <p className="text-sm font-semibold text-ink">
                Development stub — no real identity check
              </p>
              <p className="mt-2 text-sm text-ink-dim">
                No identity provider is connected, so nothing here verifies a real
                person. Swapping in Stripe Identity (or Persona, Onfido, Veriff) means
                implementing one module; the rest of this flow stays the same.
              </p>
            </div>
          )}

          {error && (
            <p className="mt-6 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
              {error}
            </p>
          )}

          {verification === null ? (
            <p className="mt-8 text-sm text-ink-dim">Loading…</p>
          ) : (
            <>
              <div className={`mt-8 rounded-2xl border p-6 ${copy?.tone ?? "border-line"}`}>
                <h2 className="text-base font-semibold text-ink">{copy?.title}</h2>
                <p className="mt-2 text-sm text-ink-dim">{copy?.body}</p>

                {verification.rejectionReason && (
                  <p className="mt-3 text-sm text-clay">
                    Reason given: {verification.rejectionReason}
                  </p>
                )}

                {verification.verifiedAt && (
                  <p className="mt-3 text-sm text-ink-dim">
                    Verified {formatDate(verification.verifiedAt)}
                    {verification.country ? ` · ${verification.country}` : ""}
                  </p>
                )}

                <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-2 border-t border-line pt-4 text-sm">
                  <div>
                    <dt className="text-ink-dim">Payouts</dt>
                    <dd className="mt-0.5 font-medium text-ink">
                      {verification.payoutsEnabled ? "Unlocked" : "Locked"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-dim">Listing items</dt>
                    <dd className="mt-0.5 font-medium text-ink">
                      Allowed either way
                    </dd>
                  </div>
                </dl>

                <div className="mt-6 flex flex-wrap gap-3">
                  {verification.status === "PENDING" ? (
                    <button
                      type="button"
                      onClick={handleStart}
                      disabled={busy}
                      className="rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90 disabled:opacity-60"
                    >
                      {busy ? "Opening…" : "Continue verification"}
                    </button>
                  ) : verification.status === "VERIFIED" ? (
                    <p className="text-sm text-ink-dim">
                      Nothing further to do here.
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={handleStart}
                      disabled={busy}
                      className="rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90 disabled:opacity-60"
                    >
                      {busy
                        ? "Starting…"
                        : verification.status === "REJECTED"
                          ? "Try again"
                          : "Start verification"}
                    </button>
                  )}
                </div>
              </div>

              {verification.payoutsEnabled && (
                <div className="mt-6 rounded-2xl border border-sage/50 bg-sage/20 p-6">
                  <h2 className="text-base font-semibold text-ink">Payouts are unlocked</h2>
                  <p className="mt-2 text-sm text-ink-dim">
                    Connect a payout account to see what you&apos;re owed and send it
                    to yourself.
                  </p>
                  <Link
                    href="/seller/payouts"
                    className="mt-5 inline-block rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90"
                  >
                    Go to payouts
                  </Link>
                </div>
              )}

              {attempts.length > 0 && (
                <section className="mt-10">
                  <h2 className="font-serif text-xl font-medium text-ink">History</h2>
                  <p className="mt-1 text-sm text-ink-dim">
                    Every check is recorded. Identity decisions have to stay
                    explainable after the fact.
                  </p>
                  <ul className="mt-5 grid gap-3">
                    {attempts.map((attempt) => (
                      <li
                        key={attempt.id}
                        className="rounded-2xl border border-line bg-paper-card p-4 text-sm"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-ink">
                            {attempt.status === "VERIFIED"
                              ? "Verified"
                              : attempt.status === "REJECTED"
                                ? "Rejected"
                                : "In progress"}
                          </span>
                          <span className="text-xs text-ink-dim">
                            {formatDate(attempt.createdAt)}
                          </span>
                        </div>
                        <p className="mt-1 text-ink-dim">
                          {documentLabel(attempt.documentType) ?? "No document submitted"}
                          {attempt.country ? ` · ${attempt.country}` : ""}
                          {` · via ${attempt.provider}`}
                        </p>
                        {attempt.rejectionReason && (
                          <p className="mt-1 text-clay">{attempt.rejectionReason}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
