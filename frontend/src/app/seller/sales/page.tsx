"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { ApiError } from "@/lib/api";
import SellerReturns from "@/components/SellerReturns";
import { useAuth } from "@/lib/AuthContext";
import { countryName } from "@/lib/addressesApi";
import { formatPrice } from "@/lib/catalog";
import {
  FULFILMENT_LABEL,
  getSales,
  markCannotSend,
  markShipped,
  type Sale,
  type SalesSummary,
} from "@/lib/salesApi";

type Filter = "to_send" | "sent" | "all";

const TABS: { key: Filter; label: string }[] = [
  { key: "to_send", label: "Needs sending" },
  { key: "sent", label: "Sent" },
  { key: "all", label: "All sales" },
];

/**
 * What a seller has sold.
 *
 * This page is the answer to the most obvious hole in the site: someone could
 * buy your chair and you would never be told, never see it, and never be able
 * to act on it. Defaults to "needs sending", because that is the only tab with
 * anything to do in it.
 */
export default function SalesPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const [filter, setFilter] = useState<Filter>("to_send");
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [summary, setSummary] = useState<SalesSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
    if (!loading && user && !user.isSeller) router.push("/seller");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const data = await getSales(filter);
      setSales(data.sales);
      setSummary(data.summary);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your sales.");
      setSales([]);
    }
  }, [filter]);

  useEffect(() => {
    if (user?.isSeller) load();
  }, [user?.isSeller, load]);

  if (loading || !user) {
    return <Shell><p className="text-sm text-ink-dim">Loading…</p></Shell>;
  }

  const list = sales ?? [];

  return (
    <Shell>
      <Link href="/seller" className="text-sm text-ink-dim transition hover:text-gold-dim">
        ← Your listings
      </Link>

      <h1 className="mt-4 font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        Sales
      </h1>
      <p className="mt-3 max-w-2xl text-sm text-ink-dim">
        Everything someone has bought from you. A sale appears here once it&apos;s
        paid for — never before, so you&apos;re not packing parcels for checkouts
        that get abandoned.
      </p>

      {summary && (
        <dl className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Needs sending" value={String(summary.toSend)} highlight={summary.toSend > 0} />
          <Stat label="Sent" value={String(summary.shipped)} />
          <Stat label="Delivered" value={String(summary.delivered)} />
          <Stat
            label="Sold, gross"
            value={formatPrice(summary.grossCents, "USD")}
            /* "Gross" on purpose. There is no payout pipeline, so calling this
               earnings would imply money is waiting somewhere for them. */
            note={
              summary.refunded > 0
                ? `before fees · ${summary.refunded} refunded ${
                    summary.refunded === 1 ? "sale" : "sales"
                  } excluded`
                : "before fees · no payouts yet"
            }
          />
        </dl>
      )}

      {/**
       * Only when there is something to explain.
       *
       * The figure above is net of refunds, which is correct — but it means the
       * rows below can add up to more than it does, and with nothing on screen
       * saying why, that reads as the page being wrong rather than as the money
       * having gone back. A permanent zero-state row would be noise for the
       * sellers who have never had one.
       */}
      {summary && summary.refunded > 0 && (
        <p className="mt-4 text-sm text-ink-dim">
          {summary.refunded === 1
            ? "One sale was refunded and is not counted in the total above."
            : `${summary.refunded} sales were refunded and are not counted in the total above.`}{" "}
          They are still listed, marked <span className="text-clay">Refunded</span>.
        </p>
      )}

      {error && (
        <p className="mt-6 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      )}

      {/*
        Above the sales list on purpose. An unanswered return is somebody
        waiting on a decision about their money, which outranks an unsent
        parcel — and it renders nothing at all when there are none.
      */}
      <SellerReturns />

      <div className="mt-8 flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setFilter(tab.key)}
            className={`rounded-full px-4 py-2 text-sm transition ${
              filter === tab.key
                ? "bg-gold-dim font-semibold text-paper"
                : "border border-line text-ink hover:border-gold/40"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {sales === null ? (
        <p className="mt-10 text-sm text-ink-dim">Loading…</p>
      ) : list.length === 0 ? (
        <div className="mt-8 border border-line bg-blush p-10 text-center">
          <p className="text-ink">
            {filter === "to_send"
              ? "Nothing waiting to be sent"
              : filter === "sent"
                ? "Nothing sent yet"
                : "No sales yet"}
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-dim">
            {filter === "to_send"
              ? "When someone buys something from you, it'll appear here with their address."
              : "Sales show up once they're paid for."}
          </p>
          <Link
            href="/seller"
            className="mt-6 inline-block rounded bg-gold-dim px-6 py-3 text-sm font-medium text-paper transition hover:brightness-95"
          >
            Your listings
          </Link>
        </div>
      ) : (
        <ul className="mt-8 grid gap-4">
          {list.map((sale) => (
            <SaleCard key={sale.id} sale={sale} onChanged={load} />
          ))}
        </ul>
      )}
    </Shell>
  );
}

function SaleCard({ sale, onChanged }: { sale: Sale; onChanged: () => void }) {
  const [shipping, setShipping] = useState(false);
  const [cannotSend, setCannotSend] = useState(false);
  const [carrier, setCarrier] = useState(sale.carrier ?? "");
  const [tracking, setTracking] = useState(sale.trackingNumber ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const field =
    "mt-1 w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-gold/50 disabled:opacity-60";

  async function ship() {
    setError(null);
    setBusy(true);
    try {
      await markShipped(sale.id, { carrier: carrier || null, trackingNumber: tracking || null });
      setShipping(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't mark that as sent.");
    } finally {
      setBusy(false);
    }
  }

  async function declare() {
    setError(null);
    setBusy(true);
    try {
      const res = await markCannotSend(sale.id, reason);
      setCannotSend(false);
      setNotice(res.note);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update that sale.");
    } finally {
      setBusy(false);
    }
  }

  const tone =
    sale.fulfilment === "DELIVERED"
      ? "border-sage/60 text-ink"
      : sale.fulfilment === "SHIPPED"
        ? "border-gold/40 text-gold-dim"
        : sale.fulfilment === "UNFULFILLABLE"
          ? "border-clay/40 text-clay"
          : "border-line text-ink-dim";

  return (
    <li className="rounded-2xl border border-line bg-paper-card p-5">
      <div className="flex flex-wrap items-start gap-5">
        {sale.image ? (
          <span className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-line">
            <Image src={sale.image} alt={sale.title} fill sizes="80px" className="object-cover" />
          </span>
        ) : (
          <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl border border-line bg-blush text-[10px] text-ink-dim">
            No photo
          </span>
        )}

        <div className="min-w-56 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            {sale.slug ? (
              <Link
                href={`/listing/${sale.slug}`}
                className="text-sm font-medium text-ink transition hover:text-gold-dim"
              >
                {sale.title}
              </Link>
            ) : (
              <span className="text-sm font-medium text-ink">{sale.title}</span>
            )}
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}>
              {FULFILMENT_LABEL[sale.fulfilment]}
            </span>

            {/**
             * A SECOND badge, beside the fulfilment one rather than replacing it.
             *
             * Both facts are true at once and neither implies the other: a line
             * can be DELIVERED and refunded, if a moderator settled a dispute
             * after it arrived. Collapsing them into one badge would have to
             * pick which fact to hide.
             */}
            {sale.refunded && (
              <span className="rounded-full border border-clay/50 bg-clay/10 px-2.5 py-0.5 text-xs font-medium text-clay">
                Refunded
              </span>
            )}
          </div>

          <p className="mt-1 text-sm text-gold-dim">
            {/* Struck through when the money went back: the number is still the
                price that was paid, and it is no longer a number the seller has.
                Showing it plain is how a row disagrees with the total above it. */}
            <span className={sale.refunded ? "line-through opacity-60" : undefined}>
              {formatPrice(sale.unitPriceCents, sale.currency)}
              {sale.quantity > 1 && ` × ${sale.quantity}`}
            </span>
            {sale.refunded && (
              <span className="ml-2 text-xs text-ink-dim">returned to the buyer</span>
            )}
          </p>
          <p className="mt-1 text-xs text-ink-dim">
            {sale.order.reference} · bought by {sale.order.buyerName}
            {sale.order.paidAt && ` · paid ${new Date(sale.order.paidAt).toLocaleDateString()}`}
          </p>

          {sale.trackingNumber && (
            <p className="mt-1.5 text-xs text-ink-dim">
              {sale.carrier ? `${sale.carrier} · ` : ""}
              <span className="font-mono">{sale.trackingNumber}</span>
            </p>
          )}

          {sale.fulfilment === "UNFULFILLABLE" && sale.fulfilmentNote && (
            <p className="mt-2 rounded-xl border border-clay/30 bg-clay/10 px-3 py-2 text-xs text-clay">
              You told the buyer: {sale.fulfilmentNote}
            </p>
          )}
        </div>

        {/* The address, released only because this order is paid. */}
        {sale.shipTo && (
          <div className="min-w-48 rounded-xl border border-line bg-paper p-3">
            <p className="text-xs font-semibold text-ink">Send to</p>
            <address className="mt-1 text-xs not-italic text-ink-dim">
              {sale.shipTo.fullName && <>{sale.shipTo.fullName}<br /></>}
              {sale.shipTo.line1}
              {sale.shipTo.line2 && <><br />{sale.shipTo.line2}</>}
              {sale.shipTo.city && <><br />{sale.shipTo.city}{sale.shipTo.region ? `, ${sale.shipTo.region}` : ""}</>}
              {sale.shipTo.postcode && <><br />{sale.shipTo.postcode}</>}
              {sale.shipTo.country && <><br />{countryName(sale.shipTo.country)}</>}
              {sale.shipTo.phone && <><br />{sale.shipTo.phone}</>}
            </address>
          </div>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-clay">{error}</p>}
      {notice && (
        <p className="mt-3 rounded-xl border border-gold/30 bg-gold/5 px-3 py-2 text-xs text-ink">
          {notice}
        </p>
      )}

      {/* ---- actions ---- */}
      {sale.fulfilment !== "DELIVERED" && (
        <div className="mt-4 border-t border-line pt-4">
          {shipping ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor={`carrier-${sale.id}`} className="block text-xs text-ink-dim">
                  Carrier <span className="font-normal">— optional</span>
                </label>
                <input
                  id={`carrier-${sale.id}`}
                  value={carrier}
                  onChange={(e) => setCarrier(e.target.value)}
                  disabled={busy}
                  placeholder="Royal Mail"
                  className={field}
                />
              </div>
              <div>
                <label htmlFor={`tracking-${sale.id}`} className="block text-xs text-ink-dim">
                  Tracking number <span className="font-normal">— optional</span>
                </label>
                <input
                  id={`tracking-${sale.id}`}
                  value={tracking}
                  onChange={(e) => setTracking(e.target.value)}
                  disabled={busy}
                  className={`${field} font-mono`}
                />
              </div>
              <p className="text-xs text-ink-dim sm:col-span-2">
                Both optional — plenty of secondhand things get handed over in
                person or posted without tracking.
              </p>
              <div className="flex flex-wrap gap-3 sm:col-span-2">
                <button
                  type="button"
                  onClick={ship}
                  disabled={busy}
                  className="rounded bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-95 disabled:opacity-60"
                >
                  {busy ? "Saving…" : sale.fulfilment === "SHIPPED" ? "Update tracking" : "Mark as sent"}
                </button>
                <button
                  type="button"
                  onClick={() => setShipping(false)}
                  disabled={busy}
                  className="rounded border border-line px-5 py-2.5 text-sm text-ink transition hover:border-gold/40 disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : cannotSend ? (
            <div>
              <label htmlFor={`reason-${sale.id}`} className="block text-xs text-ink-dim">
                Why can&apos;t you send it? The buyer sees this.
              </label>
              <textarea
                id={`reason-${sale.id}`}
                value={reason}
                onChange={(e) => setReason(e.target.value.slice(0, 500))}
                rows={2}
                disabled={busy}
                placeholder="It broke while I was packing it, sorry."
                className={field}
              />
              <p className="mt-2 text-xs text-ink-dim">
                They&apos;ve already paid, and refunds aren&apos;t automated yet —
                so you&apos;ll need to settle it with them directly.
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={declare}
                  disabled={busy || !reason.trim()}
                  className="rounded border border-clay/40 px-5 py-2.5 text-sm font-medium text-clay transition hover:bg-clay/10 disabled:opacity-50"
                >
                  {busy ? "Saving…" : "Confirm"}
                </button>
                <button
                  type="button"
                  onClick={() => setCannotSend(false)}
                  disabled={busy}
                  className="rounded border border-line px-5 py-2.5 text-sm text-ink transition hover:border-gold/40 disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => setShipping(true)}
                className="rounded bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-95"
              >
                {sale.fulfilment === "SHIPPED" ? "Update tracking" : "Mark as sent"}
              </button>
              {sale.fulfilment === "UNFULFILLED" && (
                <button
                  type="button"
                  onClick={() => setCannotSend(true)}
                  className="rounded border border-line px-5 py-2.5 text-sm text-ink-dim transition hover:border-clay/40 hover:text-clay"
                >
                  Can&apos;t send it
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Stat({
  label,
  value,
  note,
  highlight,
}: {
  label: string;
  value: string;
  note?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-4 ${
        highlight ? "border-gold/40 bg-gold/5" : "border-line bg-paper-card"
      }`}
    >
      <dt className="text-xs text-ink-dim">{label}</dt>
      <dd className="mt-1 font-serif text-2xl font-semibold text-ink">{value}</dd>
      {note && <p className="mt-0.5 text-[11px] text-ink-dim">{note}</p>}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
      <Footer />
    </>
  );
}
