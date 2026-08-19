"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import { DOCUMENT_TYPE_OPTIONS, getVerification, submitVerification } from "@/lib/sellerApi";

const inputClass =
  "mt-1 w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-gold";

/**
 * Stands in for the provider's hosted capture page — STUB MODE ONLY.
 *
 * With Stripe Identity the capture happens on Stripe's own domain and this
 * application never sees the document, which is the entire point of delegating
 * it. So when a real provider is configured, this page must not collect
 * anything: it sends the seller to the return page instead. The API refuses
 * submissions in that mode too, so the guard isn't the only thing standing
 * between a real provider and a document number in our logs.
 */
export default function VerifySessionPage() {
  const router = useRouter();
  const params = useParams<{ sessionId: string }>();
  const { user, loading } = useAuth();
  const [providerHosted, setProviderHosted] = useState(false);

  useEffect(() => {
    if (loading || !user?.isSeller) return;
    let cancelled = false;
    getVerification()
      .then(({ verification }) => {
        if (cancelled || verification.isStub) return;
        setProviderHosted(true);
        router.replace("/seller/verify/return");
      })
      .catch(() => {
        // Can't tell which provider is live. Leaving the form up would risk
        // collecting a document number under a real provider, so don't.
        if (!cancelled) setProviderHosted(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loading, user?.isSeller, router]);

  const [documentType, setDocumentType] = useState("passport");
  const [country, setCountry] = useState("US");
  const [documentNumber, setDocumentNumber] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [result, setResult] = useState<{ outcome: string; reason: string | null } | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldError(null);

    if (documentNumber.trim().length < 6) {
      setFieldError({
        field: "documentNumber",
        message: "Enter at least 6 characters.",
      });
      return;
    }

    setSubmitting(true);
    try {
      const res = await submitVerification(params.sessionId, {
        documentType,
        country: country.trim().toUpperCase(),
        documentNumber: documentNumber.trim(),
      });
      setResult({ outcome: res.outcome, reason: res.rejectionReason });
      // Nothing keeps the number around once it has been sent.
      setDocumentNumber("");
    } catch (err) {
      if (err instanceof ApiError && err.field) {
        setFieldError({ field: err.field, message: err.message });
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't submit that. Try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Covers the redirect above and its failure case: no capture form is rendered
  // unless we positively know the stub is the active provider.
  if (loading || !user || providerHosted) {
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-16">
          <div className="mx-auto max-w-2xl text-sm text-ink-dim">Loading…</div>
        </main>
        <Footer />
      </>
    );
  }

  if (result) {
    const verified = result.outcome === "VERIFIED";
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-16">
          <div className="mx-auto max-w-2xl">
            <div
              className={`rounded-2xl border p-6 ${
                verified ? "border-sage/50 bg-sage/20" : "border-clay/30 bg-clay/10"
              }`}
            >
              <h1 className="font-serif text-2xl font-medium text-ink">
                {verified ? "Identity verified" : "Verification didn't pass"}
              </h1>
              <p className="mt-3 text-sm text-ink-dim">
                {verified
                  ? "Payouts are unlocked and your listings now show a verified badge."
                  : result.reason}
              </p>
              {!verified && (
                <p className="mt-3 text-sm text-ink-dim">
                  You can start another check from the verification page. Your listings
                  are unaffected.
                </p>
              )}
            </div>

            <Link
              href="/seller/verify"
              className="mt-6 inline-block rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90"
            >
              Back to verification
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
        <div className="mx-auto max-w-2xl">
          <Link
            href="/seller/verify"
            className="text-sm text-ink-dim transition hover:text-gold-dim"
          >
            ← Cancel
          </Link>

          <h1 className="mt-4 font-serif text-3xl font-medium tracking-tight text-ink">
            Confirm your identity
          </h1>

          <div className="mt-6 rounded-2xl border border-gold/40 bg-gold/10 p-5">
            <p className="text-sm font-semibold text-ink">
              Development stub — do not enter a real document
            </p>
            <p className="mt-2 text-sm text-ink-dim">
              This page imitates a provider&apos;s hosted capture step. Nothing you type
              is stored: the value is used to pick a test outcome and then discarded.
            </p>
            <ul className="mt-3 space-y-1 text-sm text-ink-dim">
              <li>
                <code className="rounded bg-paper px-1.5 py-0.5 text-xs">…0000</code> —
                fails, document unreadable
              </li>
              <li>
                <code className="rounded bg-paper px-1.5 py-0.5 text-xs">…0001</code> —
                fails, name mismatch
              </li>
              <li>anything else — passes</li>
            </ul>
          </div>

          <form onSubmit={handleSubmit} className="mt-8 grid gap-6" noValidate>
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <label htmlFor="documentType" className="text-sm font-medium text-ink">
                  Document type
                </label>
                <select
                  id="documentType"
                  value={documentType}
                  onChange={(e) => setDocumentType(e.target.value)}
                  className={inputClass}
                >
                  {DOCUMENT_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="country" className="text-sm font-medium text-ink">
                  Issuing country
                </label>
                <input
                  id="country"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  maxLength={2}
                  placeholder="US"
                  className={inputClass}
                />
                <p className="mt-1 text-xs text-ink-dim">Two-letter code.</p>
                {fieldError?.field === "country" && (
                  <p className="mt-1 text-xs text-clay">{fieldError.message}</p>
                )}
              </div>
            </div>

            <div>
              <label htmlFor="documentNumber" className="text-sm font-medium text-ink">
                Document number
              </label>
              <input
                id="documentNumber"
                value={documentNumber}
                onChange={(e) => setDocumentNumber(e.target.value)}
                autoComplete="off"
                placeholder="TEST-123456"
                className={inputClass}
              />
              {fieldError?.field === "documentNumber" && (
                <p className="mt-1 text-xs text-clay">{fieldError.message}</p>
              )}
            </div>

            {error && (
              <p className="rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
                {error}
              </p>
            )}

            <div>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-full bg-gold-dim px-6 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90 disabled:opacity-60"
              >
                {submitting ? "Checking…" : "Submit for verification"}
              </button>
            </div>
          </form>
        </div>
      </main>
      <Footer />
    </>
  );
}
