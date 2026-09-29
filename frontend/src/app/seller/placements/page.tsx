"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import { formatPrice } from "@/lib/catalog";
import {
  SLOT_LABEL,
  STATUS_LABEL,
  acceptCounter,
  getPlacements,
  getSlots,
  requestPlacement,
  withdrawPlacement,
  type Placement,
  type PlacementSlot,
  type SlotInfo,
} from "@/lib/messagingApi";
import { getSellerListings, type SellerListing } from "@/lib/sellerApi";

function day(iso: string | null) {
  return iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "—";
}

/** Whether the seller still has a move to make on a request. */
function sellerActions(p: Placement) {
  return {
    canAccept: p.status === "COUNTERED",
    canWithdraw: p.status === "REQUESTED" || p.status === "COUNTERED" || p.status === "AGREED",
  };
}

export default function SellerPlacementsPage() {
  const { user, loading: authLoading } = useAuth();
  const [placements, setPlacements] = useState<Placement[] | null>(null);
  const [listings, setListings] = useState<SellerListing[]>([]);
  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [disclosure, setDisclosure] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [listingId, setListingId] = useState("");
  const [slot, setSlot] = useState<PlacementSlot>("HERO");
  const [offer, setOffer] = useState("40");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [note, setNote] = useState("");


  /** See the note in admin/placements: the fetch lives in the effect so no
   *  effect depends on a callback that setStates. */
  const [reloads, setReloads] = useState(0);
  const reload = () => setReloads((n) => n + 1);

  useEffect(() => {
    if (!user?.isSeller) return;
    let alive = true;
    Promise.all([getPlacements(), getSlots(), getSellerListings()])
      .then(([mine, meta, catalogue]) => {
        if (!alive) return;
        setPlacements(mine.placements);
        setSlots(meta.slots);
        setDisclosure(meta.disclosure);
        setListings(catalogue.listings.filter((l: SellerListing) => l.status === "ACTIVE"));
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof ApiError ? err.message : "Could not load your placements.");
        setPlacements([]);
      });
    return () => {
      alive = false;
    };
  }, [user, reloads]);

  if (authLoading) return null;

  if (!user?.isSeller) {
    return (
      <>
        <Nav />
        <main className="flex-1 px-6 py-20 text-center">
          <h1 className="font-serif text-3xl font-semibold">Homepage placement</h1>
          <p className="mt-4 text-ink-dim">Start selling to ask about the homepage.</p>
        </main>
        <Footer />
      </>
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const cents = Math.round(Number(offer) * 100);
      await requestPlacement({
        listingId,
        slot,
        offeredCents: cents,
        startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
        endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
        note,
      });
      setListingId("");
      setNote("");
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send that request.");
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-5xl">
          <p className="text-xs tracking-widest text-ink-dim uppercase">Seller</p>
          <h1 className="mt-2 font-serif text-3xl font-semibold">Homepage placement</h1>
          <p className="mt-1 text-sm text-ink-dim">
            Ask to appear on the homepage. We will reply with terms you can accept or turn down.
          </p>

          {/*
            THE DISCLOSURE, SHOWN BEFORE THE FORM.
            It comes from the API rather than being written here, so a seller
            cannot be shown a version of this page that omits it. ADR 0034.
          */}
          {disclosure && (
            <p className="mt-4 rounded border border-ink bg-blush px-4 py-3 text-sm">
              <strong>{disclosure}</strong>
            </p>
          )}

          {error && <p className="mt-6 text-sm text-clay">{error}</p>}

          <section className="mt-8 rounded border border-line p-6">
            <h2 className="font-serif text-xl font-semibold">Make a request</h2>
            {listings.length === 0 ? (
              <p className="mt-3 text-sm text-ink-dim">
                You need a published listing first.{" "}
                {/* `/seller`, not `/seller/listings` — the latter has no page,
                    only `[id]` and `new`. Next prefetches Link targets, so the
                    dead link showed up as a 404 in the browser suite's
                    failed-request check rather than as a broken click. */}
                <Link href="/seller" className="text-clay underline">
                  Your listings
                </Link>
              </p>
            ) : (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  Listing
                  <select
                    value={listingId}
                    onChange={(e) => setListingId(e.target.value)}
                    className="rounded border border-line bg-paper px-3 py-2"
                  >
                    <option value="">Pick one…</option>
                    {listings.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.title}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  Slot
                  <select
                    value={slot}
                    onChange={(e) => setSlot(e.target.value as PlacementSlot)}
                    className="rounded border border-line bg-paper px-3 py-2"
                  >
                    {slots.map((s) => (
                      <option key={s.slot} value={s.slot}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  Your offer (USD)
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={offer}
                    onChange={(e) => setOffer(e.target.value)}
                    className="rounded border border-line bg-paper px-3 py-2"
                  />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1 text-sm">
                    From
                    <input
                      type="date"
                      value={startsAt}
                      onChange={(e) => setStartsAt(e.target.value)}
                      className="rounded border border-line bg-paper px-3 py-2"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    Until
                    <input
                      type="date"
                      value={endsAt}
                      onChange={(e) => setEndsAt(e.target.value)}
                      className="rounded border border-line bg-paper px-3 py-2"
                    />
                  </label>
                </div>

                <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                  Why this one
                  <textarea
                    rows={3}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Tell us a little about the piece — at least a sentence."
                    className="rounded border border-line bg-paper px-3 py-2"
                  />
                </label>

                <div className="sm:col-span-2">
                  <button
                    type="button"
                    disabled={busy || !listingId || note.trim().length < 10}
                    onClick={() => void submit()}
                    className="rounded bg-clay px-5 py-2 text-sm font-medium text-paper disabled:opacity-50"
                  >
                    {busy ? "Sending…" : "Send request"}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="mt-10">
            <h2 className="font-serif text-xl font-semibold">Your requests</h2>
            {placements === null && <p className="mt-3 text-sm text-ink-dim">Loading…</p>}
            {placements?.length === 0 && (
              <p className="mt-3 rounded border border-line bg-blush px-4 py-6 text-sm text-ink-dim">
                Nothing yet.
              </p>
            )}
            <div className="mt-4 flex flex-col gap-3">
              {placements?.map((p) => {
                const actions = sellerActions(p);
                return (
                  <article key={p.id} className="rounded border border-line p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{p.listing.title}</p>
                        <p className="mt-1 text-sm text-ink-dim">
                          {SLOT_LABEL[p.slot]} · {day(p.startsAt)} to {day(p.endsAt)}
                        </p>
                      </div>
                      <p className="text-sm">{STATUS_LABEL[p.status]}</p>
                    </div>

                    <dl className="mt-3 flex flex-wrap gap-6 text-sm">
                      <div>
                        <dt className="text-xs text-ink-dim uppercase">You offered</dt>
                        <dd>{formatPrice(p.offeredCents, "USD")}</dd>
                      </div>
                      {p.agreedCents !== null && (
                        <div>
                          <dt className="text-xs text-ink-dim uppercase">
                            {p.status === "COUNTERED" ? "They propose" : "Agreed"}
                          </dt>
                          <dd>{formatPrice(p.agreedCents, "USD")}</dd>
                        </div>
                      )}
                    </dl>

                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <Link
                        href="/seller/messages"
                        className="text-sm text-clay underline"
                      >
                        Read the conversation
                      </Link>
                      {actions.canAccept && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void act(() => acceptCounter(p.id))}
                          className="rounded bg-ink px-4 py-2 text-sm font-medium text-paper disabled:opacity-50"
                        >
                          Accept these terms
                        </button>
                      )}
                      {actions.canWithdraw && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void act(() => withdrawPlacement(p.id))}
                          className="rounded border border-line px-4 py-2 text-sm disabled:opacity-50"
                        >
                          Withdraw
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
