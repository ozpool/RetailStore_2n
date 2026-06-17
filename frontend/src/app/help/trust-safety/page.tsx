import InfoPage from "@/components/InfoPage";

export default function TrustSafetyPage() {
  return (
    <InfoPage
      eyebrow="Help"
      title="Trust & safety"
      intro="A few concrete things, not just a promise that we 'take this seriously.'"
    >
      <h2>Listings are checked, not just posted</h2>
      <p>
        Photos and descriptions are reviewed before a listing goes live. It&apos;s not
        a guarantee against every possible misrepresentation, but it catches the
        obvious ones.
      </p>

      <h2>Payment is held, not handed over</h2>
      <p>
        A buyer pays RetailStore_2n rather than the seller, and we hold it until they
        confirm the item arrived as described and the return window has closed.
        It isn&apos;t a legal escrow account — it&apos;s our balance, and we pass
        it on. Sellers aren&apos;t paid up front, and buyers aren&apos;t paying
        into a void — see{" "}
        <a href="/sell/payouts" className="text-gold-dim underline">
          payouts
        </a>{" "}
        for the exact timing.
      </p>

      <h2>Everything ships — no in-person meetups</h2>
      <p>
        There&apos;s no option to arrange a local pickup or cash handoff. Every
        transaction goes through the platform, with tracking and a return
        window, on purpose.
      </p>

      <h2>Reporting a problem</h2>
      <p>
        If a listing looks off — stolen goods, counterfeit items, a seller asking
        to take payment outside the platform — report it from the listing page
        or{" "}
        <a href="/help/contact" className="text-gold-dim underline">
          contact us
        </a>{" "}
        directly. Reports are reviewed by a person, not just auto-closed.
      </p>
    </InfoPage>
  );
}
