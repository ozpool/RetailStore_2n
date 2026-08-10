"use client";

import { useEffect, useRef, useState } from "react";

export const MAX_PHOTOS = 8;
const MAX_BYTES = 8 * 1024 * 1024;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

/**
 * Collects photos *before* a listing exists.
 *
 * The upload API needs a listing id, so photos can't be sent until the listing
 * is created. Rather than making the seller save a draft and come back — which
 * reads as "there's no way to add photos" — files are held in browser memory
 * with local previews and uploaded immediately after creation.
 */
export default function PhotoPicker({
  files,
  onChange,
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);

  // Object URLs are revoked when the set changes, or the tab leaks memory.
  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  function add(picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    setError(null);

    const incoming = Array.from(picked);
    const room = MAX_PHOTOS - files.length;

    if (room <= 0) {
      setError(`You can add up to ${MAX_PHOTOS} photos.`);
      return;
    }

    const rejected: string[] = [];
    const accepted = incoming.filter((f) => {
      if (!ACCEPTED.includes(f.type)) {
        rejected.push(`${f.name} isn't a JPEG, PNG, or WebP`);
        return false;
      }
      if (f.size > MAX_BYTES) {
        rejected.push(`${f.name} is over 8MB`);
        return false;
      }
      return true;
    });

    if (rejected.length) setError(rejected.join(". "));
    if (accepted.length === 0) return;

    if (accepted.length > room) {
      setError(`Only the first ${room} of those fit — the limit is ${MAX_PHOTOS}.`);
    }

    onChange([...files, ...accepted.slice(0, room)]);
    if (input.current) input.current.value = "";
  }

  function remove(index: number) {
    setError(null);
    onChange(files.filter((_, i) => i !== index));
  }

  return (
    <div>
      {/* No heading here: this always sits inside a titled form section, and
          two "Photos" labels in a row is noise. */}
      <p className="text-xs text-ink-dim">
        Up to {MAX_PHOTOS} · JPEG, PNG, or WebP · max 8MB each · location data is
        stripped from every upload
      </p>

      {files.length > 0 && (
        <ul className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${file.lastModified}-${index}`}
              className="relative overflow-hidden rounded-2xl border border-line bg-paper-card"
            >
              <div className="relative aspect-square">
                {previews[index] && (
                  /* A blob: URL can't go through next/image, which only
                     optimises configured remote hosts. */
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={previews[index]}
                    alt={`Selected photo ${index + 1}`}
                    className="h-full w-full object-cover"
                  />
                )}
              </div>
              {index === 0 && (
                <span className="absolute top-1.5 left-1.5 rounded-full bg-paper/95 px-2 py-0.5 text-[10px] font-medium text-ink shadow-sm">
                  Cover
                </span>
              )}
              <button
                type="button"
                onClick={() => remove(index)}
                disabled={disabled}
                aria-label={`Remove photo ${index + 1}`}
                className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-paper/95 text-xs text-clay shadow-sm transition hover:bg-clay hover:text-paper disabled:opacity-50"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {files.length < MAX_PHOTOS && (
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={disabled}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line bg-paper px-4 py-6 text-sm font-medium text-ink-dim transition hover:border-gold/60 hover:text-gold-dim disabled:opacity-60"
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
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <circle cx="8.5" cy="10.5" r="1.5" />
            <path d="M21 15l-5-5-6 6" />
          </svg>
          {files.length === 0 ? "Add photos" : "Add more photos"}
        </button>
      )}

      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="hidden"
        onChange={(e) => add(e.target.files)}
      />

      {error && <p className="mt-2 text-xs text-clay">{error}</p>}
    </div>
  );
}
