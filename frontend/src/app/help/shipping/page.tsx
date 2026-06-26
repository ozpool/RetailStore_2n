import InfoPage from "@/components/InfoPage";

export default function ShippingPage() {
  return (
    <InfoPage
      eyebrow="Help"
      title="Shipping"
      intro="Every item ships — there's no in-person meetup option, by design."
    >
      <h2>Cost</h2>
      <p>
        Shipping cost is calculated from the item&apos;s actual size and weight, shown
        at checkout before you pay — not a flat rate that overcharges for small
        items and undercharges for furniture.
      </p>

      <h2>Delivery time</h2>
      <p>
        Sellers are expected to ship within 2 business days of a sale. From
        drop-off, most items arrive within 5–10 business days depending on
        distance and size — larger furniture pieces can take longer if they ship
        via freight rather than a standard parcel carrier.
      </p>

      <h2>Tracking</h2>
      <p>
        Every order includes tracking, visible from your order page the moment
        the seller&apos;s label is scanned at drop-off.
      </p>

      <h2>Damaged in transit</h2>
      <p>
        If it arrives damaged, that&apos;s covered under{" "}
        <a href="/help/returns-refunds" className="text-gold-dim underline">
          returns &amp; refunds
        </a>{" "}
        — photograph the damage before you open a return.
      </p>
    </InfoPage>
  );
}
