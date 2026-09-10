/**
 * Phone numbers, normalised to E.164 before they touch anything else.
 *
 * WHY NORMALISE AT ALL
 * "+44 7700 900123", "+44-7700-900123", and "+447700900123" are one number and
 * three strings. Without a single canonical form the unique constraint on
 * users.phone does not hold, the same person can verify twice, and a provider
 * is handed something it has to guess about.
 *
 * WHY THE COUNTRY CODE IS REQUIRED, AND NOT INFERRED
 * "07700900123" is a valid mobile number in the UK, in South Africa, and in
 * several other places, and they are different phones. Guessing a country from
 * an IP address or a shipping address would text a stranger some fraction of
 * the time, and that fraction is not small enough to be acceptable when the
 * message contains order details.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not know which numbers actually exist. E.164 is a length-and-shape
 * standard, not a directory — "+99999999999" passes here and is not a phone.
 * Per-country validation (is this a mobile? is this prefix allocated?) needs a
 * carrier database, which is what libphonenumber-js or Twilio Lookup are for.
 * That is a deliberate deferral rather than an oversight: the verification code
 * is what proves the number is real and reachable, and it proves it far better
 * than any prefix table can.
 *
 * ONE CONSEQUENCE WORTH NAMING. "+4407700900123" — a country code with the
 * national trunk 0 left on behind it — is NOT rejected here, and cannot be
 * without knowing that 44 is a country code and how long a UK number is. Only
 * a leading zero ("+07700900123") is detectable, because no country calling
 * code begins with 0. The undetected case fails at the next step instead: no
 * code arrives, so the number is never verified, and nothing is ever sent to
 * it. The gate is phoneVerifiedAt, not this function.
 */

/** The longest an E.164 number can be, country code included. ITU-T E.164 §6. */
const MAX_DIGITS = 15;

/**
 * The shortest thing we will treat as a number. Not from the standard — E.164
 * sets no floor — but a country code plus four digits is already shorter than
 * any real subscriber number, and the floor keeps obvious rubbish out.
 */
const MIN_DIGITS = 7;

export class InvalidPhoneNumber extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPhoneNumber";
  }
}

/**
 * Returns the E.164 form, or throws with a message meant for the person who
 * typed it rather than for a log.
 */
export function toE164(raw: string): string {
  const trimmed = (raw ?? "").trim();

  if (!trimmed) {
    throw new InvalidPhoneNumber("Enter a phone number.");
  }

  /**
   * Separators people actually type, and that every phone keypad offers.
   * Removed rather than rejected: punctuation is how humans read a number back
   * to themselves, and refusing it teaches nothing.
   */
  const cleaned = trimmed.replace(/[\s\-().]/g, "");

  /**
   * "00" is the international access prefix across most of the world and means
   * exactly what "+" means. Accepting it costs one line and saves a support
   * conversation with everyone who dials that way.
   */
  const withPlus = cleaned.startsWith("00") ? `+${cleaned.slice(2)}` : cleaned;

  if (!withPlus.startsWith("+")) {
    throw new InvalidPhoneNumber(
      "Include the country code, starting with + — for example +44 7700 900123. " +
        "Without it the same digits belong to a different phone in every country."
    );
  }

  const digits = withPlus.slice(1);

  if (!/^[0-9]+$/.test(digits)) {
    throw new InvalidPhoneNumber("A phone number can only contain digits after the country code.");
  }

  /**
   * No country calling code begins with 0 — the leading digit identifies the
   * world zone. A "+0…" is almost always a national number with the trunk
   * prefix left on and a "+" typed in front of it.
   */
  if (digits.startsWith("0")) {
    throw new InvalidPhoneNumber(
      "That looks like a national number with a + in front. Drop the leading 0 " +
        "and use the country code — +44 7700 900123, not +4407700900123."
    );
  }

  if (digits.length < MIN_DIGITS) {
    throw new InvalidPhoneNumber("That number is too short to be a phone number.");
  }

  if (digits.length > MAX_DIGITS) {
    throw new InvalidPhoneNumber(
      `A phone number cannot be longer than ${MAX_DIGITS} digits including the country code.`
    );
  }

  return `+${digits}`;
}

/** Non-throwing form, for validators that want a boolean. */
export function isE164(raw: string): boolean {
  try {
    toE164(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * For display and for logs: "+447700900123" becomes "+44 ••• ••• 123".
 *
 * A full number in a log is a piece of personal data sitting in a system with
 * far weaker access controls than the database, and support transcripts get
 * pasted into tickets. The last three digits are enough for somebody to
 * recognise their own number and not enough for anyone else to dial it.
 */
export function maskPhone(e164: string): string {
  if (!e164 || !e164.startsWith("+") || e164.length < 5) return "•••";
  const cc = e164.slice(0, 3);
  const tail = e164.slice(-3);
  return `${cc} ••• ••• ${tail}`;
}
