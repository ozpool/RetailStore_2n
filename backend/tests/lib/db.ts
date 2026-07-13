import path from "path";
import dotenv from "dotenv";
import { PrismaClient } from "../../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Database access for tests, through Prisma.
 *
 * WHY NOT `docker exec psql`
 * Thirteen of these suites used to shell out to psql. It worked, but it made
 * the tests depend on a container being named a particular way, and every query
 * had to survive two layers of shell quoting — which broke twice, once on a
 * `"userId"` identifier and once on a `::uuid` cast that Postgres didn't want.
 * Prisma has neither problem, is typed, and works against any Postgres rather
 * than only a local Docker one.
 */

// Tests are run from the backend package root, but also directly by path, so
// the env file is resolved relative to this file rather than the cwd.
dotenv.config({ path: path.join(import.meta.dirname, "..", "..", ".env") });

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

export async function disconnect() {
  await prisma.$disconnect();
}

/** Where the API and the BFF live. Overridable so a suite can hit a deployment. */
export const API = process.env.TEST_API_URL ?? "http://localhost:4000";
export const WEB = process.env.TEST_WEB_URL ?? "http://localhost:3000";

/**
 * Confirms the things a suite needs are actually up.
 *
 * Without this, a stopped backend produces forty confusing assertion failures
 * instead of one clear sentence — which is exactly what happened when the API
 * was down and the frontend reported "fetch failed".
 */
export async function requireServices(opts: { api?: boolean; web?: boolean; db?: boolean } = {}) {
  const need = { api: true, web: false, db: true, ...opts };
  const problems: string[] = [];

  if (need.db) {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      problems.push(`Postgres unreachable at DATABASE_URL: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  if (need.api) {
    try {
      const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) problems.push(`API at ${API} returned ${r.status}`);
    } catch {
      problems.push(`API not running at ${API} — start it with: npm run dev`);
    }
  }

  if (need.web) {
    try {
      const r = await fetch(WEB, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) problems.push(`Frontend at ${WEB} returned ${r.status}`);
    } catch {
      problems.push(`Frontend not running at ${WEB} — start it with: npm run dev in frontend/`);
    }
  }

  if (problems.length) {
    console.error("\nCannot run: prerequisites missing\n");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("");
    process.exit(2);
  }
}

/** A seeded catalog is a prerequisite too; several suites buy real listings. */
export async function requireCatalog(minimum = 6) {
  const count = await prisma.listing.count({ where: { status: "ACTIVE", deletedAt: null } });
  if (count < minimum) {
    console.error(
      `\nCannot run: only ${count} active listings, need ${minimum}.\n` +
        "  Seed the catalog with: npx prisma db seed\n"
    );
    process.exit(2);
  }
  return count;
}
