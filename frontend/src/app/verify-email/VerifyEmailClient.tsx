"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import Logo from "@/components/Logo";
import { useAuth } from "@/lib/AuthContext";

export default function VerifyEmailClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { verifyEmail } = useAuth();
  const [status, setStatus] = useState<"verifying" | "success" | "error">("verifying");

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setStatus("error");
      return;
    }

    verifyEmail(token)
      .then(() => {
        setStatus("success");
        setTimeout(() => router.push("/"), 1500);
      })
      .catch(() => setStatus("error"));
    // Only ever run once per page load — verifyEmail() consumes a single-use token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="flex min-h-screen flex-1 items-center justify-center px-6">
      <div className="w-full max-w-sm text-center">
        <Link href="/" className="flex items-center justify-center gap-2.5">
          <Logo size={28} />
          <span className="font-serif text-lg font-medium tracking-tight text-ink">
            <span className="text-gradient-gold">RetailStore_2n</span>
          </span>
        </Link>

        <div className="mt-10">
          {status === "verifying" && (
            <p className="text-ink-dim">Verifying your email…</p>
          )}

          {status === "success" && (
            <>
              <h1 className="font-serif text-2xl font-medium text-ink">You&apos;re verified.</h1>
              <p className="mt-2 text-sm text-ink-dim">Taking you to RetailStore_2n…</p>
            </>
          )}

          {status === "error" && (
            <>
              <h1 className="font-serif text-2xl font-medium text-ink">
                That link didn&apos;t work.
              </h1>
              <p className="mt-2 text-sm text-ink-dim">
                It may have expired or already been used.
              </p>
              <Link
                href="/signup"
                className="mt-6 inline-block text-sm font-medium text-gold-dim hover:text-gold"
              >
                Back to sign up
              </Link>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
