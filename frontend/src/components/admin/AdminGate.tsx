"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import AdminShell from "@/components/admin/AdminShell";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import {
  adminSignIn,
  adminSignOut,
  confirmTotp,
  getAdminSession,
  getOverview,
  isAdminSessionActive,
  startTotpSetup,
} from "@/lib/adminApi";

/**
 * The one door into the admin panel, and the four states it can be in.
 *
 * Every admin screen wraps itself in this rather than repeating the checks. It
 * used to be copy-pasted per page, which is exactly how one page ends up
 * quietly less careful than the others.
 *
 *   not an admin   → "Not found", the same page a wrong URL gives
 *   no 2FA yet     → enrol first
 *   no live session→ password + code
 *   ready          → the dashboard, inside the shell
 */

type GateContext = {
  /** Re-run the session check. Call after a 401 so an expired session re-locks. */
  recheck: () => void;
  /** Handles the "your session ended" case; rethrows anything else. */
  handleError: (err: unknown) => void;
};

const Ctx = createContext<GateContext>({ recheck: () => {}, handleError: () => {} });

export function useAdminGate() {
  return useContext(Ctx);
}

/** True when an error means the admin session is gone rather than a real fault. */
export function isSessionError(err: unknown) {
  return (
    err instanceof ApiError &&
    (err.code === "ADMIN_SESSION_REQUIRED" || err.code === "ADMIN_REVOKED")
  );
}

type State =
  | { kind: "loading" }
  | { kind: "notFound" }
  | { kind: "setup" }
  | { kind: "locked" }
  | { kind: "ready"; secondsLeft: number; openReports: number; openReturns: number };

export default function AdminGate({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  /** A function, so the page's own requests only fire once access is granted. */
  children: () => React.ReactNode;
}) {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [state, setState] = useState<State>({ kind: "loading" });

  /**
   * Set when enrolment has just finished, so the sign-in screen can warn about
   * the one confusing case.
   *
   * Codes are single-use, and finishing setup spends one. Someone who enrols
   * and then types the digits their app is *still showing* would be refused
   * with "That didn't work" — correct, and baffling, since the app is showing
   * exactly what was asked for. One sentence prevents that.
   */
  const [justEnrolled, setJustEnrolled] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  const check = useCallback(async () => {
    try {
      const session = await getAdminSession();
      if (!session.isAdmin) return setState({ kind: "notFound" });
      if (session.needsTotpSetup) return setState({ kind: "setup" });

      const live = await isAdminSessionActive();
      if (!live.active) return setState({ kind: "locked" });

      // The badge counts. Failing to load them must not lock a working panel,
      // so they fall back to zero rather than throwing.
      const badges = await getOverview()
        .then((o) => ({
          openReports: o.reports.open,
          openReturns: o.returns.escalated,
        }))
        .catch(() => ({ openReports: 0, openReturns: 0 }));

      setState({ kind: "ready", secondsLeft: live.secondsLeft, ...badges });
    } catch {
      setState({ kind: "notFound" });
    }
  }, []);

  useEffect(() => {
    if (user) check();
  }, [user, check]);

  const handleError = useCallback(
    (err: unknown) => {
      if (isSessionError(err)) setState({ kind: "locked" });
    },
    []
  );

  async function signOut() {
    await adminSignOut();
    setState({ kind: "locked" });
  }

  if (loading || !user || state.kind === "loading") {
    return <Plain><p className="text-sm text-ink-dim">Loading…</p></Plain>;
  }

  /**
   * A non-admin gets the same page a wrong URL would give.
   *
   * Not "you are not an admin" — that confirms the panel is here and that this
   * account merely lacks the flag, which is a small piece of a map an attacker
   * would rather have than not. There is no sign-in form to probe either.
   */
  if (state.kind === "notFound") {
    return (
      <Plain>
        <h1 className="font-serif text-3xl font-semibold text-ink">Not found</h1>
        <p className="mt-3 text-sm text-ink-dim">There&apos;s nothing at this address.</p>
        <Link
          href="/"
          className="mt-6 inline-block rounded bg-gold-dim px-5 py-2.5 text-sm font-medium text-paper transition hover:brightness-95"
        >
          Back to the shop
        </Link>
      </Plain>
    );
  }

  if (state.kind === "setup") {
    return (
      <Plain>
        <TotpSetup
          onDone={() => {
            setJustEnrolled(true);
            check();
          }}
        />
      </Plain>
    );
  }

  if (state.kind === "locked") {
    return <Plain><StepUp onDone={check} justEnrolled={justEnrolled} /></Plain>;
  }

  return (
    <Ctx.Provider value={{ recheck: check, handleError }}>
      <AdminShell
        title={title}
        subtitle={subtitle}
        actions={actions}
        openReports={state.openReports}
        openReturns={state.openReturns}
        secondsLeft={state.secondsLeft}
        onSignOut={signOut}
      >
        {children()}
      </AdminShell>
    </Ctx.Provider>
  );
}

/**
 * The pre-authorised states get no sidebar.
 *
 * Rendering the shell around a locked panel would list every section by name to
 * someone who has not proved they may see any of them.
 */
function Plain({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-blush px-6 py-16">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

/* ------------------------------------------------------------------ */

function TotpSetup({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [enrolment, setEnrolment] = useState<{ qrDataUrl: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function begin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      setEnrolment(await startTotpSetup(password));
      setPassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start setup.");
    } finally {
      setBusy(false);
    }
  }

  async function finish(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await confirmTotp(code);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't confirm that code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="font-serif text-2xl font-semibold text-ink">
        Set up two-factor authentication
      </h1>
      <p className="mt-3 text-sm text-ink-dim">
        The admin panel needs a code from an authenticator app as well as your
        password. Use Google Authenticator, 1Password, Aegis — anything that
        does TOTP.
      </p>
      <p className="mt-2 text-xs text-ink-dim">
        Not SMS: text messages can be redirected by taking over your phone
        number, which is a real attack against accounts like this one.
      </p>

      {error && (
        <p className="mt-5 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      )}

      {!enrolment ? (
        <form onSubmit={begin} className="mt-6 rounded-2xl border border-line bg-paper-card p-6">
          <label htmlFor="setup-password" className="block text-xs text-ink-dim">
            Confirm your password
          </label>
          <input
            id="setup-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            className="mt-1.5 w-full rounded border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-gold/50"
          />
          <p className="mt-2 text-xs text-ink-dim">
            Asked again because enrolling a second factor from a session that
            might be stolen would defeat the point of having one.
          </p>
          <button
            type="submit"
            disabled={busy || !password}
            className="mt-4 w-full rounded bg-gold-dim px-5 py-3 text-sm font-semibold text-paper transition hover:brightness-95 disabled:opacity-50"
          >
            {busy ? "Starting…" : "Continue"}
          </button>
        </form>
      ) : (
        <form onSubmit={finish} className="mt-6 rounded-2xl border border-line bg-paper-card p-6">
          <p className="text-sm font-medium text-ink">Scan this</p>
          <div className="mt-3 flex justify-center rounded-xl bg-paper p-4">
            <Image
              src={enrolment.qrDataUrl}
              alt="QR code for setting up two-factor authentication"
              width={200}
              height={200}
              unoptimized
            />
          </div>
          <p className="mt-3 text-xs text-ink-dim">Can&apos;t scan? Enter this key instead:</p>
          <code className="mt-1 block break-all rounded bg-blush px-3 py-2 font-mono text-xs text-ink">
            {enrolment.secret}
          </code>

          <label htmlFor="setup-code" className="mt-5 block text-xs text-ink-dim">
            Then type the six-digit code it shows
          </label>
          <input
            id="setup-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={busy}
            placeholder="123456"
            className="mt-1.5 w-full rounded border border-line bg-paper px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-gold/50"
          />
          <button
            type="submit"
            disabled={busy || code.replace(/\D/g, "").length < 6}
            className="mt-4 w-full rounded bg-gold-dim px-5 py-3 text-sm font-semibold text-paper transition hover:brightness-95 disabled:opacity-50"
          >
            {busy ? "Checking…" : "Confirm"}
          </button>
        </form>
      )}
    </>
  );
}

function StepUp({
  onDone,
  justEnrolled = false,
}: {
  onDone: () => void;
  justEnrolled?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await adminSignIn(password, code);
      setPassword("");
      setCode("");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="font-serif text-2xl font-semibold text-ink">Admin sign-in</h1>
      <p className="mt-3 text-sm text-ink-dim">
        Being signed in to RetailStore_2n isn&apos;t enough to open this. Confirm your
        password and a code from your authenticator app.
      </p>

      {justEnrolled && (
        <p className="mt-4 rounded-xl border border-gold/30 bg-gold/5 px-4 py-3 text-sm text-ink">
          Two-factor is set up. Each code works once, and finishing setup used
          the one your app is showing now — <strong>wait for the next one</strong>.
        </p>
      )}

      {error && (
        <p className="mt-5 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      )}

      <form onSubmit={submit} className="mt-6 rounded-2xl border border-line bg-paper-card p-6">
        <label htmlFor="admin-password" className="block text-xs text-ink-dim">
          Password
        </label>
        <input
          id="admin-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          className="mt-1.5 w-full rounded border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-gold/50"
        />

        <label htmlFor="admin-code" className="mt-4 block text-xs text-ink-dim">
          Authenticator code
        </label>
        <input
          id="admin-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={busy}
          placeholder="123456"
          className="mt-1.5 w-full rounded border border-line bg-paper px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-gold/50"
        />

        <button
          type="submit"
          disabled={busy || !password || code.replace(/\D/g, "").length < 6}
          className="mt-5 w-full rounded bg-gold-dim px-5 py-3 text-sm font-semibold text-paper transition hover:brightness-95 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Open the admin panel"}
        </button>

        <p className="mt-3 text-xs text-ink-dim">The session lasts thirty minutes.</p>
      </form>
    </>
  );
}
