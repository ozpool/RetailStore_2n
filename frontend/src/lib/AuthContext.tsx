"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import * as api from "@/lib/api";
import type { User } from "@/lib/api";

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  // With email verification on, this returned Promise<{ email: string }>.
  signup: (input: { name: string; email: string; password: string }) => Promise<void>;
  login: (input: { email: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  verifyEmail: (token: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  becomeSeller: () => Promise<void>;
  setAvatar: (file: File) => Promise<void>;
  clearAvatar: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  /**
   * Keeps a signed-in session from lapsing while a tab sits open.
   *
   * Access tokens last 15 minutes. Calling /api/auth/me before that returns a
   * 401 the BFF handles by refreshing and retrying, so the session rolls
   * forward and the user object stays current. The single-flight guard in
   * backendProxy means this can't collide with other requests doing the same.
   *
   * Timers don't fire on a sleeping machine, so a visibility check covers the
   * "closed the laptop for an hour" case that a bare interval would miss.
   */
  /**
   * Null until the first check, rather than seeded with Date.now().
   *
   * Reading the clock during render makes the component impure: the value
   * differs between the server render and the client hydration. Harmless for a
   * timer baseline, but the rule that flags it is right, and null-then-set is
   * both correct and no more code.
   */
  const lastCheck = useRef<number | null>(null);

  // Keyed on the id, not the object: revalidating replaces `user` with a new
  // object every 13 minutes, and depending on that would tear the timer down
  // and rebuild it each time for no reason.
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return;

    const INTERVAL_MS = 13 * 60 * 1000;

    async function revalidate() {
      lastCheck.current = Date.now();
      try {
        const { user: fresh } = await api.me();
        setUser(fresh);
      } catch {
        // Genuinely signed out — reflect that rather than showing a stale name.
        setUser(null);
      }
    }

    const timer = setInterval(revalidate, INTERVAL_MS);

    function onVisible() {
      if (document.visibilityState !== "visible") return;
      // No check yet means nothing to be stale about.
      if (lastCheck.current !== null && Date.now() - lastCheck.current < INTERVAL_MS) return;
      revalidate();
    }

    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId]);

  const signup = useCallback(async (input: { name: string; email: string; password: string }) => {
    // EMAIL VERIFICATION IS SWITCHED OFF: signup signs the new account in directly.
    // // Signup no longer logs the user in — the account is unverified until
    // // they click the link sent to their email.
    // const { email } = await api.signup(input);
    // return { email };
    const { user } = await api.signup(input);
    setUser(user);
  }, []);

  const login = useCallback(async (input: { email: string; password: string }) => {
    const { user } = await api.login(input);
    setUser(user);
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  const verifyEmail = useCallback(async (token: string) => {
    const { user } = await api.verifyEmail(token);
    setUser(user);
  }, []);

  const resendVerification = useCallback(async (email: string) => {
    await api.resendVerification(email);
  }, []);

  const becomeSeller = useCallback(async () => {
    const { user } = await api.becomeSeller();
    setUser(user);
  }, []);

  // The API returns the updated user, so the avatar refreshes everywhere it
  // renders — nav, account page — without a reload.
  const setAvatar = useCallback(async (file: File) => {
    const { user } = await api.uploadAvatar(file);
    setUser(user);
  }, []);

  const clearAvatar = useCallback(async () => {
    const { user } = await api.removeAvatar();
    setUser(user);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        signup,
        login,
        logout,
        verifyEmail,
        resendVerification,
        becomeSeller,
        setAvatar,
        clearAvatar,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
