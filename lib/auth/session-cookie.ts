import { cookies } from "next/headers";

import { SESSION_TTL_MS } from "./tokens";

/**
 * The session cookie. httpOnly so script cannot read it, sameSite lax so the
 * click-through from an email still arrives with it, secure outside
 * development.
 */
export const SESSION_COOKIE = "ls_session";

/**
 * Shared cookie attributes.
 *
 * These are exported because a redirect response has to carry the cookie
 * itself: setting it through the cookies() store does NOT attach it to a
 * NextResponse.redirect(), so the magic-link callback would send the user to a
 * page that immediately bounced them back to sign in. Found by clicking an
 * actual link rather than by any test.
 */
export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

/** For server actions, where the cookies() store is applied to the response. */
export async function writeSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
