import InfoPage from "@/components/InfoPage";

/**
 * What actually happens when a buyer wants their money back.
 *
 * This page was the largest untruth in the repository. It is linked from the
 * footer of every page, and every specific claim in it was false: a 14-day
 * window that existed nowhere in the code, a "Start a return" control that did
 * not exist, a prepaid return label with no carrier integration behind it, and
 * a refund triggered by a courier scan we have no way to observe. A buyer whose
 * item arrived broken had no route at all — only emailing support and hoping
 * somebody opened the admin panel.
 *
 * The route exists now (plan 0003), so this describes it. Two things it
 * deliberately does not promise, because they are not built: return labels, and
 * anything that watches a parcel come back.
 *
 * The window is not hardcoded here. It derives from the payout hold — see
 * ADR 0031 — so a page that named a number would go stale the moment an
 * operator changed one. It says "the return window" and the order page shows
 * the actual date.
 */
export default function ReturnsRefundsPage() {
  return (
    <InfoPage
      eyebrow="Help"
      title="Returns & refunds"
      intro="If something arrives wrong, you can ask for your money back from the order itself."
    >
      <h2>How to start one</h2>
      <p>
        Open the order from your account and choose{" "}
        <strong>Start a return</strong> on the item. You&apos;ll be asked what&apos;s
        wrong — the seller reads exactly what you write, so it&apos;s worth being
        specific.
      </p>
      <p>
        The option appears once you&apos;ve confirmed the item arrived, and stays
        available until the return window closes. Your order page shows the exact
        date; if it&apos;s passed, the page says so rather than giving you a
        button that fails.
      </p>

      <h2>What happens next</h2>
      <p>
        The seller answers. If they agree, you&apos;re refunded the full price of
        that item, back to the card you paid with.
      </p>
      <p>
        If they say no, they have to say <em>why</em> — and you&apos;ll see their
        reason. You can then ask us to look at it, and a moderator decides. That
        decision is final.
      </p>
      <p>
        Changed your mind about asking? You can withdraw a return any time before
        the seller has answered it.
      </p>

      <h2>Sending the item back</h2>
      <p>
        Arrange that with the seller directly. We don&apos;t generate return
        labels and we don&apos;t track the parcel — the refund is issued when the
        seller or a moderator approves the return, not when something is scanned
        somewhere.
      </p>
      <p>
        This is the honest version. Prepaid return labels need a carrier account
        we don&apos;t have, and promising a scan-triggered refund we can&apos;t
        observe would be worse than saying so.
      </p>

      <h2>Refund timing</h2>
      <p>
        The refund is sent to your payment provider as soon as the return is
        approved. How long it takes to appear on your statement is up to your
        bank — usually a few working days.
      </p>

      <h2>When a seller can&apos;t send something at all</h2>
      <p>
        That&apos;s a different path and you don&apos;t have to do anything. If a
        seller marks an item as unsendable, you&apos;re refunded automatically
        and told straight away.
      </p>
    </InfoPage>
  );
}
