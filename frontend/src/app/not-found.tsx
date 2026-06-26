import Link from "next/link";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";

/**
 * Catches both unmatched routes and any `notFound()` call — a removed listing,
 * an unknown category slug. Laid out like the reference design's 404: a
 * breadcrumb, an oversized heading, one line of explanation, one red action.
 */
export default function NotFound() {
  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-10">
        <div className="mx-auto max-w-[1400px]">
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-2 text-sm text-ink-dim"
          >
            <Link href="/" className="transition hover:text-gold-dim">
              Home
            </Link>
            <span aria-hidden="true">/</span>
            <span className="text-ink">404 Error</span>
          </nav>

          <div className="flex flex-col items-center py-24 text-center sm:py-32">
            <h1 className="font-serif text-5xl font-medium tracking-tight text-ink sm:text-7xl lg:text-8xl">
              404 Not Found
            </h1>

            <p className="mt-8 max-w-md text-ink-dim">
              We couldn&apos;t find that page. It may have been removed, or the link
              may be wrong.
            </p>

            <Link
              href="/"
              className="mt-12 inline-block rounded bg-gold-dim px-10 py-4 text-sm font-medium text-paper transition hover:brightness-95"
            >
              Back to home page
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
