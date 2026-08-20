import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * SS10. Tokens are generated here and stored only as hashes.
 *
 * The raw value lives in the emailed URL and in the user's cookie; the database
 * holds sha256(raw). A dump of this database therefore yields nothing anyone
 * can log in with, which is the whole point of not storing passwords.
 */

/** 32 bytes of CSPRNG entropy, URL-safe. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Constant-time comparison of two hex hashes. Lookups go through a unique index
 * on the hash, so this is belt-and-braces for the paths that compare directly.
 */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** SS10: a magic link is short-lived. Fifteen minutes is plenty for email. */
export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

/** A session outlives a season's worth of Sunday afternoons. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Cap on unconsumed links per user, per window, to stop mailbox flooding. */
export const MAX_ACTIVE_TOKENS_PER_USER = 5;
