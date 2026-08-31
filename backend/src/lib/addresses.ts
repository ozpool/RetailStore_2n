import { prisma } from "./prisma";

/**
 * Delivery addresses.
 *
 * SOFT DELETE
 * A deleted address stays in the table. Two reasons: the buyer may be partway
 * through checkout in another tab when they press delete, and nothing is gained
 * by destroying it. Past orders never point here at all — they carry a copy of
 * the fields — so removal is purely about the address book.
 *
 * EXACTLY ONE DEFAULT
 * Enforced in a transaction rather than by a constraint, because Prisma cannot
 * express a partial unique index on `isDefault = true AND deletedAt IS NULL`.
 * Clearing then setting, inside one transaction, is what keeps two rows from
 * both claiming it.
 */

export const MAX_ADDRESSES = 20;

export class AddressError extends Error {
  code: string;
  status: number;
  field?: string;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "AddressError";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

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

const addressSelect = {
  id: true,
  fullName: true,
  line1: true,
  line2: true,
  city: true,
  region: true,
  postcode: true,
  country: true,
  phone: true,
  isDefault: true,
  createdAt: true,
} as const;

export type AddressRow = {
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
  createdAt: Date;
};

export function serialize(a: AddressRow) {
  return {
    id: a.id,
    fullName: a.fullName,
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    region: a.region,
    postcode: a.postcode,
    country: a.country,
    phone: a.phone,
    isDefault: a.isDefault,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function listAddresses(userId: string) {
  const rows = await prisma.address.findMany({
    where: { userId, deletedAt: null },
    // Default first, then newest — the order someone picking one expects.
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    select: addressSelect,
  });
  return rows.map(serialize);
}

export async function getAddress(userId: string, addressId: string) {
  const row = await prisma.address.findFirst({
    where: { id: addressId, userId, deletedAt: null },
    select: addressSelect,
  });
  return row ? serialize(row) : null;
}

/** The one to preselect at checkout: the default, or the most recent. */
export async function defaultAddress(userId: string) {
  const row = await prisma.address.findFirst({
    where: { userId, deletedAt: null },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    select: addressSelect,
  });
  return row ? serialize(row) : null;
}

function clean(input: AddressInput) {
  const trimmed = {
    fullName: input.fullName.trim(),
    line1: input.line1.trim(),
    line2: input.line2?.trim() || null,
    city: input.city.trim(),
    region: input.region?.trim() || null,
    postcode: input.postcode.trim(),
    country: input.country.trim().toUpperCase(),
    phone: input.phone?.trim() || null,
  };

  if (trimmed.country.length !== 2) {
    throw new AddressError("INVALID_COUNTRY", "Pick a country.", 400, "country");
  }
  return trimmed;
}

export async function createAddress(userId: string, input: AddressInput) {
  const count = await prisma.address.count({ where: { userId, deletedAt: null } });
  if (count >= MAX_ADDRESSES) {
    throw new AddressError(
      "TOO_MANY",
      `You can save up to ${MAX_ADDRESSES} addresses. Remove one first.`,
      409
    );
  }

  const data = clean(input);
  // The first address a buyer saves is their default whether they asked or not
  // — otherwise checkout has nothing to preselect and the form looks broken.
  const makeDefault = input.isDefault === true || count === 0;

  const created = await prisma.$transaction(async (tx) => {
    if (makeDefault) {
      await tx.address.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.address.create({
      data: { ...data, userId, isDefault: makeDefault },
      select: addressSelect,
    });
  });

  return serialize(created);
}

export async function updateAddress(userId: string, addressId: string, input: AddressInput) {
  const existing = await prisma.address.findFirst({
    where: { id: addressId, userId, deletedAt: null },
    select: { id: true, isDefault: true },
  });
  // 404 rather than 403: confirming someone else's address exists tells an
  // attacker something they should not learn.
  if (!existing) {
    throw new AddressError("NOT_FOUND", "Address not found.", 404);
  }

  const data = clean(input);
  const makeDefault = input.isDefault === true;

  const updated = await prisma.$transaction(async (tx) => {
    if (makeDefault) {
      await tx.address.updateMany({
        where: { userId, isDefault: true, id: { not: addressId } },
        data: { isDefault: false },
      });
    }
    return tx.address.update({
      where: { id: addressId },
      // An address that is already the default stays the default unless another
      // one takes over — nobody expects editing a typo to un-default it.
      data: { ...data, isDefault: makeDefault || existing.isDefault },
      select: addressSelect,
    });
  });

  return serialize(updated);
}

export async function setDefaultAddress(userId: string, addressId: string) {
  const exists = await prisma.address.findFirst({
    where: { id: addressId, userId, deletedAt: null },
    select: { id: true },
  });
  if (!exists) throw new AddressError("NOT_FOUND", "Address not found.", 404);

  await prisma.$transaction([
    prisma.address.updateMany({
      where: { userId, isDefault: true },
      data: { isDefault: false },
    }),
    prisma.address.update({ where: { id: addressId }, data: { isDefault: true } }),
  ]);
}

/**
 * Removes an address from the book.
 *
 * If it was the default, the next most recent takes over — leaving a buyer with
 * addresses but no default means checkout preselects nothing for no reason.
 */
export async function deleteAddress(userId: string, addressId: string) {
  const existing = await prisma.address.findFirst({
    where: { id: addressId, userId, deletedAt: null },
    select: { id: true, isDefault: true },
  });
  if (!existing) throw new AddressError("NOT_FOUND", "Address not found.", 404);

  await prisma.$transaction(async (tx) => {
    await tx.address.update({
      where: { id: addressId },
      data: { deletedAt: new Date(), isDefault: false },
    });

    if (existing.isDefault) {
      const next = await tx.address.findFirst({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (next) {
        await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    }
  });
}

/** The snapshot fields copied onto an order at checkout. */
export function toOrderSnapshot(a: ReturnType<typeof serialize>) {
  return {
    shipToName: a.fullName,
    shipToLine1: a.line1,
    shipToLine2: a.line2,
    shipToCity: a.city,
    shipToRegion: a.region,
    shipToPostcode: a.postcode,
    shipToCountry: a.country,
    shipToPhone: a.phone,
  };
}
