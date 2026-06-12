import Link from "next/link";
import SectionHeading from "@/components/SectionHeading";
import type { CatalogCategory } from "@/lib/catalog";

/** Simple line icons, one per category slug. */
const ICONS: Record<string, React.ReactNode> = {
  "furniture-home": (
    <>
      <path d="M4 18v-6a3 3 0 013-3h10a3 3 0 013 3v6" />
      <path d="M4 18h16M7 18v2M17 18v2" />
      <path d="M8 9V6a2 2 0 012-2h4a2 2 0 012 2v3" />
    </>
  ),
  "clothing-accessories": (
    <>
      <path d="M9 3l3 2 3-2 5 4-2 3-2-1v11H8V9L6 10 4 7z" />
    </>
  ),
  "music-film-books": (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  "decor-curiosities": (
    <>
      <path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" />
    </>
  ),
  "bikes-outdoors": (
    <>
      <circle cx="6" cy="17" r="3.5" />
      <circle cx="18" cy="17" r="3.5" />
      <path d="M9 17l3-8 4 8M12 9h4l2 3" />
    </>
  ),
  "kitchen-tableware": (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  electronics: (
    <>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
};

const FALLBACK = (
  <>
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </>
);

/**
 * The reference's "Browse By Category" row: bordered icon tiles that fill red
 * on hover. No listing counts here — the tiles are navigation, and a count
 * belongs on the category page itself.
 */
export default function CategoryTiles({
  categories,
}: {
  categories: CatalogCategory[];
}) {
  if (categories.length === 0) return null;

  return (
    <section className="border-b border-line px-6 py-16">
      <div className="mx-auto max-w-[1400px]">
        <SectionHeading eyebrow="Categories" title="Browse By Category" />

        {/* 7 columns at lg so the row stays a single line. Labels are short
            enough to fit; anything longer would need to wrap or truncate. */}
        <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
          {categories.map((category) => (
            <Link
              key={category.slug}
              href={`/shop/${category.slug}`}
              className="group flex flex-col items-center justify-center gap-3 border border-line px-4 py-7 text-center transition hover:border-gold hover:bg-gold"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-9 w-9 text-ink transition group-hover:text-paper"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {ICONS[category.slug] ?? FALLBACK}
              </svg>
              <span className="text-sm text-ink transition group-hover:text-paper">
                {category.title}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
