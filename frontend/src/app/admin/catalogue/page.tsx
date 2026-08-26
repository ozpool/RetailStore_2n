"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import AdminGate, { useAdminGate } from "@/components/admin/AdminGate";
import {
  Card,
  EmptyState,
  ListingStatusPill,
  Pagination,
  SearchBox,
  TableWrap,
  Tabs,
  Td,
  Th,
  Tr,
  money,
  shortDate,
} from "@/components/admin/ui";
import { ApiError } from "@/lib/api";
import {
  getCatalogue,
  removeListing,
  restoreListing,
  type ListingRow,
  type Paged,
} from "@/lib/adminApi";
import { useDebounced } from "@/lib/useDebounced";

type Status = "ALL" | "ACTIVE" | "DRAFT" | "RESERVED" | "SOLD" | "REMOVED";

export default function AdminCataloguePage() {
  return (
    <AdminGate title="Catalogue" subtitle="Every listing on the shop">
      {() => <Catalogue />}
    </AdminGate>
  );
}

function Catalogue() {
  const { handleError } = useAdminGate();
  const [status, setStatus] = useState<Status>("ALL");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<ListingRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<ListingRow | null>(null);

  const search = useDebounced(q, 300);

  const load = useCallback(async () => {
    try {
      setData(await getCatalogue({ q: search, status, page }));
      setError(null);
    } catch (err) {
      handleError(err);
      setError("Couldn't load the catalogue.");
    }
  }, [search, status, page, handleError]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [search, status]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs<Status>
          value={status}
          onChange={setStatus}
          options={[
            { key: "ALL", label: "All" },
            { key: "ACTIVE", label: "Live" },
            { key: "DRAFT", label: "Draft" },
            { key: "RESERVED", label: "Held" },
            { key: "SOLD", label: "Sold" },
            { key: "REMOVED", label: "Removed" },
          ]}
        />
        <SearchBox value={q} onChange={setQ} placeholder="Title or shop name" />
      </div>

      {error && (
        <p className="rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">{error}</p>
      )}

      <Card>
        {!data ? (
          <p className="px-5 py-14 text-center text-sm text-ink-dim">Loading…</p>
        ) : data.rows.length === 0 ? (
          <EmptyState title="Nothing matches" body="Try a different search or filter." />
        ) : (
          <>
            <TableWrap>
              <table className="w-full">
                <thead>
                  <tr className="bg-blush">
                    <Th>Item</Th>
                    <Th>Seller</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Price</Th>
                    <Th className="text-right">Stock</Th>
                    <Th className="text-right">Sold</Th>
                    <Th>Listed</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((l) => (
                    <Tr key={l.id}>
                      <Td>
                        <span className="flex items-center gap-3">
                          {l.image ? (
                            <Image
                              src={l.image}
                              alt=""
                              width={36}
                              height={36}
                              className="h-9 w-9 shrink-0 rounded object-cover"
                              unoptimized
                            />
                          ) : (
                            <span className="h-9 w-9 shrink-0 rounded bg-blush" />
                          )}
                          <span className="min-w-0">
                            <Link
                              href={`/listing/${l.slug}`}
                              className="block max-w-64 truncate font-medium text-ink hover:text-gold-dim hover:underline"
                            >
                              {l.title}
                            </Link>
                            <span className="block text-xs text-ink-dim">{l.category}</span>
                          </span>
                        </span>
                      </Td>
                      <Td>
                        <Link
                          href={`/admin/customers/${l.sellerUserId}`}
                          className="block max-w-40 truncate text-ink-dim hover:text-gold-dim hover:underline"
                        >
                          {l.sellerName}
                        </Link>
                      </Td>
                      <Td><ListingStatusPill status={l.status} removed={l.removed} /></Td>
                      <Td className="text-right tabular-nums">{money(l.priceCents, l.currency)}</Td>
                      <Td className="text-right tabular-nums">{l.quantity}</Td>
                      <Td className="text-right tabular-nums text-ink-dim">{l.sold}</Td>
                      <Td className="whitespace-nowrap text-ink-dim">{shortDate(l.createdAt)}</Td>
                      <Td className="text-right">
                        <button
                          type="button"
                          onClick={() => setActing(l)}
                          className="whitespace-nowrap text-xs font-medium text-ink-dim underline-offset-2 hover:text-clay hover:underline"
                        >
                          {l.removed ? "Restore" : "Remove"}
                        </button>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <Pagination
              page={data.page}
              pages={data.pages}
              total={data.total}
              pageSize={data.pageSize}
              onPage={setPage}
            />
          </>
        )}
      </Card>

      {acting && (
        <ActionDialog
          listing={acting}
          onClose={() => setActing(null)}
          onDone={() => {
            setActing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

/**
 * The reason box, as a dialog rather than an inline row.
 *
 * Removing someone's listing is not a thing to do with a single click in a
 * table of two dozen. The dialog is the pause, and the reason is the record.
 */
function ActionDialog({
  listing,
  onClose,
  onDone,
}: {
  listing: ListingRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const removing = !listing.removed;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await (removing
        ? removeListing(listing.id, reason)
        : restoreListing(listing.id, reason));
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-title"
        className="w-full max-w-md rounded-2xl border border-line bg-paper-card p-6 shadow-lg"
      >
        <h2 id="action-title" className="font-serif text-lg font-semibold text-ink">
          {removing ? "Remove this listing" : "Restore this listing"}
        </h2>
        <p className="mt-1 line-clamp-2 text-sm text-ink-dim">{listing.title}</p>

        <form onSubmit={submit} className="mt-4">
          <label htmlFor="action-reason" className="block text-xs text-ink-dim">
            Reason — the seller sees this
          </label>
          <textarea
            id="action-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 1000))}
            rows={3}
            autoFocus
            disabled={busy}
            placeholder={removing ? "Photos don't match the description." : "Removed in error."}
            className="mt-1.5 w-full rounded border border-line bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-dim/60 focus:border-gold/50 disabled:opacity-60"
          />

          {error && <p className="mt-2 text-sm text-clay">{error}</p>}

          <p className="mt-2 text-[11px] text-ink-dim">
            {removing
              ? "The listing disappears from the shop but is not deleted — orders that already contain it keep working."
              : "It comes back as a draft, not live. The seller decides whether to publish it again."}
          </p>

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded border border-line px-4 py-2 text-sm text-ink transition hover:border-gold/40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || reason.trim().length < 3}
              className={`rounded px-4 py-2 text-sm font-semibold transition disabled:opacity-50 ${
                removing
                  ? "border border-clay/40 text-clay hover:bg-clay/10"
                  : "bg-ink text-paper hover:brightness-125"
              }`}
            >
              {busy ? "Working…" : removing ? "Remove" : "Restore"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
