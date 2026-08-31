import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";

const JWT_SECRET_ENV = process.env.JWT_SECRET;
if (!JWT_SECRET_ENV) {
  throw new Error("JWT_SECRET environment variable is required");
}
const JWT_SECRET: string = JWT_SECRET_ENV;

export const ACCESS_TOKEN_COOKIE = "retailstore_2n_access";
export const REFRESH_TOKEN_COOKIE = "retailstore_2n_refresh";

const ACCESS_TOKEN_TTL = "15m";
export const REFRESH_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ACCESS_TOKEN_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes

export type AccessTokenPayload = {
  userId: string;
};

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(payload: AccessTokenPayload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as unknown as AccessTokenPayload;
  } catch {
    return null;
  }
}

export function generateRefreshToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Sets the session cookies.
 *
 * `refreshToken` is OPTIONAL, for one caller: a refresh that lost a concurrent
 * race. That request needs a working access token, and must NOT overwrite the
 * refresh cookie — the winner of the race already set the current one, and
 * writing a stale value over it would break the session this exists to save.
 * See rotateRefreshToken's grace window.
 */
export function setAuthCookies(
  res: import("express").Response,
  tokens: { accessToken: string; refreshToken?: string }
) {
  const secure = process.env.NODE_ENV === "production";
  res.cookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: ACCESS_TOKEN_MAX_AGE_MS,
    path: "/",
  });
  if (tokens.refreshToken !== undefined) {
    res.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      maxAge: REFRESH_TOKEN_MAX_AGE_MS,
      path: "/",
    });
  }
}

export function clearAuthCookies(res: import("express").Response) {
  res.clearCookie(ACCESS_TOKEN_COOKIE, { path: "/" });
  res.clearCookie(REFRESH_TOKEN_COOKIE, { path: "/" });
}

export function getAccessTokenCookie(req: import("express").Request): string | undefined {
  return req.cookies?.[ACCESS_TOKEN_COOKIE];
}

export function getRefreshTokenCookie(req: import("express").Request): string | undefined {
  return req.cookies?.[REFRESH_TOKEN_COOKIE];
}
