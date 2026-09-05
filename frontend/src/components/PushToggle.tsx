"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getPushDevices,
  getPushKey,
  pushSupported,
  subscribePush,
  unsubscribePush,
  urlBase64ToUint8Array,
  type PushDevice,
} from "@/lib/notificationsApi";

/**
 * Turning on browser notifications for this device.
 *
 * PERMISSION IS REQUESTED ON A CLICK, NEVER ON PAGE LOAD.
 * A prompt that appears unprompted is denied by reflex, and a denial is
 * effectively permanent — the browser will not ask again, and the user has to
 * find it in site settings to undo. Asking only after somebody presses a button
 * that says what it does is the difference between a feature and a dark
 * pattern, and it is also what keeps the grant rate from being terrible.
 *
 * PER DEVICE, NOT PER ACCOUNT. A subscription belongs to this browser profile.
 * Signing in on a laptop and a phone gives two, and this component only ever
 * speaks about the one it is running in.
 */

type State =
  | "checking"
  | "unsupported"
  | "unavailable"
  | "denied"
  | "off"
  | "on"
  | "working";

function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

export default function PushToggle() {
  const [state, setState] = useState<State>(() =>
    typeof window === "undefined"
      ? "checking"
      : pushSupported()
        ? "checking"
        : "unsupported"
  );
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [error, setError] = useState<string | null>(null);

  /**
   * Reads the world and RETURNS what it found. Sets no React state.
   *
   * Split that way on purpose: an effect whose job is to call a function that
   * writes state is the thing react-hooks/set-state-in-effect objects to, and
   * the objection is fair — it makes "what did we learn" and "what should the
   * component look like" the same step, so neither can be reused. Here the
   * effect and both button handlers share the reading, and each decides for
   * itself what to render.
   */
  const read = useCallback(async (): Promise<{ state: State; devices: PushDevice[] }> => {
    const key = await getPushKey();

    // A real answer, not an error: this server has no VAPID keys, so nobody can
    // subscribe. Saying so beats offering a button that fails.
    if (!key.enabled || !key.publicKey) return { state: "unavailable", devices: [] };

    if (Notification.permission === "denied") return { state: "denied", devices: [] };

    const registration = await navigator.serviceWorker.getRegistration("/sw.js");
    const existing = await registration?.pushManager.getSubscription();
    const list = await getPushDevices();

    return { state: existing ? "on" : "off", devices: list.devices };
  }, []);

  const refresh = useCallback(async () => {
    const result = await read();
    setState(result.state);
    setDevices(result.devices);
  }, [read]);

  useEffect(() => {
    // Nothing to ask the server about if the browser cannot do this at all.
    if (!pushSupported()) return;

    let live = true;
    read()
      .then((result) => {
        if (!live) return;
        setState(result.state);
        setDevices(result.devices);
      })
      .catch(() => {
        if (!live) return;
        setError("Couldn't check notification settings.");
        setState("off");
      });

    return () => {
      live = false;
    };
  }, [read]);

  async function enable() {
    setError(null);
    setState("working");

    try {
      const key = await getPushKey();
      if (!key.publicKey) {
        setState("unavailable");
        return;
      }

      // The prompt. This is the line that must only ever run from a click.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const sub = await registration.pushManager.subscribe({
        // Required, and the browser refuses without it: every message must be
        // visible to the user. No silent background pushes.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key.publicKey),
      });

      await subscribePush(sub.toJSON());
      await refresh();
    } catch {
      setError("Couldn't turn on notifications for this device.");
      setState("off");
    }
  }

  async function disable() {
    setError(null);
    setState("working");

    try {
      const registration = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await registration?.pushManager.getSubscription();

      if (sub) {
        // Server first. If the browser-side unsubscribe succeeded and the
        // server call then failed, we would keep sending to an endpoint that no
        // longer exists — harmless but permanently wasteful.
        await unsubscribePush(sub.endpoint);
        await sub.unsubscribe();
      }

      await refresh();
    } catch {
      setError("Couldn't turn off notifications for this device.");
      setState("on");
    }
  }

  return (
    <section className="rounded-xl border border-neutral-200 bg-white">
      <div className="border-b border-neutral-200 px-6 py-5">
        <h2 className="text-lg font-semibold tracking-tight">This device</h2>
        <p className="mt-1 text-sm text-neutral-600">
          Browser notifications, so you hear about a sale or a refund without
          having the tab open.
        </p>
      </div>

      <div className="px-6 py-5">
        {error && <p className="mb-4 text-sm text-red-700">{error}</p>}

        {state === "checking" && (
          <p className="text-sm text-neutral-500">Checking…</p>
        )}

        {state === "unsupported" && (
          <p className="text-sm text-neutral-600">
            This browser can&apos;t show notifications. On an iPhone or iPad,
            add RetailStore_2n to your home screen first — Safari only allows them
            there.
          </p>
        )}

        {state === "unavailable" && (
          <p className="text-sm text-neutral-600">
            Notifications aren&apos;t switched on for this site yet. Nothing you
            can do from here — it needs a server setting.
          </p>
        )}

        {state === "denied" && (
          <p className="text-sm text-neutral-600">
            You&apos;ve blocked notifications for this site. Your browser
            won&apos;t ask again, so you&apos;d need to allow them in its site
            settings — usually the icon at the left of the address bar.
          </p>
        )}

        {(state === "off" || state === "working") && (
          <button
            type="button"
            onClick={enable}
            disabled={state === "working"}
            className="rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:opacity-50"
          >
            {state === "working" ? "Just a moment…" : "Turn on for this device"}
          </button>
        )}

        {state === "on" && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 text-sm font-medium text-neutral-900">
              <span aria-hidden className="h-2 w-2 rounded-full bg-emerald-600" />
              On for this device
            </span>
            <button
              type="button"
              onClick={disable}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
            >
              Turn off
            </button>
          </div>
        )}

        {devices.length > 0 && (
          <div className="mt-5 border-t border-neutral-100 pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Devices receiving notifications
            </p>
            <ul className="mt-2 space-y-1 text-sm text-neutral-600">
              {devices.map((d) => (
                <li key={d.id}>
                  {deviceLabel(d.userAgent)}
                  <span className="text-neutral-400">
                    {" · added "}
                    {new Date(d.createdAt).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
