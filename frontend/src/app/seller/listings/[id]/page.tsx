"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Footer from "@/components/Footer";
import ListingForm from "@/components/ListingForm";
import ListingImages from "@/components/ListingImages";
import Nav from "@/components/Nav";
import StatusBadge from "@/components/StatusBadge";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import {
  getSellerListing,
  publishListing,
  unpublishListing,
  updateListing,
  type ListingInput,
  type SellerListing,
  type SellerListingImage,
} from "@/lib/sellerApi";

export default function EditListingPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const justCreated = searchParams.get("created") === "1";
  const justPublished = searchParams.get("published") === "1";
  const failedUploads = Number(searchParams.get("failed") ?? 0);
  const { user, loading } = useAuth();

  const [listing, setListing] = useState<SellerListing | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const { listing } = await getSellerListing(params.id);
      setListing(listing);
    } catch (err) {
      if (err instanceof ApiError && err.code === "NOT_FOUND") {
        setNotFound(true);
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't load that listing.");
      }
    }
  }, [params.id]);

  useEffect(() => {
    if (user?.isSeller) load();
  }, [user?.isSeller, load]);

  async function handleSave(input: ListingInput) {
    setNotice(null);
    setError(null);
    const { listing: updated } = await updateListing(params.id, input);
    setListing(updated);
    setNotice("Changes saved.");
  }

  async function toggleStatus() {
    if (!listing) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const { listing: updated } =
        listing.status === "ACTIVE"
          ? await unpublishListing(listing.id)
          : await publishListing(listing.id);
      setListing(updated);
      setNotice(updated.status === "ACTIVE" ? "Published — it's live now." : "Moved back to draft.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleImagesChange(images: SellerListingImage[]) {
    setListing((current) => (current ? { ...current, images } : current));
  }

  if (loading || !user || (!listing && !notFound && !error)) {
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-16">
          <div className="mx-auto max-w-3xl text-sm text-ink-dim">Loading…</div>
        </main>
        <Footer />
      </>
    );
  }

  if (notFound) {
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-16">
          <div className="mx-auto max-w-3xl">
            <h1 className="font-serif text-3xl font-medium text-ink">
              That listing isn&apos;t here
            </h1>
            <p className="mt-3 text-sm text-ink-dim">
              It may have been removed, or it belongs to another account.
            </p>
            <Link
              href="/seller"
              className="mt-6 inline-block rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90"
            >
              Back to your listings
            </Link>
          </div>
        </main>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-5xl">
          <Link
            href="/seller"
            className="text-sm text-ink-dim transition hover:text-gold-dim"
          >
            ← Your listings
          </Link>

          {listing && (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="font-serif text-3xl font-medium tracking-tight text-ink">
                    Edit listing
                  </h1>
                  <StatusBadge status={listing.status} />
                </div>

                {listing.status !== "SOLD" && (
                  <button
                    type="button"
                    onClick={toggleStatus}
                    disabled={busy || (listing.status !== "ACTIVE" && listing.images.length === 0)}
                    className={
                      listing.status === "ACTIVE"
                        ? "rounded-full border border-line px-5 py-2.5 text-sm font-medium text-ink-dim transition hover:border-gold/50 hover:text-gold-dim disabled:opacity-50"
                        : "rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90 disabled:opacity-50"
                    }
                  >
                    {listing.status === "ACTIVE" ? "Unpublish" : "Publish"}
                  </button>
                )}
              </div>

              {justCreated && justPublished && (
                <p className="mt-5 rounded-xl border border-sage/50 bg-sage/20 px-4 py-3 text-sm text-ink">
                  Listed and live — buyers can see it now.{" "}
                  <Link href={`/listing/${listing.slug}`} className="text-gold-dim underline">
                    View it in the shop
                  </Link>
                  .
                </p>
              )}

              {justCreated && !justPublished && (
                <p className="mt-5 rounded-xl border border-gold/30 bg-gold/10 px-4 py-3 text-sm text-ink">
                  Saved as a draft. Add at least one photo and it&apos;s ready to
                  publish.
                </p>
              )}

              {failedUploads > 0 && (
                <p className="mt-5 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
                  {failedUploads} photo{failedUploads === 1 ? "" : "s"} didn&apos;t
                  upload. The listing was saved — you can add them again below.
                </p>
              )}

              {listing.status === "DRAFT" && listing.images.length === 0 && (
                <p className="mt-5 rounded-xl border border-gold/30 bg-gold/10 px-4 py-3 text-sm text-ink">
                  This is a private draft. It needs one photo before it can go live.
                </p>
              )}

              {notice && (
                <p className="mt-5 rounded-xl border border-sage/50 bg-sage/20 px-4 py-3 text-sm text-ink">
                  {notice}
                </p>
              )}

              {error && (
                <p className="mt-5 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
                  {error}
                </p>
              )}

              <ListingForm
                key={listing.id}
                initial={listing}
                submitLabel="Save changes"
                onSubmit={handleSave}
              />

              <ListingImages
                listingId={listing.id}
                images={listing.images}
                onChange={handleImagesChange}
              />
            </>
          )}

          {!listing && error && (
            <p className="mt-6 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
              {error}
            </p>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
