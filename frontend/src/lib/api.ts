export type User = {
  id: string;
  name: string;
  email: string;
  isSeller: boolean;
  emailVerified: boolean;
  /** Public URL of the stored avatar, or null to fall back to initials. */
  avatarUrl: string | null;
  createdAt: string;
};

export class ApiError extends Error {
  code?: string;
  field?: string;

  constructor(message: string, code?: string, field?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.field = field;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    // FormData sets its own multipart Content-Type with a boundary; overriding
    // it would make the body unparseable.
    headers:
      options.body instanceof FormData
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(body.error ?? "Something went wrong. Please try again.", body.code, body.field);
  }

  return body as T;
}

export function signup(input: { name: string; email: string; password: string }) {
  // With email verification on, the response was { message: string; email: string }.
  return request<{ user: User }>("/auth/signup", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function login(input: { email: string; password: string }) {
  return request<{ user: User }>("/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function logout() {
  return request<void>("/auth/logout", { method: "POST" });
}

export function me() {
  return request<{ user: User }>("/auth/me");
}

export function verifyEmail(token: string) {
  return request<{ user: User }>("/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export function resendVerification(email: string) {
  return request<{ message: string }>("/auth/resend-verification", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

/* ---- passwords ---- */

/**
 * Change your password while signed in.
 *
 * `otherSessionsEnded` is surfaced rather than swallowed: somebody changing
 * their password because they suspect a break-in wants to be told the other
 * sessions actually died.
 */
export function changePassword(input: { currentPassword: string; newPassword: string }) {
  return request<{ ok: true; otherSessionsEnded: number; message: string }>(
    "/auth/password/change",
    { method: "POST", body: JSON.stringify(input) }
  );
}

/**
 * Ask for a reset link.
 *
 * Always succeeds, whether or not the address has an account — the API answers
 * identically on purpose, so the UI must not imply otherwise either.
 */
export function forgotPassword(email: string) {
  return request<{ message: string }>("/auth/password/forgot", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export function resetPassword(input: { token: string; newPassword: string }) {
  return request<{ ok: true; message: string }>("/auth/password/reset", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function becomeSeller() {
  return request<{ user: User }>("/auth/become-seller", { method: "POST" });
}

export type MyReview = {
  id: string;
  rating: number;
  body: string | null;
  createdAt: string;
  edited: boolean;
  listing: {
    slug: string;
    title: string;
    priceCents: number;
    currency: string;
    image: string | null;
    available: boolean;
  };
};

export function getMyReviews() {
  return request<{ reviews: MyReview[] }>("/profile/reviews");
}

export function uploadAvatar(file: File) {
  const form = new FormData();
  form.append("avatar", file);
  return request<{ user: User }>("/profile/avatar", { method: "POST", body: form });
}

export function removeAvatar() {
  return request<{ user: User }>("/profile/avatar", { method: "DELETE" });
}
