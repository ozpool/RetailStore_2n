import Link from "next/link";
import Footer from "@/components/Footer";
import ListingCard from "@/components/ListingCard";
import Nav from "@/components/Nav";
import {
  CONDITION_OPTIONS,
  SORT_OPTIONS,
  getCategories,
  getListings,
  type ListingQuery,
} from "@/lib/catalog";

type SearchParams = {
  q?: string;
  category?: string;
  condition?: string;
  minPrice?: string;
  maxPrice?: string;
  sort?: string;
  page?: string;
};

const SORTS = new Set(SORT_OPTIONS.map((s) => s.value as string));

function buildHref(base: SearchParams, overrides: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value) params.set(key, value);
  }
  const s = params.toString();
  return s ? `/search?${s}` : "/search";
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  const query: ListingQuery = {
    q: sp.q,
    category: sp.category,
    condition: CONDITION_OPTIONS.some((c) => c.value === sp.condition)
      ? sp.condition
      : undefined,
    minPrice: sp.minPrice,
    maxPrice: sp.maxPrice,
    sort: SORTS.has(sp.sort ?? "") ? (sp.sort as ListingQuery["sort"]) : "newest",
    page: sp.page,
    limit: 24,
  };

  const [categories, result] = await Promise.all([
    getCategories(),
    getListings(query).catch(() => null),
  ]);

  const activeCategory = categories.find((c) => c.slug === sp.category);
  const activeCondition = CONDITION_OPTIONS.find((c) => c.value === sp.condition);
  const currentSort = query.sort ?? "newest";
  const page = result?.page ?? 1;

  const chips: { label: string; href: string }[] = [];
  if (sp.q) chips.push({ label: `“${sp.q}”`, href: buildHref(sp, { q: undefined, page: undefined }) });
  if (activeCategory)
    chips.push({
      label: activeCategory.title,
      href: buildHref(sp, { category: undefined, page: undefined }),
    });
  if (activeCondition)
    chips.push({
      label: activeCondition.label,
      href: buildHref(sp, { condition: undefined, page: undefined }),
    });
  if (sp.minPrice)
    chips.push({
      label: `Min $${sp.minPrice}`,
      href: buildHref(sp, { minPrice: undefined, page: undefined }),
    });
  if (sp.maxPrice)
    chips.push({
      label: `Max $${sp.maxPrice}`,
      href: buildHref(sp, { maxPrice: undefined, page: undefined }),
    });

  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-10">
        <div className="mx-auto max-w-[1400px]">
          <h1 className="font-serif text-3xl font-medium tracking-tight text-ink">
            {sp.q ? `Results for “${sp.q}”` : "Browse everything"}
          </h1>

          {result === null ? (
            <p className="mt-4 text-sm text-ink-dim">
              Those filters didn&apos;t make sense together — check the price range and
              try again.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-ink-dim">
                {result.total} {result.total === 1 ? "listing" : "listings"}
              </p>

              {chips.length > 0 && (
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  {chips.map((chip) => (
                    <Link
                      key={chip.label}
                      href={chip.href}
                      className="group flex items-center gap-1.5 rounded-full border border-gold/40 bg-gold/10 px-3 py-1.5 text-sm text-gold-dim transition hover:border-gold"
                    >
                      {chip.label}
                      <span aria-hidden="true" className="text-ink-dim group-hover:text-gold-dim">
                        ✕
                      </span>
                    </Link>
                  ))}
                  <Link
                    href="/search"
                    className="text-sm text-ink-dim underline transition hover:text-gold-dim"
                  >
                    Clear all
                  </Link>
                </div>
              )}

              <div className="mt-6 flex flex-wrap items-center gap-2 border-b border-line pb-6">
                <span className="text-sm text-ink-dim">Sort:</span>
                {SORT_OPTIONS.map((option) => (
                  <Link
                    key={option.value}
                    href={buildHref(sp, { sort: option.value, page: undefined })}
                    className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                      currentSort === option.value
                        ? "border-gold-dim bg-gold-dim text-paper"
                        : "border-line text-ink-dim hover:border-gold/50 hover:text-gold-dim"
                    }`}
                  >
                    {option.label}
                  </Link>
                ))}
              </div>

              {result.listings.length === 0 ? (
                <div className="mt-12">
                  <p className="text-ink">Nothing matched that.</p>
                  <p className="mt-2 text-sm text-ink-dim">
                    Try fewer filters, or{" "}
                    <Link href="/search" className="text-gold-dim underline">
                      browse everything
                    </Link>
                    .
                  </p>
                </div>
              ) : (
                <div className="mt-8 grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
                  {result.listings.map((item) => (
                    <ListingCard key={item.id} item={item} />
                  ))}
                </div>
              )}

              {result.pageCount > 1 && (
                <div className="mt-12 flex items-center justify-center gap-3">
                  {page > 1 && (
                    <Link
                      href={buildHref(sp, { page: String(page - 1) })}
                      className="rounded-full border border-line px-4 py-2 text-sm text-ink-dim transition hover:border-gold/50 hover:text-gold-dim"
                    >
                      ← Previous
                    </Link>
                  )}
                  <span className="text-sm text-ink-dim">
                    Page {page} of {result.pageCount}
                  </span>
                  {page < result.pageCount && (
                    <Link
                      href={buildHref(sp, { page: String(page + 1) })}
                      className="rounded-full border border-line px-4 py-2 text-sm text-ink-dim transition hover:border-gold/50 hover:text-gold-dim"
                    >
                      Next →
                    </Link>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
