import { API, WEB } from "./db";

/**
 * HTTP with cookies, for driving the API as a signed-in user.
 *
 * Five suites carried their own copy of this. The cookie jar matters: auth is
 * httpOnly cookies with a rotating refresh token, so a suite that does not
 * carry Set-Cookie forward loses its session on the first refresh — and the
 * failure looks like a permissions bug rather than a test bug.
 */

export type Reply<T = any> = { status: number; json: T; text: string };

export class Client {
  private cookies = new Map<string, string>();
  /** Which base URL: the BFF on :3000, or the API on :4000. */
  readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorb(res: Response) {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(this.cookies.size ? { cookie: this.header() } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorb(res);

    const text = res.status === 204 ? "" : await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON — an HTML error page, usually. Kept so the caller can see it.
      json = { raw: text.slice(0, 300) };
    }
    return { status: res.status, json, text };
  }

  get<T = any>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T = any>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body);
  }
  put<T = any>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, body);
  }
  patch<T = any>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body);
  }
  delete<T = any>(path: string, body?: unknown) {
    return this.request<T>("DELETE", path, body);
  }
}

/** Talks to the Next.js BFF, i.e. exactly the path a browser takes. */
export function web() {
  return new Client(WEB);
}

/** Talks to the Express API directly, bypassing the BFF. */
export function api() {
  return new Client(API);
}

/** Unauthenticated fetch against the public catalog. */
export async function catalog<T = any>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`catalog ${path} -> ${r.status}`);
  return r.json() as Promise<T>;
}
