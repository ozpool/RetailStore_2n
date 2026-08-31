"use client";

import Link from "next/link";

/**
 * The small shared pieces every admin screen is built from.
 *
 * Kept together because consistency is most of what makes a dashboard readable:
 * a status pill that is amber on one screen and grey on another costs the
 * reader a second every time, and a dashboard is read hundreds of times a day.
 */

/* ---- money ---- */

/**
 * Cents to a display string.
 *
 * Money is integer minor units everywhere in this codebase — see the schema
 * comment on Order.subtotalCents. It is divided for display only, here, at the
 * last possible moment.
 */
export function money(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function shortDate(iso: string | Date | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fullDate(iso: string | Date | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/* ---- status ---- */

type Tone = "good" | "warn" | "bad" | "neutral" | "info";

const TONES: Record<Tone, string> = {
  good: "border-sage-dim/30 bg-sage-dim/10 text-sage-dim",
  warn: "border-star/40 bg-star/10 text-[#8a5a00]",
  bad: "border-clay/30 bg-clay/10 text-clay",
  info: "border-gold/30 bg-gold/10 text-gold-dim",
  neutral: "border-line bg-blush text-ink-dim",
};

export function Pill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: Tone }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

const ORDER_TONE: Record<string, Tone> = {
  PAID: "good",
  PROCESSING: "info",
  PENDING_PAYMENT: "warn",
  FAILED: "bad",
  CANCELLED: "neutral",
  // Neutral, not bad. A refund is a completed outcome, not a fault — money came
  // in and went back out, and colouring it red reads as something went wrong.
  REFUNDED: "neutral",
};

const ORDER_LABEL: Record<string, string> = {
  PAID: "Paid",
  PROCESSING: "Processing",
  PENDING_PAYMENT: "Awaiting payment",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
};

export function OrderStatusPill({ status }: { status: string }) {
  return <Pill tone={ORDER_TONE[status] ?? "neutral"}>{ORDER_LABEL[status] ?? status}</Pill>;
}

const LISTING_TONE: Record<string, Tone> = {
  ACTIVE: "good",
  DRAFT: "neutral",
  RESERVED: "info",
  SOLD: "neutral",
  REMOVED: "bad",
};

export function ListingStatusPill({ status, removed }: { status: string; removed?: boolean }) {
  if (removed) return <Pill tone="bad">Removed</Pill>;
  return <Pill tone={LISTING_TONE[status] ?? "neutral"}>{status[0] + status.slice(1).toLowerCase()}</Pill>;
}

const FULFIL_TONE: Record<string, Tone> = {
  UNFULFILLED: "warn",
  SHIPPED: "info",
  DELIVERED: "good",
  UNFULFILLABLE: "bad",
};

const FULFIL_LABEL: Record<string, string> = {
  UNFULFILLED: "Not sent",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  UNFULFILLABLE: "Can't send",
};

export function FulfilmentPill({ status }: { status: string }) {
  return <Pill tone={FULFIL_TONE[status] ?? "neutral"}>{FULFIL_LABEL[status] ?? status}</Pill>;
}

/* ---- layout ---- */

export function Card({
  children,
  className = "",
  title,
  action,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
  action?: React.ReactNode;
}) {
  return (
    <section className={`rounded-xl border border-line bg-paper-card ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="px-5 py-14 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {body && <p className="mx-auto mt-1.5 max-w-sm text-sm text-ink-dim">{body}</p>}
    </div>
  );
}

/* ---- tables ---- */

/**
 * Tables scroll inside their own container.
 *
 * Without the wrapper a wide table makes the whole page scroll sideways, which
 * drags the sidebar off screen — the one thing that should never move.
 */
export function TableWrap({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}

export function Th({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-dim ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 align-middle text-sm text-ink ${className}`}>{children}</td>;
}

export function Tr({
  children,
  href,
}: {
  children: React.ReactNode;
  href?: string;
}) {
  // A whole-row link is not expressible in HTML, so the row gets the hover and
  // the first cell carries the actual anchor. Keeps the row keyboard-reachable
  // instead of relying on an onClick nobody can tab to.
  return (
    <tr className={`border-t border-line ${href ? "transition hover:bg-blush" : ""}`}>
      {children}
    </tr>
  );
}

export function RowLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="font-medium text-ink underline-offset-2 hover:text-gold-dim hover:underline">
      {children}
    </Link>
  );
}

/* ---- pagination ---- */

export function Pagination({
  page,
  pages,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  onPage: (p: number) => void;
}) {
  if (total === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
      <p className="text-xs text-ink-dim">
        {first.toLocaleString()}–{last.toLocaleString()} of {total.toLocaleString()}
      </p>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPage(page - 1)}
            disabled={page <= 1}
            className="rounded border border-line px-3 py-1.5 text-xs font-medium text-ink transition hover:border-gold/40 disabled:opacity-40 disabled:hover:border-line"
          >
            Previous
          </button>
          <span className="text-xs text-ink-dim">
            {page} / {pages}
          </span>
          <button
            type="button"
            onClick={() => onPage(page + 1)}
            disabled={page >= pages}
            className="rounded border border-line px-3 py-1.5 text-xs font-medium text-ink transition hover:border-gold/40 disabled:opacity-40 disabled:hover:border-line"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

/* ---- filters ---- */

export function Tabs<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ key: T; label: string; count?: number }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
            value === o.key
              ? "bg-ink text-paper"
              : "border border-line text-ink-dim hover:border-gold/40 hover:text-ink"
          }`}
        >
          {o.label}
          {o.count !== undefined && o.count > 0 && ` (${o.count})`}
        </button>
      ))}
    </div>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative w-full sm:w-72">
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-dim"
      >
        <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
        <path d="m13.5 13.5 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-line bg-paper py-2 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-ink-dim/70 focus:border-gold/50"
      />
    </div>
  );
}
