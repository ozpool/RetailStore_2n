import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import Footer from "@/components/Footer";
import ListingCard from "@/components/ListingCard";
import ListingReviews from "@/components/ListingReviews";
import Nav from "@/components/Nav";
import ReportButton from "@/components/ReportButton";
import ReserveButton from "@/components/ReserveButton";
import StarRating from "@/components/StarRating";
import WishlistButton from "@/components/WishlistButton";
import { discountPercent, formatPrice, getListing } from "@/lib/catalog";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default async function ListingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await getListing(slug);

  if (!data) {
    notFound();
  }

  const { listing, related } = data;
  const discount = discountPercent(listing);
  const cover = listing.images[0];

  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-10">
        <div className="mx-auto max-w-[1400px]">
          <nav className="flex flex-wrap items-center gap-2 text-sm text-ink-dim">
            <Link href="/" className="transition hover:text-gold-dim">
              Home
            </Link>
            <span aria-hidden="true">/</span>
            <Link
              href={`/shop/${listing.category.slug}`}
              className="transition hover:text-gold-dim"
            >
              {listing.category.title}
            </Link>
            <span aria-hidden="true">/</span>
            <span className="text-ink">{listing.title}</span>
          </nav>

          <div className="mt-8 grid gap-10 lg:grid-cols-2">
            <div className="relative aspect-square overflow-hidden rounded-3xl border border-line bg-paper-card">
              {cover ? (
                <Image
                  src={cover.url}
                  alt={cover.alt ?? listing.title}
                  fill
                  sizes="(min-width: 1024px) 50vw, 100vw"
                  className="object-cover"
                  priority
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-ink-dim">
                  No photo yet
                </div>
              )}
              {discount && (
                <span className="absolute top-4 right-4 rounded-full bg-gold-dim px-3 py-1 text-xs font-semibold text-paper shadow-sm">
                  -{discount}%
                </span>
              )}
            </div>

            <div>
              <h1 className="font-serif text-3xl font-medium tracking-tight text-ink sm:text-4xl">
                {listing.title}
              </h1>

              <div className="mt-3">
                {listing.rating.average === null ? (
                  <span className="text-sm text-ink-dim">No reviews yet</span>
                ) : (
                  <StarRating
                    rating={listing.rating.average}
                    count={listing.rating.count}
                  />
                )}
              </div>

              <p className="mt-5 flex items-baseline gap-3">
                <span className="text-2xl font-semibold text-gold-dim">
                  {formatPrice(listing.priceCents, listing.currency)}
                </span>
                {listing.originalPriceCents && (
                  <span className="text-sm text-ink-dim/70 line-through">
                    {formatPrice(listing.originalPriceCents, listing.currency)}
                  </span>
                )}
              </p>

              <p className="mt-6 text-ink-dim">{listing.description}</p>

              <dl className="mt-8 grid grid-cols-2 gap-4 rounded-2xl border border-line bg-paper-card p-5 text-sm">
                <div>
                  <dt className="text-ink-dim">Condition</dt>
                  <dd className="mt-1 font-medium text-ink">
                    {listing.conditionNote ?? listing.condition}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-dim">Availability</dt>
                  <dd className="mt-1 font-medium text-ink">
                    {listing.status === "SOLD"
                      ? "Sold"
                      : listing.quantity === 0
                        ? "On hold"
                        : listing.quantity === 1
                          ? "Only 1 available"
                          : `${listing.quantity} available`}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-dim">Sold by</dt>
                  <dd className="mt-1 flex items-center gap-2 font-medium text-ink">
                    {listing.seller.shopName}
                    {listing.seller.verified && (
                      <span className="rounded-full border border-gold/30 px-2 py-0.5 text-[11px] font-medium text-gold-dim">
                        Verified
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-dim">Listed</dt>
                  <dd className="mt-1 font-medium text-ink">
                    {formatDate(listing.createdAt)}
                  </dd>
                </div>
              </dl>

              <ReserveButton
                listingId={listing.id}
                status={listing.status}
                quantity={listing.quantity}
              />

              {/* Saving stays available even when the item can't be held —
                  something sold or reserved is exactly what a buyer wants to
                  keep an eye on. */}
              <WishlistButton
                listingId={listing.id}
                title={listing.title}
                variant="full"
                className="mt-3"
              />

              {/* Understated on purpose: findable when needed, invisible the
                  rest of the time. A prominent report button gets used as a
                  disagreement button. */}
              <div className="mt-5">
                <ReportButton targetType="LISTING" targetId={listing.id} />
              </div>
            </div>
          </div>

          {/* The reviews are public and ship with the HTML; whether *you* may
              write one depends on whether you bought it, which can't be baked
              into a page served to everybody. Hence a client island. */}
          <ListingReviews
            listingId={listing.id}
            initialReviews={listing.reviews}
            average={listing.rating.average}
            count={listing.rating.count}
            breakdown={listing.ratingBreakdown}
          />

          {related.length > 0 && (
            <section className="mt-16">
              <h2 className="font-serif text-2xl font-medium tracking-tight text-ink">
                More in {listing.category.title}
              </h2>
              <div className="mt-6 grid grid-cols-2 gap-5 sm:grid-cols-4">
                {related.map((item) => (
                  <ListingCard key={item.id} item={item} />
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
