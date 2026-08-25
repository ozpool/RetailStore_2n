import { ApiError } from "@/lib/api";

export type Address = {
  id: string;
  fullName: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postcode: string;
  country: string;
  phone: string | null;
  isDefault: boolean;
  createdAt: string;
};

export type AddressInput = {
  fullName: string;
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postcode: string;
  country: string;
  phone?: string | null;
  isDefault?: boolean;
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/addresses${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      body.error ?? "Something went wrong. Please try again.",
      body.code,
      body.field
    );
  }
  return body as T;
}

export function getAddresses() {
  return request<{ addresses: Address[] }>("");
}

export function createAddress(input: AddressInput) {
  return request<{ address: Address }>("", { method: "POST", body: JSON.stringify(input) });
}

export function updateAddress(id: string, input: AddressInput) {
  return request<{ address: Address }>(`/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function setDefaultAddress(id: string) {
  return request<{ addresses: Address[] }>(`/${id}/default`, { method: "POST" });
}

export function deleteAddress(id: string) {
  return request<void>(`/${id}`, { method: "DELETE" });
}

/**
 * A short list rather than all 249 countries.
 *
 * Honest about scope: this is a portfolio marketplace with a seeded catalogue,
 * not a shipping operation. A full ISO list would imply we can send anywhere.
 * The field stores ISO 3166-1 alpha-2 either way, so widening it later is a
 * data change and nothing more.
 */
export const COUNTRIES = [
  { code: "GB", name: "United Kingdom" },
  { code: "IE", name: "Ireland" },
  { code: "US", name: "United States" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "NZ", name: "New Zealand" },
  { code: "IN", name: "India" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "NL", name: "Netherlands" },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "PT", name: "Portugal" },
  { code: "SE", name: "Sweden" },
  { code: "JP", name: "Japan" },
  { code: "BR", name: "Brazil" },
] as const;

export function countryName(code: string | null | undefined) {
  if (!code) return "";
  return COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

/** One-line rendering, for a summary row. */
export function formatAddress(a: {
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postcode: string;
  country: string;
}) {
  return [a.line1, a.line2, a.city, a.region, a.postcode, countryName(a.country)]
    .filter(Boolean)
    .join(", ");
}
