"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import NotificationPreferences from "@/components/NotificationPreferences";
import PushToggle from "@/components/PushToggle";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import { useNotifications } from "@/lib/NotificationContext";
import {
  IS_BAD_NEWS,
  NOTIFICATION_ICON,
  deleteNotification,
  getNotifications,
  timeAgo,
  type Notification,
} from "@/lib/notificationsApi";

export default function NotificationsPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { markRead, markAllRead, refreshCount } = useNotifications();

  const [items, setItems] = useState<Notification[] | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const data = await getNotifications({ unreadOnly, limit: 100 });
      setItems(data.notifications);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your notifications.");
      setItems([]);
    }
  }, [unreadOnly]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  async function remove(id: string) {
    setError(null);
    setBusyId(id);
    try {
      await deleteNotification(id);
      setItems((current) => current?.filter((n) => n.id !== id) ?? null);
      void refreshCount();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove that.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading || !user) {
    return <Shell><p className="text-sm text-ink-dim">Loading…</p></Shell>;
  }

  const list = items ?? [];
  const unreadCount = list.filter((n) => !n.read).length;

  return (
    <Shell>
      <Link href="/account" className="text-sm text-ink-dim transition hover:text-gold-dim">
        ← Your account
      </Link>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Notifications
        </h1>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={async () => {
              await markAllRead();
              await load();
            }}
            className="text-sm text-gold-dim underline"
          >
            Mark all read
          </button>
        )}
      </div>

      <p className="mt-3 max-w-2xl text-sm text-ink-dim">
        Things that have actually happened to you — sales, deliveries, reviews,
        and decisions about your account. Nothing promotional ends up here.
      </p>

      {error && (
        <p className="mt-6 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      )}

      <div className="mt-8 flex flex-wrap gap-2">
        {[
          { key: false, label: "All" },
          { key: true, label: "Unread" },
        ].map((tab) => (
          <button
            key={String(tab.key)}
            type="button"
            onClick={() => setUnreadOnly(tab.key)}
            className={`rounded-full px-4 py-2 text-sm transition ${
              unreadOnly === tab.key
                ? "bg-gold-dim font-semibold text-paper"
                : "border border-line text-ink hover:border-gold/40"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {items === null ? (
        <p className="mt-10 text-sm text-ink-dim">Loading…</p>
      ) : list.length === 0 ? (
        <div className="mt-8 border border-line bg-blush p-10 text-center">
          <p className="text-ink">
            {unreadOnly ? "Nothing unread" : "Nothing yet"}
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-dim">
            {unreadOnly
              ? "You're all caught up."
              : "When something you sold is bought, or something you bought is sent, it'll appear here."}
          </p>
        </div>
      ) : (
        <ul className="mt-8 grid gap-3">
          {list.map((n) => (
            <li
              key={n.id}
              className={`flex flex-wrap items-start gap-4 rounded-2xl border p-4 ${
                n.read ? "border-line bg-paper-card" : "border-gold/40 bg-gold/5"
              }`}
            >
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                  IS_BAD_NEWS[n.type] ? "bg-clay/15 text-clay" : "bg-gold/15 text-gold-dim"
                }`}
              >
                {NOTIFICATION_ICON[n.type]}
              </span>

              <div className="min-w-48 flex-1">
                <p className="text-sm font-medium text-ink">{n.title}</p>
                {n.body && <p className="mt-1 text-sm text-ink-dim">{n.body}</p>}
                <p className="mt-1.5 text-xs text-ink-dim">
                  {timeAgo(n.createdAt)}
                  {!n.read && " · unread"}
                </p>

                <div className="mt-3 flex flex-wrap gap-3">
                  {n.link && (
                    <Link
                      href={n.link}
                      onClick={() => !n.read && void markRead(n.id)}
                      className="text-xs text-gold-dim underline"
                    >
                      Open
                    </Link>
                  )}
                  {!n.read && (
                    <button
                      type="button"
                      onClick={async () => {
                        await markRead(n.id);
                        await load();
                      }}
                      className="text-xs text-ink-dim underline transition hover:text-ink"
                    >
                      Mark read
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(n.id)}
                    disabled={busyId === n.id}
                    className="ml-auto text-xs text-ink-dim underline transition hover:text-clay disabled:opacity-60"
                  >
                    {busyId === n.id ? "Removing…" : "Remove"}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Below the list, not above it: people come here to read what happened,
          and settings are the thing they occasionally come here to change. */}
      <div className="mt-12 space-y-6">
        <PushToggle />
        <NotificationPreferences />
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-3xl">{children}</div>
      </main>
      <Footer />
    </>
  );
}
