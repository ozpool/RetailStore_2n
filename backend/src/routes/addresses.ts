import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import {
  AddressError,
  createAddress,
  deleteAddress,
  getAddress,
  listAddresses,
  setDefaultAddress,
  updateAddress,
} from "../lib/addresses";

export const addressesRouter = Router();

addressesRouter.use(requireAuth);

function fail(res: import("express").Response, err: unknown, fallback: string) {
  if (err instanceof AddressError) {
    return res.status(err.status).json({ error: err.message, code: err.code, field: err.field });
  }
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

/**
 * Length caps are generous and the shape is loose on purpose. Address formats
 * differ enough between countries that strict validation rejects more real
 * addresses than it catches bad ones — a UK postcode, an Irish Eircode, and a
 * Hong Kong address with no postcode at all are all legitimate.
 */
const body = z.object({
  fullName: z.string().trim().min(1, "Who should it be addressed to?").max(120),
  line1: z.string().trim().min(1, "Enter a street address.").max(200),
  line2: z.string().trim().max(200).nullish(),
  city: z.string().trim().min(1, "Enter a city or town.").max(120),
  region: z.string().trim().max(120).nullish(),
  postcode: z.string().trim().min(1, "Enter a postcode or ZIP.").max(32),
  country: z.string().trim().length(2, "Pick a country."),
  phone: z.string().trim().max(40).nullish(),
  isDefault: z.boolean().optional(),
});

function invalid(res: import("express").Response, parsed: z.ZodSafeParseError<unknown>) {
  const first = parsed.error.issues[0];
  return res.status(400).json({
    error: first?.message ?? "Check the address and try again.",
    code: "INVALID_INPUT",
    field: first?.path?.[0] != null ? String(first.path[0]) : undefined,
  });
}

addressesRouter.get("/", async (req, res) => {
  try {
    res.json({ addresses: await listAddresses(req.userId!) });
  } catch (err) {
    fail(res, err, "Could not load your addresses.");
  }
});

addressesRouter.get("/:id", async (req, res) => {
  try {
    const address = await getAddress(req.userId!, req.params.id);
    if (!address) {
      return res.status(404).json({ error: "Address not found.", code: "NOT_FOUND" });
    }
    res.json({ address });
  } catch (err) {
    fail(res, err, "Could not load that address.");
  }
});

addressesRouter.post("/", async (req, res) => {
  try {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed);
    res.status(201).json({ address: await createAddress(req.userId!, parsed.data) });
  } catch (err) {
    fail(res, err, "Could not save that address.");
  }
});

addressesRouter.patch("/:id", async (req, res) => {
  try {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) return invalid(res, parsed);
    res.json({ address: await updateAddress(req.userId!, req.params.id, parsed.data) });
  } catch (err) {
    fail(res, err, "Could not update that address.");
  }
});

addressesRouter.post("/:id/default", async (req, res) => {
  try {
    await setDefaultAddress(req.userId!, req.params.id);
    res.json({ addresses: await listAddresses(req.userId!) });
  } catch (err) {
    fail(res, err, "Could not set that as your default.");
  }
});

addressesRouter.delete("/:id", async (req, res) => {
  try {
    await deleteAddress(req.userId!, req.params.id);
    res.status(204).end();
  } catch (err) {
    fail(res, err, "Could not remove that address.");
  }
});
