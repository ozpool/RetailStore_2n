"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { ApiError, changePassword } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";

/**
 * Login and security.
 *
 * The account card used to say "password changes aren't built yet". This is
 * that, built.
 */
export default function SecurityPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  if (loading || !user) {
    return <Shell><p className="text-sm text-ink-dim">Loading…</p></Shell>;
  }

  // Checked here as well as on the server. The server is the one that counts;
  // this exists so the mismatch is caught before a round trip.
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0 && next.length >= 12 && !mismatch && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setField(null);
    setDone(null);
    setBusy(true);
    try {
      const result = await changePassword({ currentPassword: current, newPassword: next });
      setDone(result.message);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setField(err.field ?? null);
      } else {
        setError("Couldn't change your password.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <Link href="/account" className="text-sm text-ink-dim transition hover:text-gold-dim">
        ← Your account
      </Link>

      <h1 className="mt-4 font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        Login &amp; security
      </h1>

      <section className="mt-8 rounded-2xl border border-line bg-paper-card p-6">
        <h2 className="text-base font-semibold text-ink">Email</h2>
        <p className="mt-1 text-sm text-ink-dim">{user.email}</p>
        <p className="mt-2 text-xs text-ink-dim">
          {user.emailVerified
            ? "Confirmed. This is where a reset link would be sent."
            : "Not confirmed yet — check your inbox for the link."}
        </p>
      </section>

      <section className="mt-5 rounded-2xl border border-line bg-paper-card p-6">
        <h2 className="text-base font-semibold text-ink">Change your password</h2>
        <p className="mt-1 max-w-lg text-sm text-ink-dim">
          Changing it signs out every other device. The one you&apos;re using
          stays signed in.
        </p>

        {done && (
          <p className="mt-5 rounded-xl border border-sage-dim/30 bg-sage-dim/5 px-4 py-3 text-sm text-ink">
            {done}
          </p>
        )}
        {error && (
          <p className="mt-5 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
            {error}
          </p>
        )}

        <form onSubmit={submit} className="mt-5 max-w-sm">
          <label htmlFor="current-password" className="block text-xs text-ink-dim">
            Current password
          </label>
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            disabled={busy}
            className={`mt-1.5 w-full rounded border bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-gold/50 disabled:opacity-60 ${
              field === "currentPassword" ? "border-clay/50" : "border-line"
            }`}
          />
          {/* Asked for even though you are already signed in — a stolen session
              must not be enough to take the account permanently. */}
          <p className="mt-1.5 text-xs text-ink-dim">
            Asked for even though you&apos;re signed in, so a stolen session
            can&apos;t lock you out of your own account.
          </p>

          <label htmlFor="new-password" className="mt-5 block text-xs text-ink-dim">
            New password
          </label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            disabled={busy}
            className={`mt-1.5 w-full rounded border bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-gold/50 disabled:opacity-60 ${
              field === "newPassword" ? "border-clay/50" : "border-line"
            }`}
          />
          <p className="mt-1.5 text-xs text-ink-dim">
            At least 12 characters. Checked against known breach lists — a long
            phrase you haven&apos;t used elsewhere beats a short complicated one.
          </p>

          <label htmlFor="confirm-password" className="mt-5 block text-xs text-ink-dim">
            New password again
          </label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
            className={`mt-1.5 w-full rounded border bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-gold/50 disabled:opacity-60 ${
              mismatch ? "border-clay/50" : "border-line"
            }`}
          />
          {mismatch && <p className="mt-1.5 text-xs text-clay">These don&apos;t match.</p>}

          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-6 w-full rounded bg-gold-dim px-5 py-3 text-sm font-semibold text-paper transition hover:brightness-95 disabled:opacity-50"
          >
            {busy ? "Changing…" : "Change password"}
          </button>
        </form>

        <p className="mt-5 border-t border-line pt-4 text-xs text-ink-dim">
          Forgotten it?{" "}
          <Link href="/forgot-password" className="text-gold-dim hover:underline">
            Get a reset link by email
          </Link>{" "}
          instead — you don&apos;t need to be signed in for that.
        </p>
      </section>
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
