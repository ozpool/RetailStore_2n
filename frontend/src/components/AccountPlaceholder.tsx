"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { useAuth } from "@/lib/AuthContext";

/**
 * A signed-in account page for something that depends on checkout, which isn't
 * built. States plainly what's missing and why rather than showing an empty
 * table that looks like a bug or a loading failure.
 */
export default function AccountPlaceholder({
  title,
  lead,
  because,
  icon,
}: {
  title: string;
  lead: string;
  because: string;
  icon: ReactNode;
}) {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-16">
          <div className="mx-auto max-w-4xl text-sm text-ink-dim">Loading…</div>
        </main>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-4xl">
          <Link href="/account" className="text-sm text-ink-dim transition hover:text-gold-dim">
            ← Your account
          </Link>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
              {title}
            </h1>
            <span className="border border-gold/40 px-3 py-1 text-xs font-medium text-gold-dim">
              Planned
            </span>
          </div>

          <p className="mt-3 max-w-2xl text-sm text-ink-dim">{lead}</p>

          <div className="mt-10 border border-line bg-blush p-10 text-center">
            <span
              className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-paper text-ink-dim"
              aria-hidden="true"
            >
              {icon}
            </span>
            <p className="mt-5 text-ink">Nothing here yet</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-ink-dim">{because}</p>
            <Link
              href="/search"
              className="mt-6 inline-block rounded bg-gold-dim px-6 py-3 text-sm font-medium text-paper transition hover:brightness-95"
            >
              Browse the shop
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
