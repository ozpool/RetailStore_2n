"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import ListingPreview from "@/components/ListingPreview";
import PhotoPicker from "@/components/PhotoPicker";
import { ApiError } from "@/lib/api";
import { CONDITION_OPTIONS, type CatalogCategory } from "@/lib/catalog";
import {
  centsToDollars,
  dollarsToCents,
  type ListingInput,
  type SellerListing,
} from "@/lib/sellerApi";

const inputClass =
  "mt-1.5 w-full rounded-xl border border-line bg-paper px-3.5 py-2.5 text-sm text-ink outline-none transition focus:border-gold focus:bg-paper-card";
const labelClass = "text-sm font-medium text-ink";
const hintClass = "mt-0.5 text-xs text-ink-dim";
const errorClass = "mt-1.5 text-xs text-clay";

/** One titled card in the form, with a coloured icon so sections are scannable. */
function Section({
  step,
  title,
  hint,
  tint,
  icon,
  children,
}: {
  step: number;
  title: string;
  hint: string;
  tint: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-line bg-paper-card p-6">
      <div className="flex items-start gap-4">
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${tint}`}
          aria-hidden="true"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-ink-dim">Step {step}</span>
          </div>
          <h2 className="font-serif text-lg font-medium text-ink">{title}</h2>
          <p className={hintClass}>{hint}</p>
        </div>
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}

const icon = (path: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    className="h-5 w-5"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {path}
  </svg>
);

/** What each condition actually signals to a buyer, in the seller's terms. */
const CONDITION_BLURB: Record<string, string> = {
  LIKE_NEW: "Barely used. No marks worth mentioning.",
  GOOD: "Used, sound, a few honest signs of life.",
  WELL_LOVED: "Clearly lived with. Character over polish.",
  NEEDS_REPAIR: "Sold as-is. Say what needs doing.",
};

export default function ListingForm({
  initial,
  submitLabel,
  onSubmit,
  collectPhotos = false,
  progress,
}: {
  initial?: SellerListing;
  submitLabel: string;
  onSubmit: (input: ListingInput, photos: File[]) => Promise<void>;
  collectPhotos?: boolean;
  progress?: string | null;
}) {
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [categoryId, setCategoryId] = useState(initial?.category.id ?? "");
  const [condition, setCondition] = useState(initial?.condition ?? "GOOD");
  const [conditionNote, setConditionNote] = useState(initial?.conditionNote ?? "");
  const [price, setPrice] = useState(centsToDollars(initial?.priceCents ?? null));
  const [originalPrice, setOriginalPrice] = useState(
    centsToDollars(initial?.originalPriceCents ?? null)
  );
  const [quantity, setQuantity] = useState(String(initial?.quantity ?? 1));
  const [photos, setPhotos] = useState<File[]>([]);

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/catalog/categories")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (cancelled) return;
        setCategories(data.categories ?? []);
        if (!initial && data.categories?.length) {
          setCategoryId((current: string) => current || data.categories[0].id);
        }
      })
      .catch(() => {
        if (!cancelled) setFormError("Couldn't load categories. Reload and try again.");
      });

    return () => {
      cancelled = true;
    };
  }, [initial]);

  // Local preview URL for the first photo, revoked when the selection changes.
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  useEffect(() => {
    if (photos.length === 0) {
      setCoverUrl(initial?.images[0]?.url ?? null);
      return;
    }
    const url = URL.createObjectURL(photos[0]);
    setCoverUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photos, initial]);

  const previewCategory = useMemo(
    () => categories.find((c) => c.id === categoryId)?.title ?? null,
    [categories, categoryId]
  );

  function errorFor(field: string) {
    return fieldError?.field === field ? fieldError.message : null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFieldError(null);

    const priceCents = dollarsToCents(price);
    if (priceCents === null || priceCents < 1) {
      setFieldError({ field: "priceCents", message: "Enter a price." });
      return;
    }

    const originalCents = originalPrice.trim() ? dollarsToCents(originalPrice) : null;
    if (originalPrice.trim() && originalCents === null) {
      setFieldError({ field: "originalPriceCents", message: "That isn't a valid amount." });
      return;
    }
    if (originalCents !== null && originalCents <= priceCents) {
      setFieldError({
        field: "originalPriceCents",
        message: "The original price has to be higher than the current one.",
      });
      return;
    }

    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      setFieldError({ field: "quantity", message: "Quantity must be at least 1." });
      return;
    }

    setSaving(true);
    try {
      await onSubmit(
        {
          title: title.trim(),
          description: description.trim(),
          categoryId,
          condition,
          conditionNote: conditionNote.trim() || null,
          priceCents,
          originalPriceCents: originalCents,
          quantity: qty,
        },
        photos
      );
    } catch (err) {
      if (err instanceof ApiError && err.field) {
        setFieldError({ field: err.field, message: err.message });
      } else if (err instanceof ApiError) {
        setFormError(err.message);
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  const conditionLabel =
    CONDITION_OPTIONS.find((c) => c.value === condition)?.label ?? "";
  let step = collectPhotos ? 2 : 1;

  return (
    <form onSubmit={handleSubmit} className="mt-8" noValidate>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ---------------- fields ---------------- */}
        <div className="grid gap-5">
          {collectPhotos && (
            <Section
              step={1}
              title="Photos"
              hint="The first one becomes the cover. Good light beats a good camera."
              tint="bg-blush text-gold-dim"
              icon={icon(
                <>
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <circle cx="8.5" cy="10.5" r="1.5" />
                  <path d="M21 15l-5-5-6 6" />
                </>
              )}
            >
              <PhotoPicker files={photos} onChange={setPhotos} disabled={saving} />
            </Section>
          )}

          <Section
            step={step++}
            title="What is it?"
            hint="Say what's wrong with it as well as what's right. Buyers here expect that."
            tint="bg-sand text-ink"
            icon={icon(
              <>
                <path d="M4 7h16M4 12h16M4 17h10" />
              </>
            )}
          >
            <div className="grid gap-5">
              <div>
                <label htmlFor="title" className={labelClass}>
                  Title
                </label>
                <input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Walnut side table"
                  maxLength={120}
                  className={inputClass}
                />
                <p className={hintClass}>{title.length}/120</p>
                {errorFor("title") && <p className={errorClass}>{errorFor("title")}</p>}
              </div>

              <div>
                <label htmlFor="description" className={labelClass}>
                  Description
                </label>
                <textarea
                  id="description"
                  rows={5}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Solid walnut, one water ring on the top that I haven't sanded out…"
                  className={inputClass}
                />
                {errorFor("description") && (
                  <p className={errorClass}>{errorFor("description")}</p>
                )}
              </div>

              <div>
                <label htmlFor="categoryId" className={labelClass}>
                  Category
                </label>
                <select
                  id="categoryId"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className={inputClass}
                >
                  {categories.length === 0 && <option value="">Loading…</option>}
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
                {errorFor("categoryId") && (
                  <p className={errorClass}>{errorFor("categoryId")}</p>
                )}
              </div>
            </div>
          </Section>

          <Section
            step={step++}
            title="What condition?"
            hint="Pick the honest one. Overstating it is how returns happen."
            tint="bg-butter text-ink"
            icon={icon(
              <>
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="M9 12l2 2 4-4" />
              </>
            )}
          >
            {/* Real radios behind card-styled labels: keyboard and screen-reader
                behaviour comes free, and the visuals are just CSS. */}
            <fieldset>
              <legend className="sr-only">Condition</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {CONDITION_OPTIONS.map((option) => {
                  const active = condition === option.value;
                  return (
                    <label
                      key={option.value}
                      htmlFor={`condition-${option.value}`}
                      // The radio itself is visually hidden, so the focus ring
                      // has to be drawn on the card or keyboard users can't see
                      // where they are.
                      className={`block cursor-pointer rounded-2xl border p-4 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gold has-[:focus-visible]:ring-offset-2 ${
                        active
                          ? "border-gold bg-gold/10 shadow-sm"
                          : "border-line bg-paper hover:border-gold/40"
                      }`}
                    >
                      <input
                        type="radio"
                        id={`condition-${option.value}`}
                        name="condition"
                        value={option.value}
                        checked={active}
                        onChange={() => setCondition(option.value)}
                        className="sr-only"
                      />
                      <span className="flex items-center justify-between">
                        <span
                          className={`text-sm font-semibold ${
                            active ? "text-gold-dim" : "text-ink"
                          }`}
                        >
                          {option.label}
                        </span>
                        {active && (
                          <span className="text-gold-dim" aria-hidden="true">
                            ✓
                          </span>
                        )}
                      </span>
                      <span className="mt-1 block text-xs text-ink-dim">
                        {CONDITION_BLURB[option.value]}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="mt-5">
              <label htmlFor="conditionNote" className={labelClass}>
                In your words <span className="font-normal text-ink-dim">(optional)</span>
              </label>
              <input
                id="conditionNote"
                value={conditionNote}
                onChange={(e) => setConditionNote(e.target.value)}
                maxLength={60}
                placeholder="Needs a tune-up"
                className={inputClass}
              />
              <p className={hintClass}>
                Shown as the badge on your card. Overrides the label above.
              </p>
              {errorFor("conditionNote") && (
                <p className={errorClass}>{errorFor("conditionNote")}</p>
              )}
            </div>
          </Section>

          <Section
            step={step++}
            title="How much?"
            hint="A 'was' price shows buyers a discount badge. Leave it blank if there isn't one."
            tint="bg-lavender-tint text-ink"
            icon={icon(
              <>
                <path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0l-7.2-7.2A2 2 0 013 12V5a2 2 0 012-2h7a2 2 0 011.4.6l7.2 7.2a2 2 0 010 2.6z" />
                <circle cx="7.5" cy="7.5" r="1.5" />
              </>
            )}
          >
            <div className="grid gap-5 sm:grid-cols-3">
              <div>
                <label htmlFor="price" className={labelClass}>
                  Price
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-3.5 mt-0.5 -translate-y-1/2 text-sm text-ink-dim">
                    $
                  </span>
                  <input
                    id="price"
                    type="number"
                    min="0"
                    step="0.01"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    placeholder="0.00"
                    className={`${inputClass} pl-7`}
                  />
                </div>
                {errorFor("priceCents") && (
                  <p className={errorClass}>{errorFor("priceCents")}</p>
                )}
              </div>

              <div>
                <label htmlFor="originalPrice" className={labelClass}>
                  Was <span className="font-normal text-ink-dim">(optional)</span>
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-3.5 mt-0.5 -translate-y-1/2 text-sm text-ink-dim">
                    $
                  </span>
                  <input
                    id="originalPrice"
                    type="number"
                    min="0"
                    step="0.01"
                    value={originalPrice}
                    onChange={(e) => setOriginalPrice(e.target.value)}
                    placeholder="0.00"
                    className={`${inputClass} pl-7`}
                  />
                </div>
                {errorFor("originalPriceCents") && (
                  <p className={errorClass}>{errorFor("originalPriceCents")}</p>
                )}
              </div>

              <div>
                <label htmlFor="quantity" className={labelClass}>
                  Quantity
                </label>
                <input
                  id="quantity"
                  type="number"
                  min="1"
                  step="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className={inputClass}
                />
                <p className={hintClass}>1 for one-of-a-kind.</p>
                {errorFor("quantity") && (
                  <p className={errorClass}>{errorFor("quantity")}</p>
                )}
              </div>
            </div>
          </Section>

          {formError && (
            <p className="rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
              {formError}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <button
              type="submit"
              disabled={saving}
              className="seam-glow rounded-full bg-gold-dim px-6 py-3 text-sm font-semibold text-paper transition hover:brightness-90 disabled:opacity-60"
            >
              {saving ? "Saving…" : submitLabel}
            </button>
            {progress && <span className="text-sm text-ink-dim">{progress}</span>}
          </div>
        </div>

        {/* ---------------- live preview ---------------- */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <p className="text-xs font-semibold tracking-wide text-ink-dim uppercase">
            How buyers will see it
          </p>
          <div className="mt-3">
            <ListingPreview
              title={title}
              priceCents={dollarsToCents(price)}
              originalPriceCents={originalPrice.trim() ? dollarsToCents(originalPrice) : null}
              conditionNote={conditionNote}
              conditionLabel={conditionLabel}
              quantity={Math.max(1, Number(quantity) || 1)}
              imageUrl={coverUrl}
              categoryTitle={previewCategory}
            />
          </div>
          <p className="mt-3 text-xs text-ink-dim">
            Updates as you type. Ratings appear once buyers leave them.
          </p>
        </aside>
      </div>
    </form>
  );
}
