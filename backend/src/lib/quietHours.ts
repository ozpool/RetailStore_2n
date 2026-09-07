/**
 * The hours in which this platform will not text somebody.
 *
 * WHY ONLY SMS HAS THESE
 * An email waits in an inbox and a push notification is silenced by the phone's
 * own do-not-disturb, which the owner has already configured to their liking.
 * An SMS bypasses that on most handsets — it is the channel people leave
 * audible precisely because it is the one that matters. Sending "your refund
 * was issued" at 3am is not urgent enough to be worth what it costs in
 * goodwill, and goodwill spent this way is not recoverable.
 *
 * CONFIGURED, NOT HARDCODED, because "night" is a local fact and a deployment
 * serving one region should be able to say what it means.
 *
 *   SMS_QUIET_HOURS=22:00-08:00   default. Empty or "off" disables the window.
 *   SMS_QUIET_HOURS_TZ=Europe/London   default UTC.
 *
 * A KNOWN LIMITATION, STATED PLAINLY. This is the SERVER's window, not the
 * recipient's. Plan 0001 §6 says quiet hours apply "by the recipient's
 * timezone", and there is no timezone column on User to do that with. A user in
 * Sydney is currently quiet during London's night rather than their own. Fixing
 * it properly is a `timezone` column captured at signup, and until that exists
 * this is the honest approximation rather than a claim to be the real thing.
 */

const DEFAULT_WINDOW = "22:00-08:00";

export type QuietHours = {
  inWindow: boolean;
  /** For the ledger's suppressReason, so a support answer can quote it. */
  window: string;
  /**
   * When the window closes, and therefore the earliest a deferred message may
   * be sent. Null when not currently inside a window.
   *
   * Computed by adding the remaining minutes to the current instant rather
   * than by constructing a local wall-clock time in the target zone. That is
   * off by an hour across a DST boundary, twice a year, in the direction of
   * sending an hour early or an hour late. Named rather than hidden: the fix
   * is a real date library, and an hour's drift on a quiet-hours boundary is
   * not worth one.
   */
  opensAt: Date | null;
};

function parseHhMm(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Minutes past local midnight in the configured zone.
 *
 * Via Intl rather than by adding an offset, because an offset is wrong twice a
 * year. `en-GB` with hour12 false gives a stable 24-hour "HH:mm".
 */
function minutesNowIn(timeZone: string, at: Date): number {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);

  const parsed = parseHhMm(formatted);
  return parsed ?? 0;
}

export function quietHoursNow(at: Date = new Date()): QuietHours {
  const raw = (process.env.SMS_QUIET_HOURS ?? DEFAULT_WINDOW).trim();

  if (!raw || raw.toLowerCase() === "off") {
    return { inWindow: false, window: "disabled", opensAt: null };
  }

  const [fromRaw, toRaw] = raw.split("-");
  const from = fromRaw ? parseHhMm(fromRaw) : null;
  const to = toRaw ? parseHhMm(toRaw) : null;

  if (from === null || to === null) {
    /**
     * A malformed window disables the feature rather than blocking every
     * message or throwing. A typo in an environment variable must not be able
     * to silently stop all SMS, and must not be able to crash a worker either.
     */
    console.warn(`[sms] SMS_QUIET_HOURS="${raw}" is not "HH:MM-HH:MM"; quiet hours are off`);
    return { inWindow: false, window: "disabled (misconfigured)", opensAt: null };
  }

  const tz = (process.env.SMS_QUIET_HOURS_TZ ?? "UTC").trim() || "UTC";

  let now: number;
  try {
    now = minutesNowIn(tz, at);
  } catch {
    console.warn(`[sms] SMS_QUIET_HOURS_TZ="${tz}" is not a known timezone; using UTC`);
    now = minutesNowIn("UTC", at);
  }

  /**
   * The window normally WRAPS midnight — 22:00 to 08:00 is two ranges, not
   * one. Testing `now >= from && now < to` would be false all night, which is
   * the bug that makes a quiet-hours feature do nothing and look fine.
   */
  const inWindow = from <= to ? now >= from && now < to : now >= from || now < to;
  const window = `${fromRaw}-${toRaw} ${tz}`;

  if (!inWindow) return { inWindow, window, opensAt: null };

  /**
   * Minutes from now until the window closes.
   *
   * The wrapping case is the one that needs care: at 23:00 inside 22:00-08:00
   * the close is tomorrow, so it is the rest of today plus `to`. At 03:00 the
   * close is later the same day, so it is simply `to - now`.
   */
  const MINUTES_PER_DAY = 24 * 60;
  const remaining =
    from <= to
      ? to - now
      : now >= from
        ? MINUTES_PER_DAY - now + to
        : to - now;

  return {
    inWindow,
    window,
    opensAt: new Date(at.getTime() + remaining * 60_000),
  };
}
