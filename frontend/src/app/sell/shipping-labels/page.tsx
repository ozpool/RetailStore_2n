import InfoPage from "@/components/InfoPage";

/**
 * How shipping actually works, which is: you arrange it.
 *
 * This page used to describe a courier integration that does not exist. All
 * four of its claims were false, and one of them contradicted the flow that IS
 * built:
 *
 *   "a prepaid shipping label is generated"      — nothing generates labels
 *   "priced against the weight and dimensions
 *    you gave when you listed the item"          — listings have no such fields
 *   "tracking updates automatically, you don't
 *    need to enter anything manually"            — the seller types the carrier
 *                                                  and tracking number by hand
 *   "the QR code from your order page"           — no QR code outside admin 2FA
 *
 * The third was the worst of them: `POST /seller/sales/:id/ship` takes both
 * fields as optional text precisely so a seller without a trackable service
 * isn't pushed into inventing a number, and this page told them the opposite.
 *
 * Rewritten to describe the real thing. Prepaid labels need a carrier account
 * and a rates API, and are not built.
 */
export default function ShippingLabelsPage() {
  return (
    <InfoPage
      eyebrow="Selling"
      title="Shipping"
      intro="You choose the carrier and pay the postage. Here's what's expected, and what we do with what you tell us."
    >
      <h2>We don&apos;t print labels for you</h2>
      <p>
        There&apos;s no prepaid label and no negotiated courier rate — you post
        the item the way you&apos;d post anything, with whichever service you
        like. Build the postage into your asking price, because the buyer pays
        the price on the listing and nothing is added at checkout.
      </p>
      <p>
        This is the honest version of a feature most marketplaces do have. It
        needs a carrier account and a rates integration, and neither exists
        here.
      </p>

      <h2>Marking something sent</h2>
      <p>
        Open the sale from{" "}
        <a href="/seller/sales" className="text-gold-dim underline">
          your sales
        </a>{" "}
        and mark it shipped. You can add a carrier and tracking number, and both
        are optional — plenty of secondhand items go out by an untracked service,
        and we&apos;d rather you left it blank than invented a number.
      </p>
      <p>
        If you do add tracking, the buyer sees it on their order. We don&apos;t
        poll the carrier, so nothing updates on its own: the buyer confirms the
        item arrived, and that confirmation is what starts your payout clock.
      </p>

      <h2>Packing it</h2>
      <p>
        You&apos;re responsible for packing the item well enough to survive
        transit. For anything fragile — ceramics, glass, framed pieces — that
        means real padding, not a single layer of newspaper. Damage from bad
        packing comes back to you as a refund.
      </p>

      <h2>How quickly</h2>
      <p>
        Within a few days of the sale. If you can&apos;t send something after
        all, mark it as unsendable rather than leaving it — the buyer is
        refunded automatically and immediately, which is a much better outcome
        for them than silence.
      </p>
    </InfoPage>
  );
}
