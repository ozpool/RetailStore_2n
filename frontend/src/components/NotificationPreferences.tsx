"use client";

import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  CHANNEL_LABEL,
  NOTIFICATION_LABEL,
  getPreferences,
  setPreference,
  type DeliveryChannel,
  type NotificationType,
  type TypePreference,
} from "@/lib/notificationsApi";

/**
 * How you are told, per thing that can happen.
 *
 * WHY IN-APP IS NOT A COLUMN
 * The notification list itself is the record, not a delivery — it is written
 * whatever these switches say, which is what keeps "what happened to my order"
 * answerable independently of who was told how. Offering a switch that turned
 * it off would be offering to delete your own history.
 *
 * WHY SOME ROWS HAVE FEWER SWITCHES
 * A channel a type is never sent on is not shown. A switch that does nothing is
 * worse than no switch: it makes people believe they have turned something on.
 */
export default function NotificationPreferences() {
  const [prefs, setPrefs] = useState<TypePreference[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getPreferences()
      .then((d) => live && setPrefs(d.preferences))
      .catch((err) => {
        if (!live) return;
        setError(
          err instanceof ApiError ? err.message : "Couldn't load your settings."
        );
        setPrefs([]);
      });
    return () => {
      live = false;
    };
  }, []);

  async function toggle(type: NotificationType, channel: DeliveryChannel, next: boolean) {
    const key = `${type}:${channel}`;
    setBusy(key);
    setError(null);

    // Optimistic: a switch that waits for a round trip before moving feels
    // broken, and the failure path below puts it back.
    setPrefs((current) =>
      current?.map((row) =>
        row.type !== type
          ? row
          : {
              ...row,
              channels: row.channels.map((c) =>
                c.channel === channel ? { ...c, enabled: next, isDefault: false } : c
              ),
            }
      ) ?? null
    );

    try {
      const data = await setPreference({ type, channel, enabled: next });
      setPrefs(data.preferences);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't save that. Try again."
      );
      const fresh = await getPreferences().catch(() => null);
      if (fresh) setPrefs(fresh.preferences);
    } finally {
      setBusy(null);
    }
  }

  if (prefs === null) {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-6">
        <p className="text-sm text-neutral-500">Loading your settings…</p>
      </div>
    );
  }

  const channels: DeliveryChannel[] = ["EMAIL", "PUSH", "SMS"];

  return (
    <section className="rounded-xl border border-neutral-200 bg-white">
      <div className="border-b border-neutral-200 px-6 py-5">
        <h2 className="text-lg font-semibold tracking-tight">How you&apos;re told</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Everything below always appears in this list. These control what else
          we send you.
        </p>
      </div>

      {error && (
        <p className="border-b border-red-100 bg-red-50 px-6 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left">
              <th className="px-6 py-3 font-medium text-neutral-500">
                When this happens
              </th>
              {channels.map((c) => (
                <th
                  key={c}
                  className="w-24 px-3 py-3 text-center font-medium text-neutral-500"
                >
                  {CHANNEL_LABEL[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {prefs.map((row) => (
              <tr key={row.type} className="border-b border-neutral-100 last:border-0">
                <td className="px-6 py-3.5 text-neutral-900">
                  {NOTIFICATION_LABEL[row.type] ?? row.type}
                </td>
                {channels.map((channel) => {
                  const pref = row.channels.find((c) => c.channel === channel);
                  const key = `${row.type}:${channel}`;

                  if (!pref) {
                    return (
                      <td
                        key={channel}
                        className="px-3 py-3.5 text-center text-neutral-300"
                        // Not "off" — this channel is never used for this event,
                        // which is a different statement from "you turned it off".
                        title={`We don't send this by ${CHANNEL_LABEL[channel].toLowerCase()}`}
                      >
                        —
                      </td>
                    );
                  }

                  return (
                    <td key={channel} className="px-3 py-3.5 text-center">
                      <label className="inline-flex cursor-pointer items-center justify-center">
                        <span className="sr-only">
                          {CHANNEL_LABEL[channel]} for{" "}
                          {NOTIFICATION_LABEL[row.type] ?? row.type}
                        </span>
                        <input
                          type="checkbox"
                          checked={pref.enabled}
                          disabled={busy === key}
                          onChange={(e) => toggle(row.type, channel, e.target.checked)}
                          className="h-4 w-4 cursor-pointer rounded border-neutral-300 text-neutral-900 focus:ring-2 focus:ring-neutral-900 focus:ring-offset-1 disabled:opacity-40"
                        />
                      </label>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="border-t border-neutral-200 px-6 py-4 text-xs leading-relaxed text-neutral-500">
        Text messages need a verified phone number, which isn&apos;t built yet —
        those switches save your choice and nothing is sent.
      </p>
    </section>
  );
}
