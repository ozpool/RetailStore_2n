"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import AdminGate, { useAdminGate } from "@/components/admin/AdminGate";
import {
  Card,
  EmptyState,
  OrderStatusPill,
  Pagination,
  RowLink,
  SearchBox,
  TableWrap,
  Tabs,
  Td,
  Th,
  Tr,
  fullDate,
  money,
} from "@/components/admin/ui";
import { getOrders, type OrderRow, type Paged } from "@/lib/adminApi";
import { useDebounced } from "@/lib/useDebounced";

type Status =
  | "ALL"
  | "PAID"
  | "PROCESSING"
  | "PENDING_PAYMENT"
  | "FAILED"
  | "CANCELLED"
  | "REFUNDED";

export default function AdminOrdersPage() {
  return (
    <AdminGate title="Orders" subtitle="Every order placed on the shop">
      {() => (
        // useSearchParams needs a Suspense boundary in the App Router.
        <Suspense fallback={<p className="text-sm text-ink-dim">Loading…</p>}>
          <Orders />
        </Suspense>
      )}
    </AdminGate>
  );
}

function Orders() {
  const params = useSearchParams();
  const { handleError } = useAdminGate();

  // Seeded from the URL so the dashboard's "Payments stuck mid-flight" link
  // lands on the right filter rather than on an unfiltered list.
  const [status, setStatus] = useState<Status>((params.get("status") as Status) ?? "ALL");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<OrderRow> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = useDebounced(q, 300);

  const load = useCallback(async () => {
    try {
      setData(await getOrders({ q: search, status, page }));
      setError(null);
    } catch (err) {
      handleError(err);
      setError("Couldn't load orders.");
    }
  }, [search, status, page, handleError]);

  useEffect(() => {
    load();
  }, [load]);

  // Any change to the filters invalidates the page number — page 4 of an
  // unfiltered list is usually past the end of a filtered one.
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
            { key: "PAID", label: "Paid" },
            { key: "PROCESSING", label: "Processing" },
            { key: "PENDING_PAYMENT", label: "Awaiting payment" },
            { key: "FAILED", label: "Failed" },
            { key: "CANCELLED", label: "Cancelled" },
            { key: "REFUNDED", label: "Refunded" },
          ]}
        />
        <SearchBox value={q} onChange={setQ} placeholder="Reference, name, or email" />
      </div>

      {error && (
        <p className="rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">{error}</p>
      )}

      <Card>
        {!data ? (
          <p className="px-5 py-14 text-center text-sm text-ink-dim">Loading…</p>
        ) : data.rows.length === 0 ? (
          <EmptyState
            title="No orders match"
            body={search || status !== "ALL" ? "Try a different filter." : "Nothing has been ordered yet."}
          />
        ) : (
          <>
            <TableWrap>
              <table className="w-full">
                <thead>
                  <tr className="bg-blush">
                    <Th>Order</Th>
                    <Th>Buyer</Th>
                    <Th>Status</Th>
                    <Th>Fulfilment</Th>
                    <Th className="text-right">Total</Th>
                    <Th>Placed</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((o) => (
                    <Tr key={o.id} href={`/admin/orders/${o.id}`}>
                      <Td>
                        <RowLink href={`/admin/orders/${o.id}`}>{o.reference}</RowLink>
                        <p className="text-xs text-ink-dim">
                          {o.units} item{o.units === 1 ? "" : "s"} · {o.lines} line
                          {o.lines === 1 ? "" : "s"}
                        </p>
                      </Td>
                      <Td>
                        <span className="block max-w-52 truncate">{o.buyerName}</span>
                        <span className="block max-w-52 truncate text-xs text-ink-dim">
                          {o.buyerEmail}
                        </span>
                      </Td>
                      <Td><OrderStatusPill status={o.status} /></Td>
                      <Td className="whitespace-nowrap text-xs text-ink-dim">
                        {o.status === "PAID" || o.status === "REFUNDED"
                          ? `${o.fulfilledLines} / ${o.lines} sent`
                          : "—"}
                      </Td>
                      <Td className="text-right tabular-nums">{money(o.subtotalCents, o.currency)}</Td>
                      <Td className="whitespace-nowrap text-ink-dim">{fullDate(o.createdAt)}</Td>
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
    </div>
  );
}
