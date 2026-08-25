import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.join(import.meta.dirname, "..", ".env") });
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Grants or revokes admin, from a shell.
 *
 * WHY THERE IS NO ENDPOINT FOR THIS
 * Not because an endpoint would be hard to find — this repository is public, so
 * obscurity buys nothing and the design deliberately does not rely on it. The
 * point is that no endpoint EXISTS. Privilege escalation is therefore not an
 * HTTP problem at all: it requires shell access to the server. An attacker who
 * already has that has bigger prizes than the admin panel.
 *
 * The trade is that the CLI becomes the thing to protect. In production that
 * means SSH keys rather than shared logins, and the output below is deliberately
 * loud so a grant leaves a trace in deployment logs rather than happening
 * silently.
 *
 *   npm run admin:grant  -- someone@example.com
 *   npm run admin:revoke -- someone@example.com
 *   npm run admin:list
 */

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function stamp() {
  return new Date().toISOString();
}

async function list() {
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { email: true, name: true, createdAt: true, suspendedAt: true },
    orderBy: { email: "asc" },
  });

  if (admins.length === 0) {
    console.log("No admins.");
    return;
  }
  console.log(`${admins.length} admin${admins.length === 1 ? "" : "s"}:`);
  for (const a of admins) {
    console.log(`  ${a.email.padEnd(36)} ${a.name}${a.suspendedAt ? "  [SUSPENDED]" : ""}`);
  }
}

async function setRole(email: string, role: "ADMIN" | "USER") {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, role: true, totpConfirmedAt: true },
  });

  if (!user) {
    console.error(`\nNo account with email "${email}".`);
    console.error("The person must have signed up before they can be made an admin.\n");
    process.exit(1);
  }

  if (user.role === role) {
    console.log(`${user.email} is already ${role}. Nothing to do.`);
    return;
  }

  /**
   * Revoking also clears the two-factor enrolment.
   *
   * This is the documented way out of a lost authenticator: revoke, re-grant,
   * enrol again. Without the clear it is not a way out at all — the secret
   * survives, /admin/totp/setup answers ALREADY_ENROLLED, and the account can
   * never open the panel again. Both the ADR and that endpoint's own error
   * message promised this behaviour before the code did it.
   *
   * Safe to clear because the secret has exactly one use, which is the admin
   * panel. Losing the role means losing the only thing it unlocked.
   */
  const clearTotp = role === "USER";

  await prisma.user.update({
    where: { id: user.id },
    data: clearTotp
      ? { role, totpSecret: null, totpConfirmedAt: null, totpLastUsedAt: null }
      : { role },
  });

  // Loud on purpose: this should be visible in whatever captures stdout.
  console.log("");
  console.log("=".repeat(64));
  console.log(role === "ADMIN" ? "  ADMIN GRANTED" : "  ADMIN REVOKED");
  console.log("=".repeat(64));
  console.log(`  account : ${user.email} (${user.name})`);
  console.log(`  from    : ${user.role}`);
  console.log(`  to      : ${role}`);
  console.log(`  at      : ${stamp()}`);
  console.log(`  by      : ${process.env.USERNAME ?? process.env.USER ?? "unknown shell user"}`);
  console.log("=".repeat(64));

  if (role === "ADMIN") {
    console.log("");
    console.log("  Signing in normally does NOT open the admin panel.");
    console.log("  They must re-authenticate at /admin — a separate, short-lived session.");
    console.log("  First visit will ask them to enrol an authenticator app.");
  } else if (clearTotp && user.totpConfirmedAt) {
    console.log("");
    console.log("  Their two-factor enrolment was cleared.");
    console.log("  Granting admin again will start enrolment from scratch.");
  }
  console.log("");
}

async function main() {
  const [command, email] = process.argv.slice(2);

  if (command === "list") return list();

  if (!email || !command || !["grant", "revoke"].includes(command)) {
    console.error("\nUsage:");
    console.error("  npm run admin:grant  -- someone@example.com");
    console.error("  npm run admin:revoke -- someone@example.com");
    console.error("  npm run admin:list\n");
    process.exit(2);
  }

  await setRole(email.trim().toLowerCase(), command === "grant" ? "ADMIN" : "USER");
}

main()
  .catch(async (err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
