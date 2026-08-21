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

/**
 * A session outlives a season. Ninety days with a sliding expiry means someone
 * who checks in weekly is never logged out at all, which is the single biggest
 * reduction in sign-in emails available to a league this size.
 */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Only slide the expiry once a day; it need not be written on every render. */
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/** Cap on unconsumed links per user, per window, to stop mailbox flooding. */
export const MAX_ACTIVE_TOKENS_PER_USER = 5;


/**
 * Admin-minted invite links live longer than emailed ones.
 *
 * Fifteen minutes is right for a link somebody just asked for and is watching
 * their inbox for. An invite pasted into a group chat on Thursday might not be
 * opened until Sunday, and a dead link is how someone gives up on joining. The
 * tradeoff is a wider window in which a copied link still works, which is why
 * it is single-use, logged when minted, logged when used, and disclosed to the
 * member it belongs to.
 */
export const INVITE_LINK_TTL_MS = 72 * 60 * 60 * 1000;
