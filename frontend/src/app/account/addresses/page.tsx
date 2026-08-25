"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import AddressForm from "@/components/AddressForm";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/AuthContext";
import {
  countryName,
  createAddress,
  deleteAddress,
  getAddresses,
  setDefaultAddress,
  updateAddress,
  type Address,
  type AddressInput,
} from "@/lib/addressesApi";

function AddressesInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, loading } = useAuth();

  const [addresses, setAddresses] = useState<Address[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Address | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  /**
   * Checkout sends people here when they have no address, with ?next=/cart.
   * Coming back with one saved is the whole point of the trip, so the form is
   * open on arrival rather than making them find the button.
   */
  const next = params.get("next");

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    try {
      const { addresses } = await getAddresses();
      setAddresses(addresses);
      if (next && addresses.length === 0) setAdding(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your addresses.");
      setAddresses([]);
    }
  }, [next]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  async function handleCreate(input: AddressInput) {
    await createAddress(input);
    setAdding(false);
    await load();
    // Straight back to what they were doing, rather than stranding them here.
    if (next) router.push(next);
  }

  async function handleUpdate(input: AddressInput) {
    if (!editing) return;
    await updateAddress(editing.id, input);
    setEditing(null);
    await load();
  }

  async function makeDefault(id: string) {
    setError(null);
    setBusyId(id);
    try {
      const { addresses } = await setDefaultAddress(id);
      setAddresses(addresses);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update that.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    setError(null);
    setBusyId(id);
    try {
      await deleteAddress(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove that address.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading || !user) {
    return <Shell><p className="text-sm text-ink-dim">Loading…</p></Shell>;
  }

  const list = addresses ?? [];

  return (
    <Shell>
      <Link href="/account" className="text-sm text-ink-dim transition hover:text-gold-dim">
        ← Your account
      </Link>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Addresses
        </h1>
        {list.length > 0 && !adding && !editing && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded bg-gold-dim px-5 py-2.5 text-sm font-semibold text-paper transition hover:brightness-95"
          >
            Add an address
          </button>
        )}
      </div>

      <p className="mt-3 max-w-2xl text-sm text-ink-dim">
        Where your orders get delivered. Your default is used at checkout, and
        each order keeps a copy of the address as it was that day — so editing
        one here never changes where a past order went.
      </p>

      {next && list.length === 0 && (
        <p className="mt-6 rounded-xl border border-gold/30 bg-gold/5 px-4 py-3 text-sm text-ink">
          Add a delivery address to finish checking out.
        </p>
      )}

      {error && (
        <p className="mt-6 rounded-xl border border-clay/30 bg-clay/10 px-4 py-3 text-sm text-clay">
          {error}
        </p>
      )}

      {(adding || editing) && (
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-ink">
            {editing ? "Edit address" : "New address"}
          </h2>
          <AddressForm
            key={editing?.id ?? "new"}
            initial={editing}
            submitLabel={editing ? "Save changes" : "Save address"}
            onSubmit={editing ? handleUpdate : handleCreate}
            onCancel={() => {
              setAdding(false);
              setEditing(null);
            }}
          />
        </div>
      )}

      {addresses === null ? (
        <p className="mt-10 text-sm text-ink-dim">Loading…</p>
      ) : list.length === 0 && !adding ? (
        <div className="mt-10 border border-line bg-blush p-10 text-center">
          <p className="text-ink">No addresses saved</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-dim">
            You&apos;ll need one before you can check out.
          </p>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-6 rounded bg-gold-dim px-6 py-3 text-sm font-medium text-paper transition hover:brightness-95"
          >
            Add an address
          </button>
        </div>
      ) : (
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {list.map((a) => (
            <li
              key={a.id}
              className={`rounded-2xl border p-5 ${
                a.isDefault ? "border-gold/40 bg-gold/5" : "border-line bg-paper-card"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-sm font-medium text-ink">{a.fullName}</p>
                {a.isDefault && (
                  <span className="rounded-full border border-gold/40 px-2.5 py-0.5 text-xs font-medium text-gold-dim">
                    Default
                  </span>
                )}
              </div>

              <address className="mt-2 text-sm not-italic text-ink-dim">
                {a.line1}
                {a.line2 && <><br />{a.line2}</>}
                <br />
                {a.city}
                {a.region && `, ${a.region}`}
                <br />
                {a.postcode}
                <br />
                {countryName(a.country)}
                {a.phone && <><br />{a.phone}</>}
              </address>

              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(a);
                    setAdding(false);
                  }}
                  className="text-xs text-gold-dim underline"
                >
                  Edit
                </button>
                {!a.isDefault && (
                  <button
                    type="button"
                    onClick={() => makeDefault(a.id)}
                    disabled={busyId === a.id}
                    className="text-xs text-ink-dim underline transition hover:text-ink disabled:opacity-60"
                  >
                    Make default
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => remove(a.id)}
                  disabled={busyId === a.id}
                  className="ml-auto text-xs text-ink-dim underline transition hover:text-clay disabled:opacity-60"
                >
                  {busyId === a.id ? "Removing…" : "Remove"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

export default function AddressesPage() {
  // useSearchParams needs a Suspense boundary during prerender.
  return (
    <Suspense fallback={<Shell><p className="text-sm text-ink-dim">Loading…</p></Shell>}>
      <AddressesInner />
    </Suspense>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Nav />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-4xl">{children}</div>
      </main>
      <Footer />
    </>
  );
}
