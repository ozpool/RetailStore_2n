import { createClient, type RedisClientType } from "redis";

/**
 * The Redis connection, and nothing else.
 *
 * Two modules need Redis — the rate limiter and the cache — and they must not
 * each open their own. A second connection would double the socket count per
 * instance, duplicate the reconnect and error-handling policy, and give the
 * test suite two lifecycles to tear down instead of one. It also makes
 * "is Redis reachable?" a question with two possible answers.
 *
 * WHAT IS ALLOWED IN HERE
 * Connection management. No keys, no commands, no policy. The decisions about
 * what to store and what to do when this is unavailable belong to the callers,
 * because those answers are genuinely different: the rate limiter mostly fails
 * open but closes for the admin panel, and the cache always falls through to
 * Postgres. A shared client with a shared failure policy would be wrong.
 *
 * See docs/adr/0018-redis-for-shared-ephemeral-state.md
 */

export function redisUrl(): string | undefined {
  const raw = process.env.REDIS_URL;
  if (raw === undefined) return undefined;
  // Trimmed, blank treated as absent — a leading space is truthy and would pass
  // every "is it configured?" check before failing at connect time.
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isRedisConfigured(): boolean {
  return redisUrl() !== undefined;
}

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType> | null = null;

/**
 * The shared client, connected on first use.
 *
 * Throws when REDIS_URL is unset or the connection fails. Every caller catches:
 * there is no version of this that returns a half-working client, and a caller
 * that cannot handle the failure has no business using Redis.
 */
export async function getRedis(): Promise<RedisClientType> {
  if (client?.isReady) return client;
  if (connecting) return connecting;

  const url = redisUrl();
  if (!url) throw new Error("REDIS_URL is not set");

  connecting = (async () => {
    const c = createClient({
      url,
      socket: {
        // Bounded: five attempts with a rising delay, then give up and let each
        // caller's failure policy decide. An unbounded reconnect loop turns a
        // dead Redis into a request that hangs rather than one that fails.
        reconnectStrategy: (attempts) => (attempts > 5 ? false : Math.min(attempts * 200, 2000)),
        connectTimeout: 3000,
      },
    }) as RedisClientType;

    // Without a listener, a connection error is an unhandled 'error' event and
    // takes the process down — which would make a Redis blip fatal to the API.
    c.on("error", (err) => {
      console.error("[redis]", (err as Error).message);
    });

    await c.connect();
    client = c;
    return c;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/**
 * Closes the connection so a process can exit without a lingering socket.
 *
 * Also the reset point for tests, which repoint REDIS_URL at a dead port to
 * exercise the failure policies and need the next call to reconnect rather than
 * reuse a client pointing somewhere else.
 */
export async function disconnectRedis(): Promise<void> {
  if (client?.isReady) await client.quit();
  client = null;
}
