import Footer from "@/components/Footer";
import Nav from "@/components/Nav";

/**
 * Shown by a route's loading.tsx the instant a navigation starts.
 *
 * Without it, pages that fetch on the client render nothing until the route
 * resolves — so the previous page stays on screen, still scrolled where it was,
 * and the click looks like it did nothing. A skeleton gives immediate proof the
 * navigation happened, at the top of the page.
 */
export default function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-[1400px]" aria-busy="true" aria-live="polite">
          <span className="sr-only">Loading…</span>

          <div className="h-4 w-28 animate-pulse bg-blush" />
          <div className="mt-5 h-9 w-72 animate-pulse bg-blush" />
          <div className="mt-4 h-4 w-full max-w-xl animate-pulse bg-blush" />

          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: rows * 3 }).map((_, i) => (
              <div key={i} className="border border-line p-5">
                <div className="h-10 w-10 animate-pulse bg-blush" />
                <div className="mt-4 h-4 w-32 animate-pulse bg-blush" />
                <div className="mt-2 h-3 w-full animate-pulse bg-blush" />
              </div>
            ))}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
