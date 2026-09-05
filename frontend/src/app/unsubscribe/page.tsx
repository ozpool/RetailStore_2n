import { Suspense } from "react";
import type { Metadata } from "next";
import UnsubscribeClient from "./UnsubscribeClient";

/**
 * NOINDEX. These URLs carry a token that identifies an account, and a search
 * engine that crawled one would publish it. Nothing links here from the site.
 */
export const metadata: Metadata = {
  title: "Unsubscribe · RetailStore_2n",
  robots: { index: false, follow: false },
};

/**
 * No Nav and no Footer, deliberately.
 *
 * Everything in the site chrome is a link somewhere else, and this page has one
 * job for somebody who arrived from their inbox slightly annoyed. Giving them a
 * shop to browse instead of a button to press is how the button gets missed.
 */
export default function UnsubscribePage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-md px-6 py-20">
          <p className="mb-8 text-lg font-semibold tracking-tight">RetailStore_2n</p>
          <p className="text-sm text-neutral-500">Checking that link…</p>
        </div>
      }
    >
      <UnsubscribeClient />
    </Suspense>
  );
}
