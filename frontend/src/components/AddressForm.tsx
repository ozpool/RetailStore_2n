"use client";

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { COUNTRIES, type Address, type AddressInput } from "@/lib/addressesApi";

const field =
  "mt-1.5 w-full rounded border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none transition placeholder:text-ink-dim/60 focus:border-gold/50 disabled:opacity-60";
const label = "block text-xs font-medium text-ink-dim";

/**
 * Adding or editing a delivery address.
 *
 * DELIBERATELY LOOSE VALIDATION
 * Only the fields that genuinely cannot be empty are required. Address formats
 * differ enough between countries that strict rules reject more real addresses
 * than they catch bad ones — a UK postcode, an Irish Eircode with no numeric
 * part, and a Hong Kong address with no postcode at all are all legitimate.
 * The one thing checked properly is the country, because it's a fixed list.
 */
export default function AddressForm({
  initial,
  submitLabel = "Save address",
  onSubmit,
  onCancel,
  showDefaultToggle = true,
}: {
  initial?: Address | null;
  submitLabel?: string;
  onSubmit: (input: AddressInput) => Promise<void>;
  onCancel?: () => void;
  showDefaultToggle?: boolean;
}) {
  const [form, setForm] = useState<AddressInput>({
    fullName: initial?.fullName ?? "",
    line1: initial?.line1 ?? "",
    line2: initial?.line2 ?? "",
    city: initial?.city ?? "",
    region: initial?.region ?? "",
    postcode: initial?.postcode ?? "",
    country: initial?.country ?? "GB",
    phone: initial?.phone ?? "",
    isDefault: initial?.isDefault ?? false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [badField, setBadField] = useState<string | null>(null);

  function set<K extends keyof AddressInput>(key: K, value: AddressInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (badField === key) setBadField(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBadField(null);
    setBusy(true);
    try {
      await onSubmit(form);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setBadField(err.field ?? null);
      } else {
        setError("Couldn't save that address.");
      }
    } finally {
      setBusy(false);
    }
  }

  const invalid = (name: string) => (badField === name ? "border-clay" : "");

  return (
    <form onSubmit={submit} className="rounded-2xl border border-line bg-paper-card p-6">
      {error && (
        <p className="mb-5 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="fullName" className={label}>
            Full name
          </label>
          <input
            id="fullName"
            value={form.fullName}
            onChange={(e) => set("fullName", e.target.value)}
            disabled={busy}
            autoComplete="name"
            placeholder="Who should it be addressed to?"
            className={`${field} ${invalid("fullName")}`}
          />
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="line1" className={label}>
            Street address
          </label>
          <input
            id="line1"
            value={form.line1}
            onChange={(e) => set("line1", e.target.value)}
            disabled={busy}
            autoComplete="address-line1"
            placeholder="12 Kiln Lane"
            className={`${field} ${invalid("line1")}`}
          />
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="line2" className={label}>
            Flat, unit, building <span className="font-normal">— optional</span>
          </label>
          <input
            id="line2"
            value={form.line2 ?? ""}
            onChange={(e) => set("line2", e.target.value)}
            disabled={busy}
            autoComplete="address-line2"
            className={field}
          />
        </div>

        <div>
          <label htmlFor="city" className={label}>
            City or town
          </label>
          <input
            id="city"
            value={form.city}
            onChange={(e) => set("city", e.target.value)}
            disabled={busy}
            autoComplete="address-level2"
            className={`${field} ${invalid("city")}`}
          />
        </div>

        <div>
          <label htmlFor="region" className={label}>
            County or state <span className="font-normal">— optional</span>
          </label>
          <input
            id="region"
            value={form.region ?? ""}
            onChange={(e) => set("region", e.target.value)}
            disabled={busy}
            autoComplete="address-level1"
            className={field}
          />
        </div>

        <div>
          <label htmlFor="postcode" className={label}>
            Postcode or ZIP
          </label>
          <input
            id="postcode"
            value={form.postcode}
            onChange={(e) => set("postcode", e.target.value)}
            disabled={busy}
            autoComplete="postal-code"
            className={`${field} ${invalid("postcode")}`}
          />
        </div>

        <div>
          <label htmlFor="country" className={label}>
            Country
          </label>
          <select
            id="country"
            value={form.country}
            onChange={(e) => set("country", e.target.value)}
            disabled={busy}
            autoComplete="country"
            className={`${field} ${invalid("country")}`}
          >
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-2">
          <label htmlFor="phone" className={label}>
            Phone <span className="font-normal">— optional, for the courier</span>
          </label>
          <input
            id="phone"
            value={form.phone ?? ""}
            onChange={(e) => set("phone", e.target.value)}
            disabled={busy}
            autoComplete="tel"
            className={field}
          />
        </div>
      </div>

      {showDefaultToggle && (
        <label className="mt-5 flex items-center gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            checked={form.isDefault ?? false}
            onChange={(e) => set("isDefault", e.target.checked)}
            disabled={busy}
            className="h-4 w-4 accent-gold-dim"
          />
          Use this as my default delivery address
        </label>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-line px-5 py-2.5 text-sm text-ink transition hover:border-gold/40 disabled:opacity-60"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
