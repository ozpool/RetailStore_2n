/**
 * Assertions, and the shape every suite shares.
 *
 * Previously each suite carried its own copy of `check()` — fourteen of them,
 * drifting apart. One copy here means a fix to the reporting applies everywhere,
 * and it gives the runner a single place to collect totals from.
 */

export type Result = { label: string; ok: boolean; detail: string };

export class Suite {
  readonly name: string;
  readonly results: Result[] = [];

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Records one assertion.
   *
   * `detail` is printed only on failure, and should carry the ACTUAL value.
   * A failure that says "expected true" and nothing else costs a debugging
   * round trip every time.
   */
  check(ok: boolean, label: string, detail: unknown = ""): boolean {
    const text = typeof detail === "string" ? detail : JSON.stringify(detail);
    this.results.push({ label, ok, detail: text });
    if (ok) {
      console.log(`  PASS  ${label}`);
    } else {
      console.log(`  FAIL  ${label}${text ? ` — ${text}` : ""}`);
    }
    return ok;
  }

  /** A labelled group, purely to make long output readable. */
  section(title: string) {
    console.log(`\n[${title}]`);
  }

  note(message: string) {
    console.log(`      ${message}`);
  }

  get passed() {
    return this.results.filter((r) => r.ok).length;
  }

  get failed() {
    return this.results.filter((r) => !r.ok).length;
  }
}

/**
 * Runs one suite to completion and reports.
 *
 * `cleanup` is passed separately and runs in a finally, because a suite that
 * throws halfway is exactly when leftover data does damage — this codebase has
 * had a half-finished run mark real listings SOLD and quietly shrink the shop
 * three times. Cleanup is not the suite's last statement; it is unconditional.
 */
export async function runSuite(
  name: string,
  body: (t: Suite) => Promise<void>,
  cleanup?: (t: Suite) => Promise<void>
): Promise<Suite> {
  const t = new Suite(name);
  console.log("=".repeat(70));
  console.log(name.toUpperCase());
  console.log("=".repeat(70));

  let thrown: unknown = null;
  try {
    await body(t);
  } catch (err) {
    thrown = err;
    t.check(false, "suite ran to completion", String((err as Error)?.message ?? err).slice(0, 200));
  } finally {
    if (cleanup) {
      console.log("\ncleaning up");
      try {
        await cleanup(t);
      } catch (err) {
        t.check(false, "cleanup succeeded", String((err as Error)?.message ?? err).slice(0, 200));
      }
    }
  }

  console.log(`\n${t.passed} passed, ${t.failed} failed`);
  if (thrown) console.error(thrown);
  return t;
}

/**
 * Entry point for running a suite as its own process.
 *
 * CALL THIS WITHOUT `await`: `void main(...)`. tsx compiles this project as
 * CJS, where top-level await is a hard transform error. Nothing is lost — this
 * ends by exiting the process.
 */
export async function main(
  name: string,
  body: (t: Suite) => Promise<void>,
  cleanup?: (t: Suite) => Promise<void>
) {
  const t = await runSuite(name, body, cleanup);
  const { disconnect } = await import("./db");
  await disconnect();

  /**
   * NOT `process.exit()`, and the reason is a Windows crash that reports as a
   * failing suite.
   *
   * `process.exit()` here aborts in libuv —
   * `!(handle->flags & UV_HANDLE_CLOSING)` in win/async.c — *after* every
   * assertion has passed. The runner sees the non-zero exit and prints
   * "FAIL … 20 passed" with nothing actually failed, which is the worst kind of
   * red: it teaches you to ignore red.
   *
   * AN EARLIER NOTE HERE BLAMED PRISMA. That was wrong. It reproduces with no
   * Prisma anywhere — three `fetch` calls and `process.exit(0)` is enough, and
   * it does not matter whether the response bodies are consumed, whether the
   * target is the API or MinIO, or whether undici's global dispatcher has been
   * closed first. All four were tried. The only thing that fixes it is not
   * calling `process.exit()`.
   *
   * It is also racy rather than deterministic, which is why most suites got
   * away with it and the storage suite — whose last act is a fetch immediately
   * before this line — did not.
   *
   * So: set the code and let the loop drain, with a short ceiling.
   *
   * MOST SUITES DO NOT DRAIN ON THEIR OWN. Something — a pooled Postgres
   * socket, a keep-alive HTTP connection, a provider SDK's agent — outlives the
   * work by design, so the ceiling is the normal path rather than an
   * emergency. It was 8s first, which is fine for one suite and three minutes
   * across twenty-four.
   *
   * 1500ms: everything is finished by then, and the only thing being waited on
   * is sockets closing themselves. `unref`'d so a suite that genuinely does
   * drain exits immediately rather than sitting out the full wait.
   */
  process.exitCode = t.failed === 0 ? 0 : 1;

  const bail = setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
  bail.unref();
}

/** Ctrl+C must still clean up. Suites register their teardown here. */
const onInterrupt: Array<() => Promise<void>> = [];

export function cleanupOnInterrupt(fn: () => Promise<void>) {
  onInterrupt.push(fn);
}

let interruptWired = false;
export function wireInterrupt() {
  if (interruptWired) return;
  interruptWired = true;
  process.once("SIGINT", async () => {
    console.log("\ninterrupted — cleaning up");
    for (const fn of onInterrupt) {
      try {
        await fn();
      } catch {
        // Best effort; an interrupt is already an abnormal exit.
      }
    }
    const { disconnect } = await import("./db");
    await disconnect().catch(() => {});
    process.exit(130);
  });
}
