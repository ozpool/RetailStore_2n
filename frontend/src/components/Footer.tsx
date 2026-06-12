import Link from "next/link";

const COLUMNS = [
  {
    title: "Support",
    lines: [
      { label: "About RetailStore_2n", href: "/about" },
      { label: "Contact us", href: "/help/contact" },
      { label: "Trust & safety", href: "/help/trust-safety" },
      { label: "Shipping", href: "/help/shipping" },
      { label: "Returns & refunds", href: "/help/returns-refunds" },
    ],
  },
  {
    title: "Account",
    lines: [
      { label: "My account", href: "/account" },
      { label: "Login / Register", href: "/login" },
      { label: "Cart", href: "/cart" },
      { label: "Wishlist", href: "/wishlist" },
      { label: "Shop", href: "/search" },
    ],
  },
  {
    title: "Shop",
    lines: [
      { label: "Furniture & Home", href: "/shop/furniture-home" },
      { label: "Clothing & Accessories", href: "/shop/clothing-accessories" },
      { label: "Music, Film & Books", href: "/shop/music-film-books" },
      { label: "Décor & Curiosities", href: "/shop/decor-curiosities" },
      { label: "Bikes & Outdoors", href: "/shop/bikes-outdoors" },
      { label: "Kitchen & Tableware", href: "/shop/kitchen-tableware" },
      { label: "Electronics", href: "/shop/electronics" },
    ],
  },
  {
    title: "Selling",
    lines: [
      { label: "How it works", href: "/sell/how-it-works" },
      { label: "Seller fees", href: "/sell/seller-fees" },
      { label: "Shipping", href: "/sell/shipping-labels" },
      { label: "Payouts", href: "/sell/payouts" },
    ],
  },
];

/** Black footer in the reference's five-column layout. */
export default function Footer() {
  return (
    <footer className="bg-ink px-6 pt-16 pb-6 text-paper">
      <div className="mx-auto max-w-[1400px]">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <p className="font-serif text-2xl font-bold tracking-tight">RetailStore_2n</p>
            <p className="mt-5 text-sm font-medium">Stay in the loop</p>
            <p className="mt-2 text-sm text-paper/70">
              New listings and the odd good find, once a week.
            </p>
            <form
              className="mt-4 flex items-center gap-2 rounded border border-paper/60 px-3 py-2"
              action="/"
            >
              <input
                type="email"
                placeholder="Enter your email"
                aria-label="Email address"
                className="w-full bg-transparent text-sm text-paper outline-none placeholder:text-paper/50"
              />
              <button type="submit" aria-label="Subscribe" className="text-paper">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 5h18v14H3z" />
                  <path d="M3 6l9 7 9-7" />
                </svg>
              </button>
            </form>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.title}>
              <h2 className="text-lg font-medium">{column.title}</h2>
              <ul className="mt-5 space-y-3 text-sm text-paper/70">
                {column.lines.map((line) => (
                  <li key={line.href}>
                    <Link href={line.href} className="transition hover:text-paper">
                      {line.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 border-t border-paper/20 pt-6 text-center text-sm text-paper/50">
          © 2026 RetailStore_2n. Repaired, not hidden. Marketplace imagery via Unsplash.
        </div>
      </div>
    </footer>
  );
}
