import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * promisify() drops the options overload, and the options are the entire point
 * -- they carry the cost parameters.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived as Buffer);
    });
  });
}

/**
 * Password hashing.
 *
 * A deliberate departure from SS10 ("No passwords stored"), taken because the
 * league is ~60 people rather than the handful the spec imagined. A magic link
 * is a pleasant way to log in once a month and a miserable one at 12:55 on a
 * Sunday: the round trip through an email app frequently lands the session
 * cookie in a different browser from the one the person started in, and the
 * deadline does not move for anybody's spam folder.
 *
 * Magic links remain, for joining and for recovery -- which is why there is no
 * "forgot password" flow here. That path already exists, and it is better than
 * a reset email because it is the same single-use, 15-minute token.
 *
 * scrypt comes from Node core: no dependency, memory-hard, and in the standard
 * library of a runtime that already ships everywhere this app runs.
 */

/** ~100ms per hash on modern hardware, and 16MB of memory per attempt. */
const SCRYPT_COST = 16_384; // N
const SCRYPT_BLOCK_SIZE = 8; // r
const SCRYPT_PARALLELISM = 1; // p
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * SS10 is gone but its spirit is not: the stored value must be useless to
 * anyone who steals the database. Parameters are stored alongside the hash so
 * they can be raised later without invalidating existing passwords.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    // Node refuses scrypt above a default memory ceiling; raise it to match N.
    maxmem: 64 * 1024 * 1024,
  });

  return [
    "scrypt",
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELISM,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, costRaw, blockRaw, parallelRaw, saltRaw, hashRaw] = parts;
  const N = Number.parseInt(costRaw!, 10);
  const r = Number.parseInt(blockRaw!, 10);
  const p = Number.parseInt(parallelRaw!, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(saltRaw!, "base64");
  const expected = Buffer.from(hashRaw!, "base64");

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }

  // Lengths are equal by construction, but timingSafeEqual throws if they are
  // not, and a throw here would itself be an oracle.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export interface PasswordProblem {
  ok: false;
  reason: string;
}

/**
 * Deliberately not a character-class checklist. Length is what actually
 * resists guessing, and complexity rules mostly produce P@ssw0rd1 -- which is
 * both harder to remember and easier to crack than four ordinary words.
 */
export const MIN_PASSWORD_LENGTH = 10;

const OBVIOUS = new Set([
  "password",
  "password1",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyuiop",
  "letmein123",
  "football",
  "iloveyou",
  "loversurvivor",
  "losersurvivor",
]);

export function validatePassword(password: string): { ok: true } | PasswordProblem {
  const trimmed = password.trim();

  if (trimmed.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: `Please use at least ${MIN_PASSWORD_LENGTH} characters. A few ordinary words is fine, and easier to remember.`,
    };
  }
  if (trimmed.length > 200) {
    return { ok: false, reason: "That password is too long." };
  }
  if (OBVIOUS.has(trimmed.toLowerCase().replace(/\s+/g, ""))) {
    return { ok: false, reason: "That password is one of the first anybody would guess." };
  }

  return { ok: true };
}

/**
 * Lockout schedule after repeated failures. Grows quickly enough to make
 * guessing pointless, but never locks an account permanently -- a member
 * locked out on a Sunday can still get in by magic link.
 */
export function lockoutMsFor(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  if (failedAttempts < 8) return 60_000; // a minute
  if (failedAttempts < 12) return 15 * 60_000;
  return 60 * 60_000; // an hour, and no longer
}
