import "dotenv/config";
import { prisma } from "../src/lib/prisma";

/**
 * Measures what horizontal scaling does to a rate limit.
 *
 * THE CLAIM BEING TESTED
 * /auth/password/change allows 10 attempts per 15 minutes per user. That limit
 * is not politeness: the endpoint verifies the CURRENT password, so without a
 * cap it is a password oracle for anyone holding a stolen session.
 *
 * Held in one process the limit is 10. Held in three processes it is 30, and
 * nothing in the response says so — each instance is enforcing its own count
 * correctly and the aggregate is wrong. That is the number this script prints.
 *
 *   # one instance
 *   npx tsx scripts/ratelimit-demo.ts --targets http://localhost:4000
 *
 *   # three instances, sharing nothing
 *   npx tsx scripts/ratelimit-demo.ts \
 *     --targets http://localhost:4001,http://localhost:4002,http://localhost:4003
 *
 * Requests are spread round-robin across the targets, which is what a load
 * balancer does. Using the real thing would prove the same point and require a
 * load balancer to be standing up before the measurement can be taken.
 *
 * See docs/adr/0018-redis-for-shared-ephemeral-state.md
 */

const LIMIT = 10;
const WINDOW = "15 minutes";
const ATTEMPTS = 40;

const EMAIL = "rs2.rldemo.subject@retailstore-2n.test";
const PASSWORD = "correct horse battery staple 9";

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

/** A cookie jar, because the session has to survive across targets. */
function jar() {
  const c = new Map<string, string>();
  return {
    header: () => [...c].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb: (r: Response) => {
      for (const raw of r.headers.getSetCookie()) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) c.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
  };
}

async function main() {
  const targets = arg("targets", "http://localhost:4000")
    .split(",")
    .map((t) => t.trim().replace(/\/$/, ""))
    .filter(Boolean);

  console.log("=".repeat(72));
  console.log("RATE LIMIT UNDER HORIZONTAL SCALING");
  console.log("=".repeat(72));
  console.log(`  endpoint   POST /auth/password/change`);
  console.log(`  limit      ${LIMIT} per ${WINDOW}, per user`);
  console.log(`  instances  ${targets.length}  (${targets.join(", ")})`);
  console.log(`  attempts   ${ATTEMPTS}, spread round-robin`);

  /* ---- report what each instance thinks it is using ---- */
  for (const t of targets) {
    const health = await fetch(`${t}/health`).catch(() => null);
    if (!health?.ok) {
      console.error(`\n  ${t} is not answering. Start it first.`);
      process.exit(2);
    }
  }
  console.log(`  store      ${process.env.REDIS_URL ? `redis (${process.env.REDIS_URL})` : "not set here — ask the API"}`);
  console.log("=".repeat(72));

  /* ---- a subject to attack ---- */
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await fetch(`${targets[0]}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Rate Limit Demo", email: EMAIL, password: PASSWORD }),
  });
  await prisma.user.update({ where: { email: EMAIL }, data: { emailVerified: true } });

  const session = jar();
  const login = await fetch(`${targets[0]}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  session.absorb(login);
  if (!login.ok) {
    console.error("could not log the subject in:", login.status);
    process.exit(1);
  }

  /* ---- fire ---- */
  const perTarget = new Map<string, { allowed: number; limited: number }>();
  for (const t of targets) perTarget.set(t, { allowed: 0, limited: 0 });

  const results = await Promise.all(
    Array.from({ length: ATTEMPTS }, async (_, i) => {
      const target = targets[i % targets.length];
      const res = await fetch(`${target}/auth/password/change`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: session.header() },
        // Deliberately wrong: this measures how many ATTEMPTS get through to be
        // checked, which is exactly what an attacker with a stolen session gets.
        body: JSON.stringify({
          currentPassword: `guess-${i}`,
          newPassword: "a new password that is long enough 1",
        }),
      });
      const bucket = perTarget.get(target)!;
      if (res.status === 429) bucket.limited++;
      else bucket.allowed++;
      return res.status;
    })
  );

  const allowed = results.filter((s) => s !== 429).length;
  const limited = results.filter((s) => s === 429).length;

  console.log("");
  for (const [t, c] of perTarget) {
    console.log(`  ${t.padEnd(30)} ${String(c.allowed).padStart(3)} reached the password check`);
  }

  console.log("");
  console.log("-".repeat(72));
  console.log(`  attempts that reached the password check : ${allowed}`);
  console.log(`  refused with 429                         : ${limited}`);
  console.log(`  the limit says it should be              : ${LIMIT}`);
  console.log("-".repeat(72));

  if (allowed === LIMIT) {
    console.log(`  HOLDS. ${targets.length} instance(s) enforced one shared limit.`);
  } else if (allowed > LIMIT) {
    const factor = (allowed / LIMIT).toFixed(1);
    console.log(`  BROKEN. ${allowed} attempts got through where ${LIMIT} are allowed —`);
    console.log(`  ${factor}x the stated limit, because each instance counts alone.`);
  } else {
    console.log(`  Fewer than the limit got through. Earlier attempts in this`);
    console.log(`  window, or the store is failing closed.`);
  }
  console.log("=".repeat(72));

  await prisma.user.deleteMany({ where: { email: EMAIL } });
  process.exit(0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
