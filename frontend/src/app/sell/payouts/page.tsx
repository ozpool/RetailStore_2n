import InfoPage from "@/components/InfoPage";

/**
 * The public promise about payouts, and it has to match the code.
 *
 * This page used to say money was released three days after tracking showed
 * delivery. Neither half was true once payouts were built: the hold is seven
 * days (`PAYOUT_HOLD_DAYS`), and it starts when the BUYER marks the item
 * delivered, because nothing here reads a courier's tracking feed. A marketing
 * page that promises a shorter wait than the system enforces is the kind of
 * thing a seller quotes back at you.
 */
export default function PayoutsPage() {
  return (
    <InfoPage
      eyebrow="Selling"
      title="Payouts"
      intro="Your money is held briefly, not indefinitely — here's the actual timeline."
    >
      <h2>Why payment is held</h2>
      <p>
        When an item sells, the buyer pays RetailStore_2n rather than paying you
        directly, and we pass it on afterwards. This protects both sides: the
        buyer isn&apos;t paying into the void, and you&apos;re not shipping
        something on a promise.
      </p>

      <h2>When your money becomes available</h2>
      <p>Both of these have to be true:</p>
      <ul>
        <li>
          The buyer has marked the item delivered. We don&apos;t read courier
          tracking — the buyer confirming it arrived is what starts the clock.
        </li>
        <li>
          Seven days have passed since then, with no refund on that item. That
          window is the return period; once it closes, the money is yours to
          take.
        </li>
      </ul>
      <p>
        Your payouts page shows every line waiting, what it&apos;s worth, and the
        date the next one comes off hold — so the total is never a number you
        have to take on trust.
      </p>

      <h2>How you get paid</h2>
      <p>
        Payouts go to the bank account you connect in your seller settings, and
        you have to verify your identity first — money only goes to someone
        we&apos;ve checked.
      </p>
      <p>
        <strong>You ask for a payout; we don&apos;t send them on a schedule.</strong>{" "}
        There&apos;s no minimum threshold and no waiting for a payout day. A
        single sale can be paid out on its own, as soon as it clears the hold,
        and you can ask as often as you like.
      </p>

      <h2>If a refund happens</h2>
      <p>
        A refunded item is never paid out — that&apos;s most of what the hold is
        for. In the rare case a refund arrives after you&apos;ve already been
        paid, we recover it from the transfer, and if that isn&apos;t possible
        the shortfall comes off your next payout. You&apos;re never invoiced for
        it. See{" "}
        <a href="/help/returns-refunds" className="text-gold-dim underline">
          returns &amp; refunds
        </a>{" "}
        for how that process works.
      </p>
    </InfoPage>
  );
}
