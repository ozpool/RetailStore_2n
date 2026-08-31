import Link from "next/link";
import { countryName } from "@/lib/addressesApi";
import type { ShipTo } from "@/lib/ordersApi";

/**
 * Where an order was sent.
 *
 * Reads from the order's own snapshot, never from the address book — which is
 * why editing an address later cannot change what this shows. The wording says
 * so, because "why does my old order show my old address?" is otherwise a
 * reasonable thing to be confused by.
 */
export default function ShipToCard({
  shipTo,
  title = "Delivering to",
  changeHref,
}: {
  shipTo: ShipTo | null;
  title?: string;
  /** Shown while the order can still be changed. */
  changeHref?: string;
}) {
  if (!shipTo) {
    return (
      <div className="rounded-2xl border border-line bg-paper-card p-5">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <p className="mt-2 text-sm text-ink-dim">
          No address recorded. This order was placed before addresses existed.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-line bg-paper-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink">{title}</p>
        {changeHref && (
          <Link href={changeHref} className="text-xs text-gold-dim underline">
            Change
          </Link>
        )}
      </div>

      <address className="mt-2 text-sm not-italic text-ink-dim">
        {shipTo.fullName && <>{shipTo.fullName}<br /></>}
        {shipTo.line1}
        {shipTo.line2 && <><br />{shipTo.line2}</>}
        {shipTo.city && <><br />{shipTo.city}{shipTo.region ? `, ${shipTo.region}` : ""}</>}
        {shipTo.postcode && <><br />{shipTo.postcode}</>}
        {shipTo.country && <><br />{countryName(shipTo.country)}</>}
        {shipTo.phone && <><br />{shipTo.phone}</>}
      </address>
    </div>
  );
}
