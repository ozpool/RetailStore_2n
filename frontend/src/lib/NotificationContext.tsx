"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAuth } from "@/lib/AuthContext";
import {
  getNotifications,
  getUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  type Notification,
} from "@/lib/notificationsApi";

/**
 * The unread count, and the list behind it.
 *
 * WHY POLLING AND NOT A SOCKET
 * A WebSocket would deliver these instantly and cost a connection per open tab,
 * a reconnect strategy, and a second thing to keep alive in production. Nothing
 * here is urgent — "your item sold" is not a chat message — so a poll on a
 * relaxed interval is the right trade. The poll is also paused when the tab is
 * hidden, because there is nobody to see the badge move.
 *
 * The interval only fetches the COUNT. The list itself is loaded when someone
 * opens the bell, so the common case is one small request rather than fifty
 * rows of text nobody is reading.
 */

const POLL_MS = 60_000;

type NotificationContextValue = {
  unread: number;
  notifications: Notification[] | null;
  loadingList: boolean;
  /** Fetches the list. Called when the bell opens. */
  loadList: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  refreshCount: () => Promise<void>;
};

const NotificationContext = createContext<NotificationContextValue | null>(null);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [unread, setUnread] = useState(0);
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [loadingList, setLoadingList] = useState(false);

  // Keyed on the id: AuthContext hands back a fresh user object on every
  // revalidation, and depending on the object would restart the poll each time.
  const userId = user?.id ?? null;

  const refreshCount = useCallback(async () => {
    if (!userId) {
      setUnread(0);
      return;
    }
    try {
      const { unread } = await getUnreadCount();
      setUnread(unread);
    } catch {
      // A failed count must not break the nav. Leaving the previous number is
      // better than showing a wrong one or an error where a badge should be.
    }
  }, [userId]);

  const loadList = useCallback(async () => {
    if (!userId) return;
    setLoadingList(true);
    try {
      const data = await getNotifications({ limit: 30 });
      setNotifications(data.notifications);
      setUnread(data.unread);
    } catch {
      setNotifications([]);
    } finally {
      setLoadingList(false);
    }
  }, [userId]);

  useEffect(() => {
    if (authLoading) return;
    void refreshCount();
  }, [authLoading, refreshCount]);

  /** Polls only while signed in and only while the tab is visible. */
  useEffect(() => {
    if (!userId) return;

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshCount();
    }, POLL_MS);

    // Coming back to a tab that has been hidden for an hour should not wait a
    // further minute for the badge to catch up.
    function onVisible() {
      if (document.visibilityState === "visible") void refreshCount();
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId, refreshCount]);

  const markRead = useCallback(async (id: string) => {
    // Optimistic: the badge should move the instant something is opened.
    setNotifications((current) =>
      current ? current.map((n) => (n.id === id ? { ...n, read: true } : n)) : current
    );
    setUnread((n) => Math.max(0, n - 1));
    try {
      const { unread } = await markNotificationRead(id);
      setUnread(unread);
    } catch {
      void refreshCount();
    }
  }, [refreshCount]);

  const markAllRead = useCallback(async () => {
    setNotifications((current) => current?.map((n) => ({ ...n, read: true })) ?? current);
    setUnread(0);
    try {
      await markAllNotificationsRead();
    } catch {
      void refreshCount();
    }
  }, [refreshCount]);

  const value = useMemo<NotificationContextValue>(
    () => ({ unread, notifications, loadingList, loadList, markRead, markAllRead, refreshCount }),
    [unread, notifications, loadingList, loadList, markRead, markAllRead, refreshCount]
  );

  return (
    <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used inside a NotificationProvider");
  return ctx;
}
