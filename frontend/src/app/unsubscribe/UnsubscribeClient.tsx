"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  CHANNEL_LABEL,
  NOTIFICATION_LABEL,
  confirmUnsubscribe,
  inspectUnsubscribe,
  type DeliveryChannel,
  type NotificationType,
} from "@/lib/notificationsApi";

/**
 * The page an unsubscribe link lands on.
 *
 * IT ASKS BEFORE IT ACTS, and that is not politeness.
 * Mail scanners, link checkers and browser prefetchers fetch every URL in a
 * message. A page that unsubscribed on load would silently opt people out of
 * mail they never chose to leave, and the first anyone would know is somebody
 * asking why they stopped hearing about their orders. So the load is a GET that
 * only describes the token, and the change is a POST behind a button.
 *
 * NO SIGN-IN. The reader is in their inbox, possibly years later, possibly on a
 * device that was never signed in. An unsubscribe that asks for a password is
 * one people replace with the spam button.
 */

type State =
  | { kind: "loading" }
  | { kind: "invalid" }
  | {
      kind: "ready";
      channel: DeliveryChannel;
      scope: NotificationType | "all";
      email: string;
      alwaysSent: NotificationType[];
    }
  | { kind: "done"; turnedOff: number; refused: boolean }
  | { kind: "error"; message: string };

export default function UnsubscribeClient() {
  const token = useSearchParams().get("token") ?? "";

  // Derived at first render, not set from inside the effect: a missing token is
  // knowable without asking the server, and an effect that sets state on mount
  // renders "loading" for a frame it has no reason to.
  const [state, setState] = useState<State>(() =>
    token ? { kind: "loading" } : { kind: "invalid" }
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let live = true;
    inspectUnsubscribe(token)
      .then((d) => live && setState({ kind: "ready", ...d }))
      .catch(() => live && setState({ kind: "invalid" }));
    return () => {
      live = false;
    };
  }, [token]);

  async function confirm() {
    setBusy(true);
    try {
      const result = await confirmUnsubscribe(token);
      setState({
        kind: "done",
        turnedOff: result.turnedOff,
        refused: result.refused === true,
      });
    } catch {
      setState({ kind: "error", message: "That didn't work. Try the link again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md px-6 py-20">
      <p className="mb-8 text-lg font-semibold tracking-tight">RetailStore_2n</p>

      {state.kind === "loading" && (
        <p className="text-sm text-neutral-500">Checking that link…</p>
      )}

      {state.kind === "invalid" && (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">
            That link doesn&apos;t work
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-neutral-600">
            It may have been cut short by your email client — those links are
            long and some programs break them across lines. Nothing has changed.
          </p>
          <p className="mt-6 text-sm text-neutral-600">
            You can change everything from{" "}
            <Link href="/account/notifications" className="underline">
              your notification settings
            </Link>{" "}
            instead.
          </p>
        </>
      )}

      {state.kind === "ready" && (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">
            {state.scope === "all"
              ? "Stop optional emails?"
              : "Stop these emails?"}
          </h1>

          <p className="mt-3 text-sm leading-relaxed text-neutral-600">
            {state.scope === "all" ? (
              <>
                We&apos;ll stop sending optional {CHANNEL_LABEL[state.channel].toLowerCase()} to{" "}
                <span className="font-medium text-neutral-900">{state.email}</span>.
              </>
            ) : (
              <>
                We&apos;ll stop emailing{" "}
                <span className="font-medium text-neutral-900">{state.email}</span>{" "}
                when:{" "}
                <span className="font-medium text-neutral-900">
                  {NOTIFICATION_LABEL[state.scope] ?? state.scope}
                </span>
                .
              </>
            )}
          </p>

          {/* Said plainly and up front, because the alternative is somebody
              unsubscribing and then not hearing that their money came back. */}
          <div className="mt-5 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
            <p className="text-sm font-medium text-neutral-900">
              You&apos;ll still be emailed about money
            </p>
            <ul className="mt-2 space-y-1 text-sm text-neutral-600">
              {state.alwaysSent.map((type) => (
                <li key={type}>· {NOTIFICATION_LABEL[type] ?? type}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs leading-relaxed text-neutral-500">
              These affect an order you paid for, so they aren&apos;t optional.
            </p>
          </div>

          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="mt-6 w-full rounded-lg bg-neutral-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Yes, stop these emails"}
          </button>

          <p className="mt-4 text-center text-sm text-neutral-500">
            Changed your mind?{" "}
            <Link href="/account/notifications" className="underline">
              Leave everything as it is
            </Link>
          </p>
        </>
      )}

      {state.kind === "done" && (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Done</h1>
          <p className="mt-3 text-sm leading-relaxed text-neutral-600">
            {state.refused
              ? "That one is about money for an order you paid for, so it stays on. Nothing else changed."
              : state.turnedOff === 1
                ? "We won't email you about that again."
                : `We've turned off ${state.turnedOff} kinds of email.`}
          </p>
          <p className="mt-6 text-sm text-neutral-600">
            You can turn any of it back on in{" "}
            <Link href="/account/notifications" className="underline">
              your notification settings
            </Link>
            .
          </p>
        </>
      )}

      {state.kind === "error" && (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Something broke</h1>
          <p className="mt-3 text-sm leading-relaxed text-neutral-600">
            {state.message} Nothing has changed.
          </p>
        </>
      )}
    </div>
  );
}
