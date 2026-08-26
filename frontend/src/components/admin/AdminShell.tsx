"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/AuthContext";

/**
 * The chrome around every admin screen.
 *
 * DELIBERATELY NOT THE STOREFRONT LAYOUT
 * --------------------------------------
 * No Nav, no Footer, no centred reading column. Two reasons, and the second
 * matters more than the first:
 *
 *  1. A dashboard is scanned, not read. Dense rows, full width, one persistent
 *     rail — the shape every operator already knows from every other admin tool.
 *
 *  2. It should be impossible to forget which hat you are wearing. Sharing the
 *     storefront's chrome makes "browsing as a shopper" and "acting as a
 *     moderator with the power to suspend accounts" look identical, and the
 *     second one writes an audit row with your name on it.
 */

type NavItem = { href: string; label: string; icon: React.ReactNode; badge?: number };

export default function AdminShell({
  children,
  title,
  subtitle,
  actions,
  openReports,
  openReturns,
  secondsLeft,
  onSignOut,
}: {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  openReports?: number;
  /** Escalated returns: a buyer disputed a refusal and it needs deciding. */
  openReturns?: number;
  secondsLeft?: number;
  onSignOut: () => void;
}) {
  const pathname = usePathname();
  const { user } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  const items: NavItem[] = [
    { href: "/admin", label: "Dashboard", icon: <GridIcon /> },
    { href: "/admin/orders", label: "Orders", icon: <BagIcon /> },
    { href: "/admin/customers", label: "Customers", icon: <UsersIcon /> },
    { href: "/admin/catalogue", label: "Catalogue", icon: <TagIcon /> },
    { href: "/admin/reports", label: "Reports", icon: <FlagIcon />, badge: openReports },
    { href: "/admin/messages", label: "Messages", icon: <FlagIcon /> },
    { href: "/admin/placements", label: "Placements", icon: <TagIcon /> },
    { href: "/admin/deliveries", label: "Delivery log", icon: <SendIcon /> },
    { href: "/admin/payouts", label: "Payout log", icon: <BanknoteIcon /> },
    { href: "/admin/returns", label: "Returns", icon: <ReturnIcon />, badge: openReturns },
    { href: "/admin/audit", label: "Audit log", icon: <ScrollIcon /> },
  ];

  // Exact match for the dashboard, prefix for the rest — otherwise "/admin"
  // lights up on every page, since every path starts with it.
  const isActive = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);

  return (
    <div className="flex min-h-screen bg-blush">
      {/* ---- sidebar ---- */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-60 shrink-0 border-r border-line bg-paper-card transition-transform lg:static lg:translate-x-0 ${
          menuOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-14 items-center gap-2 border-b border-line px-5">
          <span className="inline-block h-2 w-2 rounded-full bg-gold" aria-hidden="true" />
          <span className="font-serif text-base font-semibold text-ink">RetailStore_2n</span>
          <span className="rounded bg-ink px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-paper">
            Admin
          </span>
        </div>

        <nav className="p-3">
          <ul className="grid gap-0.5">
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                  aria-current={isActive(item.href) ? "page" : undefined}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                    isActive(item.href)
                      ? "bg-ink font-medium text-paper"
                      : "text-ink-dim hover:bg-blush hover:text-ink"
                  }`}
                >
                  <span className="shrink-0">{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="rounded-full bg-gold px-1.5 py-0.5 text-[10px] font-semibold text-paper">
                      {item.badge}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>

          <div className="mt-4 border-t border-line pt-3">
            <Link
              href="/"
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-ink-dim transition hover:bg-blush hover:text-ink"
            >
              <span className="shrink-0"><ShopIcon /></span>
              Back to the shop
            </Link>
          </div>
        </nav>

        <div className="absolute inset-x-0 bottom-0 border-t border-line p-3">
          <p className="truncate px-3 text-xs font-medium text-ink">{user?.name}</p>
          <p className="truncate px-3 text-[11px] text-ink-dim">{user?.email}</p>
          <button
            type="button"
            onClick={onSignOut}
            className="mt-2 w-full rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink transition hover:border-clay/40 hover:text-clay"
          >
            End admin session
          </button>
        </div>
      </aside>

      {/* Dimmer for the mobile drawer. */}
      {menuOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-30 bg-ink/20 lg:hidden"
        />
      )}

      {/* ---- main column ---- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-paper-card/95 px-4 backdrop-blur sm:px-6">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            className="rounded-lg border border-line p-1.5 text-ink lg:hidden"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-ink">{title}</h1>
            {subtitle && <p className="truncate text-xs text-ink-dim">{subtitle}</p>}
          </div>

          {actions}
          {secondsLeft !== undefined && <SessionClock secondsLeft={secondsLeft} />}
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

/**
 * Time left on the admin session.
 *
 * Shown because the session is short on purpose. Without a clock the first sign
 * that it ended is a failed action halfway through a moderation decision, with
 * the reason you typed still in the box.
 *
 * The starting value comes from the token's own `exp` — the browser only counts
 * down from it, so the number cannot drift away from what the server enforces.
 */
function SessionClock({ secondsLeft }: { secondsLeft: number }) {
  const [left, setLeft] = useState(secondsLeft);
  const [synced, setSynced] = useState(secondsLeft);

  // Resync when a fresh figure arrives from the server. React's documented way
  // to adjust state on a prop change — an effect for this would render once
  // with the stale number before correcting itself.
  if (synced !== secondsLeft) {
    setSynced(secondsLeft);
    setLeft(secondsLeft);
  }

  // One interval for the component's life. It clamps at zero, so there is no
  // need to tear it down and rebuild it as the value changes.
  useEffect(() => {
    const t = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const mins = Math.floor(left / 60);
  const secs = left % 60;
  const low = left < 5 * 60;

  return (
    <span
      title="Time left on this admin session"
      className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium tabular-nums sm:inline-flex ${
        low ? "border-clay/30 bg-clay/10 text-clay" : "border-line bg-blush text-ink-dim"
      }`}
    >
      <ClockIcon />
      {mins}:{String(secs).padStart(2, "0")}
    </span>
  );
}

/* ---- icons: 16px, 1.6 stroke, so they sit consistently in the rail ---- */

const s = { fill: "none", viewBox: "0 0 20 20", className: "h-4 w-4", "aria-hidden": true } as const;
const stroke = { stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function GridIcon() {
  return (
    <svg {...s}>
      <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" {...stroke} />
      <rect x="11.5" y="2.5" width="6" height="6" rx="1.5" {...stroke} />
      <rect x="2.5" y="11.5" width="6" height="6" rx="1.5" {...stroke} />
      <rect x="11.5" y="11.5" width="6" height="6" rx="1.5" {...stroke} />
    </svg>
  );
}

function BagIcon() {
  return (
    <svg {...s}>
      <path d="M4 6h12l-1 11H5L4 6Z" {...stroke} />
      <path d="M7.5 8V5.5a2.5 2.5 0 0 1 5 0V8" {...stroke} />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg {...s}>
      <circle cx="8" cy="7" r="2.75" {...stroke} />
      <path d="M2.75 16.5a5.25 5.25 0 0 1 10.5 0" {...stroke} />
      <path d="M13.5 5.5a2.5 2.5 0 0 1 0 5M14.5 16.5a5 5 0 0 0-1.2-3.2" {...stroke} />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg {...s}>
      <path d="M3 9.5V3.5h6L17 11l-6 6L3 9.5Z" {...stroke} />
      <circle cx="6.75" cy="6.75" r="1" fill="currentColor" />
    </svg>
  );
}

function FlagIcon() {
  return (
    <svg {...s}>
      <path d="M5 17V3.5m0 0h9l-2 3 2 3H5" {...stroke} />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg {...s}>
      <path d="M17 3.5 8.5 12M17 3.5l-5.5 13-3-4.5-4.5-3z" {...stroke} />
    </svg>
  );
}

function ReturnIcon() {
  return (
    <svg {...s}>
      <path d="M7.5 5.5 4 9l3.5 3.5" {...stroke} />
      <path d="M4 9h8a4 4 0 0 1 0 8H8.5" {...stroke} />
    </svg>
  );
}

function BanknoteIcon() {
  return (
    <svg {...s}>
      <rect x="2.5" y="5.5" width="15" height="9" rx="1.5" {...stroke} />
      <circle cx="10" cy="10" r="2.25" {...stroke} />
    </svg>
  );
}

function ScrollIcon() {
  return (
    <svg {...s}>
      <rect x="3.5" y="2.5" width="13" height="15" rx="2" {...stroke} />
      <path d="M6.75 6.5h6.5M6.75 10h6.5M6.75 13.5h4" {...stroke} />
    </svg>
  );
}

function ShopIcon() {
  return (
    <svg {...s}>
      <path d="M3 7.5 4.5 3.5h11L17 7.5M3 7.5h14M3 7.5v9h14v-9" {...stroke} />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg {...s} className="h-3.5 w-3.5">
      <circle cx="10" cy="10" r="7" {...stroke} />
      <path d="M10 6v4l2.5 2" {...stroke} />
    </svg>
  );
}
