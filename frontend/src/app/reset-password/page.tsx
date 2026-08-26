"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { ApiError, resetPassword } from "@/lib/api";

export default function ResetPasswordPage() {
  return (
    // useSearchParams needs a Suspense boundary in the App Router.
    <Suspense fallback={<Shell><p className="text-sm text-ink-dim">Loading…</p></Shell>}>
      <ResetForm />
    </Suspense>
  );
}

/**
 * Choosing a new password from an emailed link.
 *
 * DELIBERATELY DOES NOT SIGN YOU IN
 * A successful reset sends you to the login page to type what you just chose.
 * Signing in automatically would make the link a one-click login, and links
 * leak — forwarded mail, a shared screen, a scanner that follows URLs. Typing
 * it once also confirms you know what you set.
 */
function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";

  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = token.length > 0 && next.length >= 12 && !mismatch && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await resetPassword({ token, newPassword: next });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reset your password.");
    } finally {
      setBusy(false);
    }
  }

  /* A link with no token at all — usually a truncated paste. */
  if (!token) {
    return (
      <Shell>
        <h1 className="font-serif text-2xl font-semibold text-ink">That link is incomplete</h1>
        <p className="mt-3 text-sm text-ink-dim">
          The address is missing its token — mail clients sometimes cut long
          links in half. Copy the whole thing, or ask for a new one.
        </p>
        <Link
          href="/forgot-password"
          className="mt-6 inline-block rounded bg-gold-dim px-5 py-2.5 text-sm font-medium text-paper transition hover:brightness-95"
        >
          Send a new link
        </Link>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <h1 className="font-serif text-2xl font-semibold text-ink">Password changed</h1>
        <p className="mt-3 text-sm text-ink-dim">
          Every device that was signed in has been signed out, including any you
          didn&apos;t recognise. Sign in with your new password.
        </p>
        <button
          type="button"
          onClick={() => router.push("/login")}
          className="mt-6 rounded bg-gold-dim px-5 py-2.5 text-sm font-medium text-paper transition hover:brightness-95"
        >
          Sign in
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="font-serif text-2xl font-semibold text-ink">Choose a new password</h1>
      <p className="mt-3 text-sm text-ink-dim">
        This link works once. Setting a new password signs out every device.
      </p>

      {error && (
        <p className="mt-5 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}{" "}
          <Link href="/forgot-password" className="underline">
            Ask for a new link
          </Link>
          .
        </p>
      )}

      <form onSubmit={submit} className="mt-6 rounded-2xl border border-line bg-paper-card p-6">
        <label htmlFor="new-password" className="block text-xs text-ink-dim">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          disabled={busy}
          className="mt-1.5 w-full rounded border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-gold/50 disabled:opacity-60"
        />
        <p className="mt-1.5 text-xs text-ink-dim">
          At least 12 characters, and checked against known breach lists.
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
          {busy ? "Saving…" : "Set new password"}
        </button>
      </form>
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
