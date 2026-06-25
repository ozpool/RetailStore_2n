import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import SectionHeading from "@/components/SectionHeading";
import ServiceStrip from "@/components/ServiceStrip";
import { CONDITION_OPTIONS, getCategories, getListings } from "@/lib/catalog";

export const metadata: Metadata = {
  title: "About — RetailStore_2n",
  description:
    "Why RetailStore_2n exists and how condition is described on every listing.",
};

const CONDITION_MEANING: Record<string, string> = {
  LIKE_NEW: "Barely used. Nothing worth mentioning.",
  GOOD: "Used and sound, with a few honest signs of life.",
  WELL_LOVED: "Clearly lived with. Character over polish.",
  NEEDS_REPAIR: "Sold as-is, with the work it needs spelled out.",
};

export default async function AboutPage() {
  // Real figures rather than round marketing numbers.
  const [categories, all] = await Promise.all([
    getCategories(),
    getListings({ limit: 48 }),
  ]);
  const cover = all.listings.find((l) => l.slug === "retailstore-2n-repaired-ceramic-plate");

  return (
    <>
      <Nav />
      <main className="flex-1">
        <div className="mx-auto max-w-[1400px] px-6 py-10">
          <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-ink-dim">
            <Link href="/" className="transition hover:text-gold-dim">
              Home
            </Link>
            <span aria-hidden="true">/</span>
            <span className="text-ink">About</span>
          </nav>
        </div>

        {/* ---- The name ---- */}
        <section className="border-b border-line px-6 pb-20">
          <div className="mx-auto grid max-w-[1400px] items-center gap-12 lg:grid-cols-2">
            <div>
              <span className="section-eyebrow">Our idea</span>
              <h1 className="mt-4 font-serif text-4xl leading-tight font-semibold tracking-tight text-ink sm:text-5xl">
                RetailStore_2n — repaired, not hidden
              </h1>
              <p className="mt-6 text-lg text-ink-dim">
                RetailStore_2n is a marketplace for things that have already had one
                life, where wear and repairs are part of an item's story rather
                than the part you apologise for.
              </p>
              <p className="mt-4 text-ink-dim">
                That is the whole idea behind this shop. Everything sold here has
                been owned before, and most of it carries some mark of that — a
                water ring, a resoled boot, a crack that was repaired years ago and
                has held ever since. We would rather name those things than
                photograph around them.
              </p>
            </div>

            <div className="relative aspect-4/3 w-full overflow-hidden bg-blush">
              {cover?.images[0] && (
                <Image
                  src={cover.images[0].url}
                  alt="A ceramic plate repaired with gold lacquer"
                  fill
                  sizes="(min-width: 1024px) 50vw, 100vw"
                  className="object-cover"
                  priority
                />
              )}
            </div>
          </div>
        </section>

        {/* ---- What this is ---- */}
        <section className="border-b border-line px-6 py-20">
          <div className="mx-auto max-w-[1400px]">
            <SectionHeading eyebrow="What this is" title="A marketplace, not a boutique" />

            <div className="mt-10 grid gap-10 lg:grid-cols-3">
              <p className="text-ink-dim">
                Anyone can list here. Sellers set their own prices and write their
                own descriptions, and the account you browse with is the account you
                sell from — there is no separate seller sign-up to complete.
              </p>
              <p className="text-ink-dim">
                Almost everything is one of one. That changes how buying works: an
                item you are looking at is held for you while you decide, so two
                people cannot end up owning the same chair.
              </p>
              <p className="text-ink-dim">
                Verifying your identity is only needed before money is paid out to
                you. Listing an item never requires it, because a listing is not a
                transaction.
              </p>
            </div>

            <dl className="mt-14 grid gap-8 border-t border-line pt-10 sm:grid-cols-3">
              <div>
                <dt className="text-sm text-ink-dim">Pieces listed</dt>
                <dd className="mt-1 font-serif text-4xl font-semibold text-ink">
                  {all.total}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-ink-dim">Categories</dt>
                <dd className="mt-1 font-serif text-4xl font-semibold text-ink">
                  {categories.length}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-ink-dim">Made this year</dt>
                <dd className="mt-1 font-serif text-4xl font-semibold text-ink">
                  None
                </dd>
              </div>
            </dl>
          </div>
        </section>

        {/* ---- Condition ---- */}
        <section className="border-b border-line px-6 py-20">
          <div className="mx-auto max-w-[1400px]">
            <SectionHeading
              eyebrow="How we describe things"
              title="Four words, and the seller's own"
            />

            <p className="mt-6 max-w-2xl text-ink-dim">
              Every listing carries one of four condition grades, so you can filter
              by them. Alongside it, sellers add a note in their own words — that is
              the line you see on the card, because &ldquo;Needs a tune-up&rdquo; tells
              you more than any fixed vocabulary can.
            </p>

            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {CONDITION_OPTIONS.map((option) => (
                <div key={option.value} className="border border-line p-6">
                  <h3 className="font-serif text-lg font-semibold text-ink">
                    {option.label}
                  </h3>
                  <p className="mt-2 text-sm text-ink-dim">
                    {CONDITION_MEANING[option.value]}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---- What we haven't built ---- */}
        <section className="border-b border-line px-6 py-20">
          <div className="mx-auto max-w-[1400px]">
            <SectionHeading eyebrow="Being straight with you" title="What isn't finished" />

            <div className="mt-10 grid gap-8 lg:grid-cols-2">
              <p className="text-ink-dim">
                Checkout runs against a payment sandbox. You can browse, hold an
                item so nobody else takes it, list things of your own, and go all
                the way through paying — but the card is a test card, no real money
                has ever moved through this site, and nothing gets shipped.
              </p>
              <p className="text-ink-dim">
                Payouts to sellers, saved addresses, and stored payment methods
                genuinely don&apos;t exist. Where a feature is missing, the page
                says so instead of showing a button that does nothing. It seemed a
                poor start to be vague about it on a site built around disclosure.
              </p>
            </div>

            <div className="mt-10 flex flex-wrap gap-4">
              <Link
                href="/search"
                className="rounded bg-gold-dim px-8 py-3 text-sm font-medium text-paper transition hover:brightness-95"
              >
                Browse what&apos;s here
              </Link>
              <Link
                href="/sell/how-it-works"
                className="rounded border border-ink px-8 py-3 text-sm font-medium text-ink transition hover:bg-ink hover:text-paper"
              >
                How selling works
              </Link>
              <Link
                href="/help/contact"
                className="rounded border border-line px-8 py-3 text-sm font-medium text-ink-dim transition hover:border-gold/50 hover:text-gold-dim"
              >
                Contact us
              </Link>
            </div>
          </div>
        </section>

        <ServiceStrip />
      </main>
      <Footer />
    </>
  );
}
