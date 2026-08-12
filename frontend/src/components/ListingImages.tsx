"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  deleteListingImage,
  uploadListingImage,
  type SellerListingImage,
} from "@/lib/sellerApi";

const MAX_IMAGES = 8;

export default function ListingImages({
  listingId,
  images,
  onChange,
}: {
  listingId: string;
  images: SellerListingImage[];
  onChange: (images: SellerListingImage[]) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const { image } = await uploadListingImage(listingId, file);
      onChange([...images, image]);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't upload that photo. Try again."
      );
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function handleDelete(imageId: string) {
    setError(null);
    setBusy(true);
    try {
      await deleteListingImage(listingId, imageId);
      onChange(images.filter((img) => img.id !== imageId));
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Couldn't remove that photo. Try again."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-10">
      <h2 className="font-serif text-xl font-medium text-ink">Photos</h2>
      <p className="mt-1 text-sm text-ink-dim">
        First photo is the cover. Up to {MAX_IMAGES}. Location data is stripped from
        every upload.
      </p>

      {images.length > 0 && (
        <ul className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {images.map((image, index) => (
            <li
              key={image.id}
              className="relative overflow-hidden rounded-2xl border border-line bg-paper-card"
            >
              <div className="relative aspect-square">
                <Image
                  src={image.url}
                  alt={image.alt ?? "Listing photo"}
                  fill
                  sizes="(min-width: 640px) 25vw, 50vw"
                  className="object-cover"
                />
              </div>
              {index === 0 && (
                <span className="absolute top-2 left-2 rounded-full bg-paper/95 px-2 py-1 text-[11px] font-medium text-ink shadow-sm">
                  Cover
                </span>
              )}
              <button
                type="button"
                onClick={() => handleDelete(image.id)}
                disabled={busy}
                className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-paper/95 text-sm text-clay shadow-sm transition hover:bg-clay hover:text-paper disabled:opacity-50"
                aria-label="Remove photo"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {images.length < MAX_IMAGES && (
        <div className="mt-5">
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
            disabled={busy}
            className="block w-full max-w-md cursor-pointer rounded-xl border border-line bg-paper px-3 py-2.5 text-sm text-ink-dim file:mr-3 file:rounded-full file:border-0 file:bg-gold-dim file:px-4 file:py-1.5 file:text-sm file:font-semibold file:text-paper disabled:opacity-60"
          />
          <p className="mt-2 text-xs text-ink-dim">JPEG, PNG, or WebP. Max 8MB.</p>
        </div>
      )}

      {busy && <p className="mt-3 text-sm text-ink-dim">Working…</p>}
      {error && (
        <p className="mt-3 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      )}
    </section>
  );
}
