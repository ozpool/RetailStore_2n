import crypto from "crypto";

const TIMEOUT_MS = 4000;

/**
 * Checks a password against the Pwned Passwords corpus using k-anonymity:
 * only the first 5 characters of the SHA-1 hash are sent, never the
 * password or the full hash, so the service can't reconstruct what was
 * checked. "Add-Padding" asks the API to pad the response with decoy
 * entries so a network observer can't infer a hit from response size
 * alone.
 *
 * If the check itself fails (network issue, API down), we fail open —
 * this is a defense-in-depth check, not the primary security boundary,
 * and it shouldn't take signup down with it.
 */
export async function isPasswordBreached(password: string): Promise<boolean> {
  const sha1 = crypto.createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      signal: controller.signal,
      headers: { "Add-Padding": "true" },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[password-breach-check] API returned ${res.status}; allowing signup.`);
      return false;
    }

    const body = await res.text();
    return body
      .split("\n")
      .some((line) => line.split(":")[0].trim() === suffix);
  } catch (err) {
    console.warn("[password-breach-check] Check failed; allowing signup.", err);
    return false;
  }
}
