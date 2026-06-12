"use client";

import { useEffect } from "react";

/**
 * Scrolls to the top when a link points at the page you're already on.
 *
 * Next handles real navigations correctly — it resets scroll for you. But when
 * the target URL is identical to the current one it does nothing at all, so
 * clicking "Home" while already on the homepage leaves the page sitting
 * wherever it was scrolled. That reads as a broken link.
 *
 * Mounted once in the root layout, listening at the document level, so it
 * covers the header, footer, breadcrumbs, and anything added later without
 * each link having to remember.
 */
export default function SamePageLinkScroll() {
  useEffect(() => {
    function onClick(event: MouseEvent) {
      // Leave modified clicks alone — they open tabs or windows.
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      // In-page anchors already jump where they should.
      if (!href || href.startsWith("#") || anchor.target === "_blank") return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // A hash on the destination means the author wants a specific position.
      if (url.hash) return;

      const destination = url.pathname + url.search;
      const current = window.location.pathname + window.location.search;

      if (destination === current) {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    }

    // Capture phase, deliberately. Next's <Link> calls preventDefault() on the
    // anchor to take over routing, so a bubble-phase listener on document would
    // only ever see an already-defaultPrevented event and could not tell a real
    // click from a cancelled one.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return null;
}
