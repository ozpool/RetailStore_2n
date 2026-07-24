"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AccountCard from "@/components/AccountCard";
import Avatar from "@/components/Avatar";
import AvatarUploader from "@/components/AvatarUploader";
import {
  AddressIcon,
  BellIcon,
  CancelIcon,
  CardIcon,
  CartIcon,
  HeartIcon,
  LockIcon,
  OrdersIcon,
  ShieldIcon,
  StarIcon,
  TagIcon,
  WalletIcon,
} from "@/components/AccountIcons";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { useAuth } from "@/lib/AuthContext";
import { getSellerProfile, type SellerProfile } from "@/lib/sellerApi";

function PlannedBadge() {
  return (
    <span className="shrink-0 rounded-full border border-line px-2.5 py-1 text-xs font-medium text-ink-dim">
      Planned
    </span>
  );
}

function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "good" | "warn" | "neutral";
}) {
  const styles = {
    good: "border-sage/50 bg-sage/20 text-ink",
    warn: "border-clay/30 bg-clay/10 text-clay",
    neutral: "border-line bg-paper text-ink-dim",
  };
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${styles[tone]}`}
    >
      {children}
    </span>
  );
}

const KYC_LABEL: Record<string, string> = {
  UNSTARTED: "Not verified",
  PENDING: "In progress",
  VERIFIED: "Verified",
  REJECTED: "Needs another try",
};

export default function AccountPage() {
  const router = useRouter();
  const { user, loading, becomeSeller } = useAuth();

  const [becomingSeller, setBecomingSeller] = useState(false);
  const [sellerError, setSellerError] = useState<string | null>(null);
  const [seller, setSeller] = useState<SellerProfile | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  const loadSeller = useCallback(async () => {
    try {
      const data = await getSellerProfile();
      setSeller(data.seller);
      setCounts(data.counts ?? {});
    } catch {
      // Non-fatal: the seller panels simply show nothing rather than blocking
      // the rest of the page.
      setSeller(null);
    }
  }, []);

  useEffect(() => {
    if (user?.isSeller) loadSeller();
  }, [user?.isSeller, loadSeller]);

  if (loading || !user) {
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-16">
          <div className="mx-auto max-w-[1400px] text-sm text-ink-dim">Loading…</div>
        </main>
        <Footer />
      </>
    );
  }

  const memberSince = new Date(user.createdAt).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  async function handleBecomeSeller() {
    setSellerError(null);
    setBecomingSeller(true);
    try {
      await becomeSeller();
    } catch {
      setSellerError("Couldn't turn on selling. Please try again.");
    } finally {
      setBecomingSeller(false);
    }
  }

  const live = counts.ACTIVE ?? 0;
  const drafts = counts.DRAFT ?? 0;
  const totalListings = Object.values(counts).reduce((sum, n) => sum + n, 0);

  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-[1400px]">
          {/* ---- Identity header ---- */}
          <section className="flex flex-wrap items-center gap-5 border-b border-line pb-8">
            <Avatar name={user.name} src={user.avatarUrl} size={64} />

            <div className="min-w-56 flex-1">
              <h1 className="font-serif text-3xl font-medium tracking-tight text-ink">
                {user.name}
              </h1>
              <p className="mt-1 text-sm text-ink-dim">
                {user.email} · Member since {memberSince}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {user.emailVerified ? (
                <Pill tone="good">Email verified</Pill>
              ) : (
                <Pill tone="warn">Email unverified</Pill>
              )}
              {user.isSeller && <Pill tone="neutral">Seller</Pill>}
              {seller?.kycStatus === "VERIFIED" && <Pill tone="good">ID verified</Pill>}
            </div>
          </section>

          {/* ---- Profile ---- */}
          <section className="mt-10">
            <h2 className="font-serif text-xl font-medium text-ink">Profile</h2>
            <div className="mt-5 rounded-3xl border border-line bg-paper-card p-6">
              <AvatarUploader user={user} />
            </div>
          </section>

          {/* ---- Buying ---- */}
          <section className="mt-12">
            <h2 className="font-serif text-xl font-medium text-ink">Your account</h2>
            <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <AccountCard
                icon={<OrdersIcon />}
                title="My orders"
                description="Track purchases and view past orders."
                href="/account/orders"
              />
              <AccountCard
                icon={<StarIcon />}
                title="My reviews"
                description="Reviews you've written, and what buyers see."
                href="/account/reviews"
              />
              <AccountCard
                icon={<CancelIcon />}
                /* Retitled from "My cancellations". The page lists refunds, and
                   naming it after what it holds beats naming it after the thing
                   that caused them — most refunds here are a seller unable to
                   send, not a cancellation. */
                title="Refunds"
                description="Money sent back to you, and why."
                href="/account/cancellations"
              />
              <AccountCard
                icon={<CartIcon />}
                title="Your cart"
                description="Items you're getting ready to buy."
                href="/cart"
              />
              <AccountCard
                icon={<HeartIcon />}
                title="Saved items"
                description="Pieces you've kept an eye on."
                href="/wishlist"
              />
              <AccountCard
                icon={<LockIcon />}
                title="Login & security"
                href="/account/security"
                description={
                  user.emailVerified
                    ? "Change your password and see what's signed in."
                    : "Confirm your email address to secure the account."
                }
                badge={
                  user.emailVerified ? (
                    <Pill tone="good">Verified</Pill>
                  ) : (
                    <Pill tone="warn">Action needed</Pill>
                  )
                }
              />
              <AccountCard
                icon={<AddressIcon />}
                title="Addresses"
                description="Where your orders get delivered."
                href="/account/addresses"
              />
              <AccountCard
                icon={<CardIcon />}
                title="Payment methods"
                description="Cards and payment options on file."
                badge={<PlannedBadge />}
              />
              <AccountCard
                icon={<BellIcon />}
                title="Notifications"
                /* Describes what this actually is. Per-type preferences aren't
                   built, and with in-app delivery only there is nothing to opt
                   out of receiving — so promising settings here would be the
                   dishonest half of the old copy. */
                description="Sales, deliveries, and decisions about your account."
                href="/account/notifications"
              />
            </div>
          </section>

          {/* ---- Selling ---- */}
          <section className="mt-12">
            <h2 className="font-serif text-xl font-medium text-ink">Selling</h2>

            {!user.isSeller ? (
              <div className="mt-5 rounded-3xl border border-line bg-paper-card p-8">
                <h3 className="text-base font-semibold text-ink">
                  Have something worth a second life?
                </h3>
                <p className="mt-2 max-w-xl text-sm text-ink-dim">
                  Turn on selling and you can list your first item straight away. You
                  don&apos;t need to verify your identity to list — that&apos;s only
                  required before money can be paid out to you.
                </p>
                <button
                  type="button"
                  onClick={handleBecomeSeller}
                  disabled={becomingSeller}
                  className="seam-glow mt-5 rounded-full bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-90 disabled:opacity-60"
                >
                  {becomingSeller ? "Turning on…" : "Start selling"}
                </button>
                {sellerError && (
                  <p className="mt-3 text-sm text-clay">{sellerError}</p>
                )}
              </div>
            ) : (
              <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                <AccountCard
                  icon={<OrdersIcon />}
                  title="Sales"
                  description="What people have bought from you, and what needs sending."
                  href="/seller/sales"
                />
                <AccountCard
                  icon={<TagIcon />}
                  title="Your listings"
                  description={
                    totalListings === 0
                      ? "Nothing listed yet. Put your first item up."
                      : "Create, edit, and publish what you're selling."
                  }
                  href="/seller"
                  meta={
                    totalListings === 0
                      ? undefined
                      : `${live} live · ${drafts} draft${drafts === 1 ? "" : "s"}`
                  }
                />
                <AccountCard
                  icon={<ShieldIcon />}
                  title="Identity verification"
                  description={
                    seller?.kycStatus === "VERIFIED"
                      ? "Your identity is confirmed and payouts are unlocked."
                      : "Required before you can receive payouts. Listing works either way."
                  }
                  href="/seller/verify"
                  badge={
                    seller ? (
                      <Pill
                        tone={
                          seller.kycStatus === "VERIFIED"
                            ? "good"
                            : seller.kycStatus === "REJECTED"
                              ? "warn"
                              : "neutral"
                        }
                      >
                        {KYC_LABEL[seller.kycStatus] ?? seller.kycStatus}
                      </Pill>
                    ) : undefined
                  }
                />
                <AccountCard
                  icon={<WalletIcon />}
                  title="Payouts"
                  description={
                    seller?.payoutsEnabled
                      ? "Unlocked. Nothing to pay out — payments are sandbox only."
                      : "Locked until your identity is verified."
                  }
                  href="/seller/verify"
                  badge={
                    seller ? (
                      <Pill tone={seller.payoutsEnabled ? "good" : "neutral"}>
                        {seller.payoutsEnabled ? "Unlocked" : "Locked"}
                      </Pill>
                    ) : undefined
                  }
                />
              </div>
            )}
          </section>

          {/* ---- Help ---- */}
          <section className="mt-12 rounded-3xl border border-line bg-blush/40 p-6">
            <h2 className="text-sm font-semibold text-ink">Need a hand?</h2>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <Link href="/help/contact" className="text-gold-dim hover:underline">
                Contact us
              </Link>
              <Link href="/help/returns-refunds" className="text-gold-dim hover:underline">
                Returns &amp; refunds
              </Link>
              <Link href="/help/shipping" className="text-gold-dim hover:underline">
                Shipping
              </Link>
              <Link href="/help/trust-safety" className="text-gold-dim hover:underline">
                Trust &amp; safety
              </Link>
              <Link href="/sell/how-it-works" className="text-gold-dim hover:underline">
                How selling works
              </Link>
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
