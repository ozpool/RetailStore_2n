"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Logo from "@/components/Logo";
import { IMAGES } from "@/lib/images";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";

export default function LoginPage() {
  const router = useRouter();
  const { login, resendVerification } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resent, setResent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNeedsVerification(false);
    setResent(false);
    setSubmitting(true);
    try {
      await login({ email, password });
      router.push("/");
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMAIL_NOT_VERIFIED") {
        setNeedsVerification(true);
      }
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    await resendVerification(email);
    setResent(true);
  }

  return (
    <main className="flex min-h-screen flex-1">
      <div className="relative hidden w-1/2 lg:block">
        <Image
          src={IMAGES.heroFleaMarket}
          alt="Table of vintage and secondhand items at an outdoor market"
          fill
          className="object-cover"
        />
        <div className="absolute inset-0 bg-linear-to-t from-ink from-10% via-ink/75 via-45% to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-10">
          <p className="font-serif text-2xl text-paper">
            Welcome back to the good stuff.
          </p>
        </div>
      </div>

      <div className="flex w-full flex-1 items-center justify-center px-6 py-16 lg:w-1/2">
        <div className="w-full max-w-sm">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo size={28} />
            <span className="font-serif text-lg font-medium tracking-tight text-ink">
              <span className="text-gradient-gold">RetailStore_2n</span>
            </span>
          </Link>

          <h1 className="mt-10 font-serif text-3xl font-medium tracking-tight text-ink">
            Welcome back
          </h1>
          <p className="mt-2 text-sm text-ink-dim">Log in to your RetailStore_2n account.</p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <div>
              <label htmlFor="email" className="text-sm font-medium text-ink">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 w-full rounded-2xl border border-line bg-paper-card px-3.5 py-2.5 text-sm text-ink outline-none focus:border-gold"
              />
            </div>

            <div>
              {/* The reset link sits beside the label rather than below the
                  form. Somebody who has forgotten their password realises it
                  at this field, not after scrolling past the submit button. */}
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor="password" className="text-sm font-medium text-ink">
                  Password
                </label>
                <Link
                  href="/forgot-password"
                  className="text-xs text-ink-dim transition hover:text-gold-dim"
                >
                  Forgotten it?
                </Link>
              </div>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 w-full rounded-2xl border border-line bg-paper-card px-3.5 py-2.5 text-sm text-ink outline-none focus:border-gold"
              />
            </div>

            {error && (
              <div>
                <p className="text-sm text-red-700">{error}</p>
                {needsVerification && (
                  <button
                    type="button"
                    onClick={handleResend}
                    disabled={resent}
                    className="mt-2 text-sm font-medium text-gold-dim hover:text-gold disabled:opacity-60"
                  >
                    {resent ? "Verification email sent." : "Resend verification email"}
                  </button>
                )}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="seam-glow w-full rounded-full bg-gold-dim px-6 py-3 text-sm font-semibold text-paper transition hover:brightness-90 disabled:opacity-60"
            >
              {submitting ? "Logging in…" : "Log in"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-ink-dim">
            New to RetailStore_2n?{" "}
            <Link href="/signup" className="font-medium text-gold-dim hover:text-gold">
              Create an account
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
