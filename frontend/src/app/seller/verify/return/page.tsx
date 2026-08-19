"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import {
  getVerification,
  getVerificationSessionStatus,
  type VerificationStatus,
} from "@/lib/sellerApi";

/**
 * Where Stripe sends the seller after their identity check.
 *
 * WHY THIS PAGE POLLS
 * Stripe's redirect proves the seller finished the flow — not that the result
 * has reached us. The decision arrives by webhook, which can be slower than the
 * redirect, and can be missed entirely if the tunnel wasn't running. Sitting on
 * "we'll email you" would be a poor answer when we can simply ask.
 *
 * WHY IT DOESN'T READ A SESSION ID FROM THE URL
 * Stripe's return_url is fixed at session creation, before the session id
 * exists, so the id can't be baked into it. Rather than pass it around, this
 * asks the API for the seller's most recent attempt — which also means a
 * verification session id never appears in a URL, a browser history, or a
 * referer header.
 */

const POLL_INTERVAL_MS = 2_000;
const POLL_LIMIT = 15; // ~30 seconds, then hand over to the webhook.

export default function VerifyReturnPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const attempts = useRef(0);
  const stopped = useRef(false);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  const poll = useCallback(async () => {
    try {
      const { verification, attempts: history } = await getVerification();

      // Already settled — the webhook beat the redirect, which is the happy path.
      if (verification.status === "VERIFIED" || verification.status === "REJECTED") {
        setStatus(verification.status);
        setReason(verification.rejectionReason);
        stopped.current = true;
        return;
      }

      const latest = history[0];
      if (!latest) {
        setStatus(verification.status);
        stopped.current = true;
        return;
      }

      const result = await getVerificationSessionStatus(latest.providerSessionId);
      if (result.status !== "PENDING") {
        setStatus(result.status);
        setReason(result.rejectionReason);
        stopped.current = true;
        return;
      }

      setStatus("PENDING");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't check your verification.");
      stopped.current = true;
    }
  }, []);

  useEffect(() => {
    if (loading || !user?.isSeller) return;

    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      if (stopped.current) return;
      attempts.current += 1;
      await poll();
      if (stopped.current) return;
      if (attempts.current >= POLL_LIMIT) {
        // Stripe sometimes reviews a document rather than deciding instantly.
        // Not an error, and not something to keep hammering.
        setGaveUp(true);
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }

    void tick();
    return () => {
      stopped.current = true;
      clearTimeout(timer);
    };
  }, [loading, user?.isSeller, poll]);

  if (loading || !user) {
    return <Shell><p className="text-sm text-ink-dim">Loading…</p></Shell>;
  }

  return (
    <Shell>
      <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        {status === "VERIFIED"
          ? "You're verified"
          : status === "REJECTED"
            ? "That check didn't pass"
            : "Checking your verification"}
      </h1>

      {error && (
        <p className="mt-6 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      )}

      {status === "VERIFIED" && (
        <div className="mt-6 rounded-2xl border border-sage/50 bg-sage/20 p-6">
          <p className="text-sm text-ink">
            Your identity is confirmed and payouts are unlocked. Buyers will see a
            verified badge on your listings.
          </p>
          <p className="mt-3 text-xs text-ink-dim">
            We kept a reference to the check and nothing from the document itself
            — no image, no number, no date of birth.
          </p>
        </div>
      )}

      {status === "REJECTED" && (
        <div className="mt-6 rounded-2xl border border-clay/30 bg-clay/10 p-6">
          <p className="text-sm text-ink">
            {reason ?? "We couldn't confirm your identity from that check."}
          </p>
          <p className="mt-3 text-sm text-ink-dim">
            Nothing is lost — your listings stay up, and you can start a new check
            whenever you like. Only payouts stay locked.
          </p>
        </div>
      )}

      {(status === null || status === "PENDING") && !error && (
        <div className="mt-6 rounded-2xl border border-gold/30 bg-gold/5 p-6">
          {gaveUp ? (
            <>
              <p className="text-sm text-ink">
                Still being reviewed. Some documents need a closer look, which can
                take a few minutes.
              </p>
              <p className="mt-3 text-sm text-ink-dim">
                You don&apos;t need to wait here — this updates on its own, and
                you&apos;ll see the result on your verification page.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-ink">
                Waiting for the result from Stripe. This usually takes a few
                seconds.
              </p>
              <p className="mt-3 text-xs text-ink-dim">
                Safe to leave this page — the result arrives whether or not
                you&apos;re watching.
              </p>
            </>
          )}
        </div>
      )}

      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          href="/seller/verify"
          className="rounded bg-gold-dim px-6 py-3 text-sm font-medium text-paper transition hover:brightness-95"
        >
          Verification page
        </Link>
        <Link
          href="/seller"
          className="rounded border border-line px-6 py-3 text-sm font-medium text-ink transition hover:border-gold/40"
        >
          Your listings
        </Link>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-2xl">{children}</div>
      </main>
      <Footer />
    </>
  );
}
