"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Logo from "@/components/Logo";
import { IMAGES } from "@/lib/images";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";

type Field = "name" | "email" | "password" | "form";

function WarningIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 8v5m0 3.5h.01M12 3l9 16H3l9-16z" />
    </svg>
  );
}

function FieldError({ message }: { message: string }) {
  return (
    <div className="mt-2 flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
      <WarningIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

export default function SignupPage() {
  // EMAIL VERIFICATION IS SWITCHED OFF (see the signup route in
  // backend/src/routes/auth.ts): signup signs the account in and goes home.
  // The original "Check your email" flow is kept below as comments.
  const router = useRouter();
  const { signup } = useAuth();
  // const { signup, resendVerification } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<{ field: Field; message: string } | null>(null);
  const [errorNonce, setErrorNonce] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // const [sentTo, setSentTo] = useState<string | null>(null);
  // const [resent, setResent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldError(null);
    setSubmitting(true);
    try {
      // const { email: confirmedEmail } = await signup({ name, email, password });
      // setSentTo(confirmedEmail);
      await signup({ name, email, password });
      router.push("/");
    } catch (err) {
      const field: Field =
        err instanceof ApiError && (err.field === "name" || err.field === "email" || err.field === "password")
          ? err.field
          : "form";
      const message = err instanceof Error ? err.message : "Something went wrong.";
      setFieldError({ field, message });
      setErrorNonce((n) => n + 1);
    } finally {
      setSubmitting(false);
    }
  }

  // async function handleResend() {
  //   if (!sentTo) return;
  //   await resendVerification(sentTo);
  //   setResent(true);
  // }

  const errorFor = (field: Field) => (fieldError?.field === field ? fieldError.message : null);
  const inputClass = (field: Field) =>
    `mt-1.5 w-full rounded-2xl border px-3.5 py-2.5 text-sm text-ink outline-none focus:border-gold ${
      fieldError?.field === field ? "border-red-400" : "border-line bg-paper-card"
    }`;

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
            Every piece has a past. Yours is next.
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

          {/*
            The "Check your email" screen shown after signup, switched off with
            email verification. To restore it, wrap the form below in
            `{sentTo ? ( ...this block... ) : ( ...form... )}` again.

            <div className="mt-10">
              <h1 className="font-serif text-3xl font-medium tracking-tight text-ink">
                Check your email
              </h1>
              <p className="mt-3 text-sm text-ink-dim">
                We sent a verification link to <strong className="text-ink">{sentTo}</strong>.
                Click it to activate your account — you won&apos;t be able to log in until
                you do.
              </p>

              {resent ? (
                <p className="mt-6 text-sm font-medium text-gold-dim">Sent again.</p>
              ) : (
                <button
                  type="button"
                  onClick={handleResend}
                  className="mt-6 text-sm font-medium text-gold-dim hover:text-gold"
                >
                  Didn&apos;t get it? Resend the link
                </button>
              )}
            </div>
          */}
          <>
              <h1 className="mt-10 font-serif text-3xl font-medium tracking-tight text-ink">
                Create your account
              </h1>
              <p className="mt-2 text-sm text-ink-dim">
                One account to buy or sell — you can list your first item right after.
              </p>

              <form onSubmit={handleSubmit} className="mt-8 space-y-4">
                <div
                  key={`name-${errorNonce}`}
                  className={errorFor("name") ? "animate-field-shake" : undefined}
                >
                  <label htmlFor="name" className="text-sm font-medium text-ink">
                    Name
                  </label>
                  <input
                    id="name"
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className={inputClass("name")}
                  />
                  {errorFor("name") && <FieldError message={errorFor("name")!} />}
                </div>

                <div
                  key={`email-${errorNonce}`}
                  className={errorFor("email") ? "animate-field-shake" : undefined}
                >
                  <label htmlFor="email" className="text-sm font-medium text-ink">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={inputClass("email")}
                  />
                  {errorFor("email") && <FieldError message={errorFor("email")!} />}
                </div>

                <div
                  key={`password-${errorNonce}`}
                  className={errorFor("password") ? "animate-field-shake" : undefined}
                >
                  <label htmlFor="password" className="text-sm font-medium text-ink">
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    required
                    minLength={12}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={inputClass("password")}
                  />
                  {errorFor("password") ? (
                    <FieldError message={errorFor("password")!} />
                  ) : (
                    <p className="mt-1.5 text-xs text-ink-dim">
                      At least 12 characters. We check it against known data breaches.
                    </p>
                  )}
                </div>

                {errorFor("form") && <FieldError message={errorFor("form")!} />}

                <button
                  type="submit"
                  disabled={submitting}
                  className="seam-glow w-full rounded-full bg-gold-dim px-6 py-3 text-sm font-semibold text-paper transition hover:brightness-90 disabled:opacity-60"
                >
                  {submitting ? "Creating account…" : "Create account"}
                </button>
              </form>

              <p className="mt-6 text-center text-sm text-ink-dim">
                Already have an account?{" "}
                <Link href="/login" className="font-medium text-gold-dim hover:text-gold">
                  Log in
                </Link>
              </p>
          </>
        </div>
      </div>
    </main>
  );
}
