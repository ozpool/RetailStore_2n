"use client";

import { useCallback, useEffect, useState } from "react";
import AdminGate, { useAdminGate } from "@/components/admin/AdminGate";
import {
  Card,
  EmptyState,
  Pagination,
  Pill,
  RowLink,
  SearchBox,
  TableWrap,
  Tabs,
  Td,
  Th,
  Tr,
  shortDate,
} from "@/components/admin/ui";
import { getCustomers, type CustomerRow, type Paged } from "@/lib/adminApi";
import { useDebounced } from "@/lib/useDebounced";

type Filter = "ALL" | "SELLERS" | "SUSPENDED" | "ADMINS";

export default function AdminCustomersPage() {
  return (
    <AdminGate title="Customers" subtitle="Everyone with an account">
      {() => <Customers />}
    </AdminGate>
  );
}

function Customers() {
  const { handleError } = useAdminGate();
  const [filter, setFilter] = useState<Filter>("ALL");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paged<CustomerRow> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = useDebounced(q, 300);

  const load = useCallback(async () => {
    try {
      setData(await getCustomers({ q: search, filter, page }));
      setError(null);
    } catch (err) {
      handleError(err);
      setError("Couldn't load customers.");
    }
  }, [search, filter, page, handleError]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [search, filter]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { key: "ALL", label: "Everyone" },
            { key: "SELLERS", label: "Sellers" },
            { key: "SUSPENDED", label: "Suspended" },
            { key: "ADMINS", label: "Admins" },
          ]}
        />
        <SearchBox value={q} onChange={setQ} placeholder="Name or email" />
      </div>

      {error && (
        <p className="rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">{error}</p>
      )}

      <Card>
        {!data ? (
          <p className="px-5 py-14 text-center text-sm text-ink-dim">Loading…</p>
        ) : data.rows.length === 0 ? (
          <EmptyState title="Nobody matches" body="Try a different search or filter." />
        ) : (
          <>
            <TableWrap>
              <table className="w-full">
                <thead>
                  <tr className="bg-blush">
                    <Th>Name</Th>
                    <Th>Email</Th>
                    <Th>Roles</Th>
                    <Th className="text-right">Orders</Th>
                    <Th>Joined</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((c) => (
                    <Tr key={c.id} href={`/admin/customers/${c.id}`}>
                      <Td>
                        <RowLink href={`/admin/customers/${c.id}`}>{c.name}</RowLink>
                        {c.suspendedReason && (
                          <p className="mt-0.5 max-w-xs truncate text-xs text-clay">
                            {c.suspendedReason}
                          </p>
                        )}
                      </Td>
                      <Td>
                        <span className="block max-w-64 truncate text-ink-dim">{c.email}</span>
                      </Td>
                      <Td>
                        <span className="flex flex-wrap gap-1">
                          {c.role === "ADMIN" && <Pill tone="info">Admin</Pill>}
                          {c.isSeller && <Pill tone="neutral">Seller</Pill>}
                          {c.suspendedAt && <Pill tone="bad">Suspended</Pill>}
                          {!c.emailVerified && <Pill tone="warn">Unverified</Pill>}
                        </span>
                      </Td>
                      <Td className="text-right tabular-nums">{c.orders}</Td>
                      <Td className="whitespace-nowrap text-ink-dim">{shortDate(c.createdAt)}</Td>
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
