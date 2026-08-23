"use client";

import { useRef, useState } from "react";
import Avatar from "@/components/Avatar";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import type { User } from "@/lib/api";

export default function AvatarUploader({ user }: { user: User }) {
  const { setAvatar, clearAvatar } = useAuth();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: "upload" | "remove", action: () => Promise<void>) {
    setError(null);
    setBusy(kind);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-5">
      <Avatar name={user.name} src={user.avatarUrl} size={72} />

      <div>
        <p className="text-sm font-medium text-ink">Profile picture</p>
        <p className="mt-0.5 text-xs text-ink-dim">
          JPEG, PNG, or WebP. Max 5MB. Cropped to a square, and location data is
          stripped before it&apos;s stored.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy !== null}
            className="rounded-full border border-line px-4 py-1.5 text-sm font-medium text-ink transition hover:border-gold/50 hover:text-gold-dim disabled:opacity-60"
          >
            {busy === "upload"
              ? "Uploading…"
              : user.avatarUrl
                ? "Change picture"
                : "Upload a picture"}
          </button>

          {user.avatarUrl && (
            <button
              type="button"
              onClick={() => run("remove", clearAvatar)}
              disabled={busy !== null}
              className="rounded-full border border-clay/30 px-4 py-1.5 text-sm text-clay transition hover:bg-clay hover:text-paper disabled:opacity-60"
            >
              {busy === "remove" ? "Removing…" : "Remove"}
            </button>
          )}
        </div>

        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) run("upload", () => setAvatar(file));
          }}
        />

        {error && <p className="mt-2 text-sm text-clay">{error}</p>}
      </div>
    </div>
  );
}
