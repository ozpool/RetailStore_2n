"use client";

import Link from "next/link";
import { useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { forgotPassword } from "@/lib/api";

/**
 * Asking for a reset link.
 *
 * THE WORDING IS THE SECURITY PROPERTY
 * The API answers identically whether or not the address has an account, so
 * that it cannot be used to discover which emails are registered here. That
 * only holds if the page says the same thing too — "check your inbox" for an
 * address with no account, and never "we don't know that email".
 *
 * It reads slightly oddly on purpose. "If that address has an account" is the
 * honest phrasing, and it is what every service that takes this seriously says.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await forgotPassword(email.trim());
    } catch {
      // Swallowed deliberately. A visible error here would distinguish
      // addresses that exist from ones that do not, which is the whole thing
      // this endpoint is built to avoid.
    } finally {
      setBusy(false);
      setSent(true);
    }
  }

  return (
    <Shell>
      {sent ? (
        <>
          <h1 className="font-serif text-2xl font-semibold text-ink">Check your inbox</h1>
          <p className="mt-3 text-sm text-ink-dim">
            If <span className="text-ink">{email.trim()}</span> has an account, a
            reset link is on its way. It works once and expires in an hour.
          </p>
          <p className="mt-4 text-sm text-ink-dim">
            Nothing arrived? Check spam, then{" "}
            <button
              type="button"
              onClick={() => setSent(false)}
              className="text-gold-dim hover:underline"
            >
              try a different address
            </button>
            .
          </p>
          <Link
            href="/login"
            className="mt-6 inline-block rounded bg-gold-dim px-5 py-2.5 text-sm font-medium text-paper transition hover:brightness-95"
          >
            Back to sign in
          </Link>
        </>
      ) : (
        <>
          <h1 className="font-serif text-2xl font-semibold text-ink">
            Forgotten your password?
          </h1>
          <p className="mt-3 text-sm text-ink-dim">
            Enter the address you signed up with and we&apos;ll send a link to
            choose a new one.
          </p>

          <form onSubmit={submit} className="mt-6 rounded-2xl border border-line bg-paper-card p-6">
            <label htmlFor="forgot-email" className="block text-xs text-ink-dim">
              Email address
            </label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              className="mt-1.5 w-full rounded border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-gold/50 disabled:opacity-60"
            />

            <button
              type="submit"
              disabled={busy || email.trim().length === 0}
              className="mt-5 w-full rounded bg-gold-dim px-5 py-3 text-sm font-semibold text-paper transition hover:brightness-95 disabled:opacity-50"
            >
              {busy ? "Sending…" : "Send me a link"}
            </button>

            <p className="mt-4 text-xs text-ink-dim">
              Remembered it?{" "}
              <Link href="/login" className="text-gold-dim hover:underline">
                Sign in
              </Link>
            </p>
          </form>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Nav />
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="w-full max-w-md">{children}</div>
      </main>
      <Footer />
    </>
  );
}
