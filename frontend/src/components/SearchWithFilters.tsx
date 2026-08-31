"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CONDITION_OPTIONS, type CatalogCategory } from "@/lib/catalog";
import { useDismissable } from "@/lib/useDismissable";

export default function SearchWithFilters() {
  const router = useRouter();
  const { open, setOpen, ref } = useDismissable<HTMLDivElement>();

  const [term, setTerm] = useState("");
  const [category, setCategory] = useState("");
  const [condition, setCondition] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");

  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Loaded the first time the panel opens rather than on every page view — the
  // dropdown is the only thing that needs it.
  useEffect(() => {
    if (!open || categories.length > 0) return;

    let cancelled = false;
    fetch("/api/catalog/categories")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (!cancelled) setCategories(data.categories ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load categories.");
      });

    return () => {
      cancelled = true;
    };
  }, [open, categories.length]);

  const activeCount = [category, condition, minPrice, maxPrice].filter(Boolean).length;

  function handleClear() {
    setCategory("");
    setCondition("");
    setMinPrice("");
    setMaxPrice("");
  }

  function submit() {
    const params = new URLSearchParams();
    if (term.trim()) params.set("q", term.trim());
    if (category) params.set("category", category);
    if (condition) params.set("condition", condition);
    if (minPrice) params.set("minPrice", minPrice);
    if (maxPrice) params.set("maxPrice", maxPrice);

    setOpen(false);
    router.push(`/search${params.toString() ? `?${params}` : ""}`);
  }

  return (
    <div ref={ref} className="relative w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-center gap-2"
      >
        <div className="relative flex-1">
          <svg
            viewBox="0 0 24 24"
            className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-ink-dim"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search for furniture, jackets, records…"
            aria-label="Search listings"
            className="w-full rounded-full border border-line bg-paper-card py-2.5 pl-10 pr-4 text-sm text-ink outline-none placeholder:text-ink-dim/70 focus:border-gold"
          />
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="true"
          aria-expanded={open}
          className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-2.5 text-sm font-medium transition ${
            open || activeCount > 0
              ? "border-gold bg-gold/10 text-gold-dim"
              : "border-line text-ink-dim hover:border-gold/50 hover:text-gold-dim"
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 6h16M7 12h10M10 18h4" />
          </svg>
          Filters
          {activeCount > 0 && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-gold-dim text-[10px] font-semibold text-paper">
              {activeCount}
            </span>
          )}
        </button>
      </form>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-full min-w-72 rounded-2xl border border-line bg-paper-card p-4 shadow-lg sm:w-96">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="filter-category" className="text-xs font-medium text-ink-dim">
                Category
              </label>
              <select
                id="filter-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-gold"
              >
                <option value="">All categories</option>
                {categories.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.title}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="filter-condition" className="text-xs font-medium text-ink-dim">
                Condition
              </label>
              <select
                id="filter-condition"
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
                className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-gold"
              >
                <option value="">Any condition</option>
                {CONDITION_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="filter-min" className="text-xs font-medium text-ink-dim">
                Min price
              </label>
              <input
                id="filter-min"
                type="number"
                min="0"
                value={minPrice}
                onChange={(e) => setMinPrice(e.target.value)}
                placeholder="$0"
                className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-gold"
              />
            </div>

            <div>
              <label htmlFor="filter-max" className="text-xs font-medium text-ink-dim">
                Max price
              </label>
              <input
                id="filter-max"
                type="number"
                min="0"
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
                placeholder="Any"
                className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-gold"
              />
            </div>
          </div>

          {error && <p className="mt-3 text-xs text-clay">{error}</p>}

          <div className="mt-4 flex items-center justify-between">
            <button
              type="button"
              onClick={handleClear}
              className="text-sm font-medium text-ink-dim transition hover:text-gold-dim"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={submit}
              className="rounded-full bg-gold-dim px-4 py-2 text-sm font-semibold text-paper transition hover:brightness-90"
            >
              Apply filters
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
