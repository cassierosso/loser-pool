import { timingSafeEqual } from "node:crypto";

/**
 * SS8: every job endpoint is protected by a shared CRON_SECRET bearer token.
 *
 * Fails closed. If CRON_SECRET is unset the endpoint refuses everything rather
 * than running unauthenticated, because the alternative is a public URL that
 * grades weeks.
 */
export type AuthResult = { ok: true } | { ok: false; status: 401 | 503; message: string };

export function authorizeJobRequest(authorizationHeader: string | null): AuthResult {
  const secret = process.env.CRON_SECRET?.trim();

  if (!secret) {
    return {
      ok: false,
      status: 503,
      message: "CRON_SECRET is not configured; job endpoints are disabled.",
    };
  }

  const prefix = "Bearer ";
  if (!authorizationHeader?.startsWith(prefix)) {
    return { ok: false, status: 401, message: "Missing bearer token." };
  }

  const presented = Buffer.from(authorizationHeader.slice(prefix.length));
  const expected = Buffer.from(secret);

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so compare lengths first and always run the constant-time check.
  const lengthsMatch = presented.length === expected.length;
  const equal = lengthsMatch && timingSafeEqual(presented, expected);

  return equal ? { ok: true } : { ok: false, status: 401, message: "Invalid bearer token." };
}
