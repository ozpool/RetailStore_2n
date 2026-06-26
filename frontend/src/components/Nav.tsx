"use client";

import Link from "next/link";
import { useState } from "react";
import Avatar from "@/components/Avatar";
import NotificationBell from "@/components/NotificationBell";
import SearchWithFilters from "@/components/SearchWithFilters";
import UserMenu from "@/components/UserMenu";
import { useAuth } from "@/lib/AuthContext";
import { useCart } from "@/lib/CartContext";
import { useWishlist } from "@/lib/WishlistContext";

const LINKS = [
  { key: "home", href: "/", label: "Home" },
  { key: "shop", href: "/search", label: "Shop" },
  { key: "about", href: "/about", label: "About" },
  { key: "contact", href: "/help/contact", label: "Contact" },
];

/**
 * Header laid out as in the reference: wordmark left, links centred, icons and
 * account actions right, above a thin rule.
 */
export default function Nav() {
  const [open, setOpen] = useState(false);
  const { user, loading, logout } = useAuth();
  const { count: wishlistCount } = useWishlist();
  const { count: cartCount } = useCart();


  return (
    <header className="sticky top-0 z-50 bg-paper">
      <div className="border-b border-line">
        {/* Both outer zones are flex-1 so they share the leftover width equally,
            which keeps the link row dead-centre even though the right-hand side
            is much wider than the wordmark — and stays centred when the search
            box appears for signed-in users. */}
        <div className="mx-auto flex max-w-[1400px] items-center gap-8 px-6 py-5">
          <div className="flex min-w-0 flex-1 items-center">
            <Link
              href="/"
              className="flex shrink-0 items-baseline gap-2 font-serif text-2xl font-bold tracking-tight text-ink"
            >
              RetailStore_2n
            </Link>
          </div>

          <nav className="hidden shrink-0 items-center justify-center gap-10 md:flex">
            {LINKS.map((link) => (
              <Link
                key={link.key}
                href={link.href}
                className="text-base text-ink transition hover:text-gold-dim"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="hidden min-w-0 flex-1 items-center justify-end gap-5 md:flex">
            {/* Search is a signed-in tool: it carries the filter panel, and an
                empty search box adds nothing for a first-time visitor. */}
            {user && (
              <div className="w-72">
                <SearchWithFilters />
              </div>
            )}

            <Link
              href="/wishlist"
              aria-label={
                wishlistCount > 0
                  ? `Wishlist, ${wishlistCount} saved`
                  : "Wishlist"
              }
              className="relative text-ink transition hover:text-gold-dim"
            >
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.8 5.6a5 5 0 00-7.1 0L12 7.3l-1.7-1.7a5 5 0 10-7.1 7.1L12 21.5l8.8-8.8a5 5 0 000-7.1z" />
              </svg>
              {/* aria-hidden because the count is already in the link's label —
                  otherwise a screen reader reads the number twice. */}
              {wishlistCount > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[10px] font-semibold text-paper"
                >
                  {wishlistCount > 9 ? "9+" : wishlistCount}
                </span>
              )}
            </Link>

            <Link
              href="/cart"
              aria-label={cartCount > 0 ? `Cart, ${cartCount} item${cartCount === 1 ? "" : "s"}` : "Cart"}
              className="relative text-ink transition hover:text-gold-dim"
            >
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="20" r="1.5" />
                <circle cx="18" cy="20" r="1.5" />
                <path d="M2 3h2.5l2.4 11.2a2 2 0 002 1.6h8.6a2 2 0 002-1.5L21 7H6" />
              </svg>
              {/* aria-hidden: the count is already in the link's label, so a
                  screen reader would otherwise read the number twice. */}
              {cartCount > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[10px] font-semibold text-paper"
                >
                  {cartCount > 9 ? "9+" : cartCount}
                </span>
              )}
            </Link>

            {loading ? null : user ? (
              <>
                <NotificationBell />
                <UserMenu user={user} />
              </>
            ) : (
              <div className="flex items-center gap-2">
                <Link
                  href="/login"
                  className="rounded bg-gold-dim px-5 py-2 text-sm font-medium text-paper transition hover:brightness-95"
                >
                  Log in
                </Link>
                <Link
                  href="/signup"
                  className="rounded border border-ink px-5 py-2 text-sm font-medium text-ink transition hover:bg-ink hover:text-paper"
                >
                  Sign Up
                </Link>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto text-ink md:hidden"
            aria-label="Toggle navigation"
          >
            {open ? "✕" : "☰"}
          </button>
        </div>
      </div>

      {open && (
        <nav className="flex flex-col gap-4 border-b border-line px-6 py-4 md:hidden">
          {LINKS.map((link) => (
            <Link
              key={link.key}
              href={link.href}
              onClick={() => setOpen(false)}
              className="text-sm text-ink hover:text-gold-dim"
            >
              {link.label}
            </Link>
          ))}

          <div className="mt-2 flex flex-col gap-4 border-t border-line pt-4">
            {loading ? null : user ? (
              <>
                <Link href="/account" onClick={() => setOpen(false)} className="flex items-center gap-3 text-sm text-ink">
                  <Avatar name={user.name} src={user.avatarUrl} size={28} />
                  {user.name.split(" ")[0]}
                </Link>
                <Link href="/cart" onClick={() => setOpen(false)} className="text-sm text-ink hover:text-gold-dim">
                  Cart
                </Link>
                <Link href="/wishlist" onClick={() => setOpen(false)} className="text-sm text-ink hover:text-gold-dim">
                  Wishlist
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    logout();
                  }}
                  className="text-left text-sm font-medium text-ink hover:text-gold-dim"
                >
                  Log out
                </button>
              </>
            ) : (
              <>
                <Link href="/login" onClick={() => setOpen(false)} className="text-sm font-medium text-ink hover:text-gold-dim">
                  Log in
                </Link>
                <Link href="/signup" onClick={() => setOpen(false)} className="text-sm font-medium text-gold-dim">
                  Sign Up
                </Link>
              </>
            )}
          </div>
        </nav>
      )}
    </header>
  );
}
