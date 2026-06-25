import InfoPage from "@/components/InfoPage";

/**
 * What a seller is actually charged, which is nothing.
 *
 * This page used to advertise an 8% marketplace commission and worked through
 * an example ending in $88.80 on a $100 sale. No code ever deducted it: a
 * payout transfers the full line total, and the whole argument in ADR 0029 for
 * separate transfers rather than destination charges rests on the platform
 * taking no cut. So the page and the money disagreed by $8 on every sale, and
 * a seller could read the fees page and their payouts page and get two
 * different answers about the same item.
 *
 * Corrected to describe what the system does. The open question — who pays the
 * provider's fees on a platform with no revenue — is recorded in plan 0002
 * rather than answered with an invented number.
 */
export default function SellerFeesPage() {
  return (
    <InfoPage
      eyebrow="Selling"
      title="Seller fees"
      intro="No listing fee, no monthly charge, and no commission on a sale. You receive the full price your item sold for."
    >
      <h2>What&apos;s deducted at sale</h2>
      <p>
        Nothing. Sell something for $100 and you are paid <strong>$100</strong>.
        There is no marketplace commission, and the payment processor&apos;s fee
        is not passed on to you either — RetailStore_2n absorbs it.
      </p>
      <p>
        Your{" "}
        <a href="/seller/payouts" className="text-gold-dim underline">
          payouts page
        </a>{" "}
        lists every item waiting alongside the exact amount you&apos;ll receive
        for it, so the figure is never a total you have to take on trust.
      </p>

      <h2>What&apos;s free</h2>
      <p>
        Listing an item costs nothing, whether it sells or not. Relisting an
        expired listing is also free.
      </p>

      <h2>Why there&apos;s no cut</h2>
      <p>
        RetailStore_2n exists to get repaired things back into use, and a commission
        on a $40 mended bowl is the kind of friction that stops people bothering.
        It also means there is no revenue behind the payment fees — which is a
        real constraint, openly recorded rather than papered over, and one that
        would have to be revisited before this ran at any scale.
      </p>

      <h2>When you get paid</h2>
      <p>
        After the buyer confirms delivery and the return window closes. See{" "}
        <a href="/sell/payouts" className="text-gold-dim underline">
          payouts
        </a>{" "}
        for the timing.
      </p>
    </InfoPage>
  );
}
