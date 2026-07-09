import nodemailer, { type Transporter } from "nodemailer";

/**
 * Outgoing email, via nodemailer.
 *
 * THREE TRANSPORTS, ONE INTERFACE
 * -------------------------------
 *   console   prints the link to the terminal. The default, and what the test
 *             suites run against — 619 assertions should not be gated on an
 *             SMTP handshake, and no test reads an inbox.
 *   ethereal  a throwaway inbox nodemailer creates on demand. The message is
 *             really composed and really delivered, and the log line carries a
 *             URL where the rendered email can be read. No account, no cost.
 *             This is the one to use when demonstrating the flow.
 *   smtp      a real server. Anything that speaks SMTP: Resend, SES, Postmark,
 *             a Gmail app password.
 *
 * WHY A FAILED SEND DOES NOT FAIL THE SIGNUP
 * ------------------------------------------
 * The account and its verification token are already committed by the time
 * this runs. Throwing would turn a transient SMTP blip into a 500 on an account
 * that actually exists, and the caller has no way to distinguish that from
 * "the address was rejected".
 *
 * Instead the failure is logged loudly and the signup stands. The product
 * already has the recovery path this implies: POST /auth/resend-verification.
 * A user who never receives the first mail asks for another one, which is what
 * they would do anyway.
 */

type Transport = "console" | "ethereal" | "smtp";

function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  // Trimmed, and blank counts as absent. A leading space in a secret is
  // truthy, passes every "is it set?" check, and then fails at the far end —
  // which cost an afternoon on STRIPE_WEBHOOK_SECRET once already.
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function transportKind(): Transport {
  const configured = env("MAIL_TRANSPORT")?.toLowerCase();
  if (configured === "smtp" || configured === "ethereal" || configured === "console") {
    return configured;
  }
  // An unrecognised value falls back to console rather than guessing. Guessing
  // "smtp" would make the server refuse to start over a typo.
  if (configured) {
    console.warn(`[mail] unknown MAIL_TRANSPORT "${configured}", using console`);
  }
  return "console";
}

function fromAddress(): string {
  return env("MAIL_FROM") ?? "RetailStore_2n <no-reply@retailstore-2n.local>";
}

/**
 * Checked at startup, before the port is bound.
 *
 * Same reasoning as the Stripe check: a missing SMTP password found during a
 * real signup is a broken customer, and found here it is one line of output.
 */
export function assertMailConfigured(): string {
  const kind = transportKind();

  if (kind === "smtp") {
    const missing = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"].filter((k) => !env(k));
    if (missing.length) {
      throw new Error(
        `MAIL_TRANSPORT is "smtp" but ${missing.join(", ")} ${
          missing.length === 1 ? "is" : "are"
        } not set. Set them, or use MAIL_TRANSPORT=ethereal to send to a ` +
          `throwaway inbox, or MAIL_TRANSPORT=console to print links to the terminal.`
      );
    }
    return `smtp (${env("SMTP_HOST")}:${env("SMTP_PORT") ?? 587}) as ${fromAddress()}`;
  }

  if (kind === "ethereal") {
    return "ethereal (throwaway inbox; preview URLs are logged)";
  }

  return "console (links printed to this terminal, nothing sent)";
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

let cached: Promise<Transporter> | null = null;

/**
 * Built once, lazily.
 *
 * Lazily because importing this module must not open a socket — it is pulled in
 * transitively by code the test suites run constantly. Once, because Ethereal
 * account creation is a network round trip and a new inbox per email would
 * scatter the messages across unrelated mailboxes.
 */
function transporter(): Promise<Transporter> {
  if (cached) return cached;

  cached = (async () => {
    const kind = transportKind();

    if (kind === "ethereal") {
      const account = await nodemailer.createTestAccount();
      console.log(`[mail] ethereal inbox ready: ${account.user}`);
      return nodemailer.createTransport({
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
        auth: { user: account.user, pass: account.pass },
      });
    }

    const port = Number(env("SMTP_PORT") ?? 587);
    return nodemailer.createTransport({
      host: env("SMTP_HOST"),
      port,
      // Implicit TLS on 465, STARTTLS everywhere else. Overridable because a
      // few providers disagree about which they want.
      secure: env("SMTP_SECURE") ? env("SMTP_SECURE") === "true" : port === 465,
      auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") },
    });
  })();

  return cached;
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

type Message = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * Extra headers. Used for List-Unsubscribe, which is what makes a mail
   * client's own unsubscribe button appear — see lib/unsubscribe.ts.
   */
  headers?: Record<string, string>;
};

/**
 * Returns the provider's message id where there is one.
 *
 * The two account emails ignore it: they are best-effort by design and there is
 * nothing to record it on. Notification email stores it in the delivery ledger,
 * which is what lets a moderator answer "did the buyer get the refund email?"
 * with a provider reference rather than a shrug.
 */
async function deliver(
  message: Message,
  consoleLabel: string,
  consoleBody: string,
  rethrow = false
): Promise<{ messageId: string | null }> {
  if (transportKind() === "console") {
    console.log("\n" + "=".repeat(70));
    console.log(`[dev-mode email] ${consoleLabel} for ${message.to}`);
    console.log(consoleBody);
    console.log("=".repeat(70) + "\n");
    return { messageId: null };
  }

  try {
    const info = await (await transporter()).sendMail({
      from: fromAddress(),
      ...message,
    });

    // Ethereal renders the message at a URL. Logged because it is the entire
    // point of that transport — otherwise the mail is delivered somewhere
    // nobody can look at.
    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) console.log(`[mail] ${message.to} -> read it at ${preview}`);
    else console.log(`[mail] sent to ${message.to} (${info.messageId})`);

    return { messageId: info.messageId ?? null };
  } catch (err) {
    /**
     * Swallowed for the two ACCOUNT emails, rethrown for notifications.
     *
     * The difference is whether anything is recording the outcome. A failed
     * verification email has nowhere to be written down, the account already
     * exists, and the product has a resend path — so failing the request would
     * be strictly worse than not sending.
     *
     * A failed notification email has the delivery ledger waiting for it, and
     * swallowing the error there would mark it SENT when it was not, which is
     * exactly the lie ADR 0026 exists to prevent.
     */
    if (rethrow) throw err;

    console.error(
      `\n[mail] FAILED to send "${message.subject}" to ${message.to}\n` +
        `  ${(err as Error).message}\n` +
        `  The account was still created. They can request another link at ` +
        `/auth/resend-verification.\n`
    );
    return { messageId: null };
  }
}

/**
 * The shared frame around every message.
 *
 * Inline styles and a table-free single column, because email clients are not
 * browsers: Outlook ignores most of a stylesheet, and Gmail strips <style> in
 * some contexts. Kept deliberately plain — a marketplace confirmation that
 * looks like a newsletter reads as a phishing attempt.
 */
function wrap(heading: string, body: string, cta?: { label: string; url: string }) {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#000">
    <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:32px">
      <p style="margin:0 0 24px;font-size:18px;font-weight:600;letter-spacing:-0.01em">RetailStore_2n</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;line-height:1.3">${heading}</h1>
      <div style="font-size:15px;line-height:1.6;color:#3c4043">${body}</div>
      ${
        cta
          ? `<p style="margin:28px 0 0">
        <a href="${cta.url}" style="display:inline-block;background:#c93131;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:15px;font-weight:600">${cta.label}</a>
      </p>
      <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#5f6368">
        If the button does not work, paste this into your browser:<br>
        <span style="word-break:break-all;color:#3c4043">${cta.url}</span>
      </p>`
          : ""
      }
      <p style="margin:28px 0 0;padding-top:20px;border-top:1px solid #e5e5e5;font-size:12px;line-height:1.6;color:#5f6368">
        RetailStore_2n is a marketplace for secondhand goods. You are receiving this
        because someone used this address to sign up. If that was not you, you
        can ignore it — nothing happens until the link above is opened.
      </p>
    </div>
  </body>
</html>`;
}

/**
 * The "you asked to reset your password" email.
 *
 * Deliberately says what to do if it was NOT them: nothing. No "click here if
 * this wasn't you" link — that link would itself be a thing an attacker could
 * get somebody to click, and doing nothing is genuinely the correct action
 * because the password only changes when the link below is used.
 */
export async function sendPasswordResetEmail(email: string, resetUrl: string) {
  await deliver(
    {
      to: email,
      subject: "Reset your password",
      text: [
        "Somebody asked to reset the password for this RetailStore_2n account.",
        "",
        "If it was you, open this link:",
        resetUrl,
        "",
        "The link works once and expires in one hour.",
        "",
        "If it was not you, do nothing. Your password has not changed and this",
        "link will expire on its own.",
      ].join("\n"),
      html: wrap(
        "Reset your password",
        `<p style="margin:0">Somebody asked to reset the password for this account.</p>
         <p style="margin:12px 0 0">The link works once and expires in <strong>one hour</strong>.</p>
         <p style="margin:12px 0 0">If it wasn't you, do nothing — your password
         hasn't changed and the link will expire on its own.</p>`,
        { label: "Choose a new password", url: resetUrl }
      ),
    },
    "Password reset link",
    resetUrl
  );
}

export async function sendVerificationEmail(email: string, verifyUrl: string) {
  await deliver(
    {
      to: email,
      subject: "Confirm your email address",
      // Plain text is not a courtesy. Some clients render only this, and a
      // message with no text part scores worse with spam filters.
      text: [
        "Welcome to RetailStore_2n.",
        "",
        "Confirm your email address by opening this link:",
        verifyUrl,
        "",
        "The link works once and expires in 24 hours.",
        "",
        "If you did not sign up, you can ignore this message.",
      ].join("\n"),
      html: wrap(
        "Confirm your email address",
        `<p style="margin:0">One step left. Confirming your address is what lets you
         buy, sell, and be contacted about your orders.</p>
         <p style="margin:12px 0 0">The link works once and expires in 24 hours.</p>`,
        { label: "Confirm my email", url: verifyUrl }
      ),
    },
    "Verification link",
    verifyUrl
  );
}

/* ------------------------------------------------------------------ *
 * Notification email
 *
 * Everything above is an ACCOUNT email — a link somebody is waiting for,
 * addressed to an inbox rather than to a user. What follows is about something
 * that happened to a person who already has an account, which changes three
 * things: it is governed by preferences, it must carry an unsubscribe path, and
 * its outcome is recorded in the delivery ledger.
 * ------------------------------------------------------------------ */

/**
 * The message body is NOT rendered here.
 *
 * `title` and `body` were written when the notification was created and are
 * already addressed to this person in plain language — "Cast iron skillet
 * sold", "You've been refunded for it". Re-deriving a subject line from the
 * event type would produce something worse and would drift from what the same
 * person sees in the app.
 *
 * So the email is a frame around text that already exists. That is also what
 * keeps this function from needing a template per NotificationType, and a new
 * type from needing one before it can be emailed at all.
 */
export async function sendNotificationEmail(input: {
  to: string;
  title: string;
  body: string | null;
  /** Absolute URL, or null when the notification has nowhere to go. */
  actionUrl: string | null;
  actionLabel: string;
  unsubscribeUrl: string;
  headers: Record<string, string>;
}): Promise<{ messageId: string | null }> {
  const footer =
    `\n\nYou are receiving this because of activity on your RetailStore_2n account.` +
    `\nChange what you are emailed about: ${input.unsubscribeUrl}`;

  return deliver(
    {
      to: input.to,
      subject: input.title,
      text:
        [input.title, "", input.body ?? "", input.actionUrl ? `\n${input.actionUrl}` : ""]
          .filter(Boolean)
          .join("\n")
          .trim() + footer,
      html: wrapNotification(
        input.title,
        input.body,
        input.actionUrl ? { label: input.actionLabel, url: input.actionUrl } : undefined,
        input.unsubscribeUrl
      ),
      headers: input.headers,
    },
    `Notification: ${input.title}`,
    [input.body, input.actionUrl].filter(Boolean).join("\n"),
    // Rethrow, so the ledger records FAILED instead of SENT.
    true
  );
}

/**
 * Like wrap(), with a different footer.
 *
 * Not folded into wrap() with a flag: the account footer says "you are getting
 * this because someone typed this address into a signup form, and nothing
 * happens unless you click", which is true of a verification link and false of
 * everything here. One frame saying both would be saying neither.
 */
function wrapNotification(
  heading: string,
  body: string | null,
  cta: { label: string; url: string } | undefined,
  unsubUrl: string
) {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#000">
    <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:32px">
      <p style="margin:0 0 24px;font-size:18px;font-weight:600;letter-spacing:-0.01em">RetailStore_2n</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;line-height:1.3">${escapeHtml(heading)}</h1>
      ${body ? `<div style="font-size:15px;line-height:1.6;color:#3c4043">${escapeHtml(body)}</div>` : ""}
      ${
        cta
          ? `<p style="margin:28px 0 0">
        <a href="${cta.url}" style="display:inline-block;background:#c93131;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:15px;font-weight:600">${escapeHtml(cta.label)}</a>
      </p>`
          : ""
      }
      <p style="margin:28px 0 0;padding-top:20px;border-top:1px solid #e5e5e5;font-size:12px;line-height:1.6;color:#5f6368">
        You are receiving this because of activity on your RetailStore_2n account.<br>
        <a href="${unsubUrl}" style="color:#5f6368">Change what you are emailed about</a>.
      </p>
    </div>
  </body>
</html>`;
}

/**
 * Notification text is user-supplied in every practical sense — a listing title
 * a seller typed, a moderator's stated reason — and it lands in HTML here. The
 * two account emails above interpolate only URLs this server built, which is
 * why they have never needed this.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
