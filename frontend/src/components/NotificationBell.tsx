"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useAuth } from "@/lib/AuthContext";
import { useNotifications } from "@/lib/NotificationContext";
import { IS_BAD_NEWS, NOTIFICATION_ICON, timeAgo } from "@/lib/notificationsApi";
import { useDismissable } from "@/lib/useDismissable";

export default function NotificationBell() {
  const { open, setOpen, ref } = useDismissable<HTMLDivElement>();
  const { user } = useAuth();
  const { unread, notifications, loadingList, loadList, markRead, markAllRead } =
    useNotifications();

  // The list is fetched when the bell opens, not on every page load — the
  // common case is a badge nobody clicks.
  useEffect(() => {
    if (open) void loadList();
  }, [open, loadList]);

  if (!user) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative flex h-9 w-9 items-center justify-center rounded-full text-ink-dim transition hover:bg-blush hover:text-gold-dim"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 01-3.46 0" />
        </svg>
        {/* aria-hidden: the count is already in the button's label above, so a
            screen reader would otherwise read the number twice. */}
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[10px] font-semibold text-paper"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-line bg-paper-card shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <p className="text-sm font-medium text-ink">Notifications</p>
            {unread > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="text-xs text-gold-dim underline"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loadingList && notifications === null ? (
              <p className="px-4 py-6 text-sm text-ink-dim">Loading…</p>
            ) : !notifications || notifications.length === 0 ? (
              <p className="px-4 py-6 text-sm text-ink-dim">
                Nothing yet. Sales, deliveries, and reviews land here.
              </p>
            ) : (
              <ul>
                {notifications.slice(0, 8).map((n) => {
                  const body = (
                    <>
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                          IS_BAD_NEWS[n.type]
                            ? "bg-clay/15 text-clay"
                            : "bg-gold/15 text-gold-dim"
                        }`}
                      >
                        {NOTIFICATION_ICON[n.type]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-ink">{n.title}</span>
                        {n.body && (
                          <span className="mt-0.5 block text-xs text-ink-dim">{n.body}</span>
                        )}
                        <span className="mt-1 block text-[11px] text-ink-dim">
                          {timeAgo(n.createdAt)}
                          {!n.read && " · new"}
                        </span>
                      </span>
                    </>
                  );

                  const classes = `flex w-full gap-3 border-b border-line px-4 py-3 text-left transition hover:bg-blush ${
                    n.read ? "" : "bg-gold/5"
                  }`;

                  // A notification about a deleted thing has no link. The
                  // sentence still stands on its own, which is why the text is
                  // written at creation rather than rendered from live rows.
                  return (
                    <li key={n.id}>
                      {n.link ? (
                        <Link
                          href={n.link}
                          onClick={() => {
                            if (!n.read) void markRead(n.id);
                            setOpen(false);
                          }}
                          className={classes}
                        >
                          {body}
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={() => !n.read && void markRead(n.id)}
                          className={classes}
                        >
                          {body}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <Link
            href="/account/notifications"
            onClick={() => setOpen(false)}
            className="block border-t border-line px-4 py-3 text-center text-sm text-gold-dim transition hover:bg-blush"
          >
            See all
          </Link>
        </div>
      )}
    </div>
  );
}
