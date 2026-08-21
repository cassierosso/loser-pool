import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { hashPassword, lockoutMsFor, validatePassword, verifyPassword } from "@/lib/auth/password";
import { clearPassword, setPassword, signInWithPassword, resolveSession } from "@/lib/auth/service";
import type { Database, DatabaseHandle } from "@/lib/db/client";
import { users } from "@/lib/db/schema";

import { createTestDatabase, setupLeague } from "../helpers/db";

/**
 * Passwords -- a deliberate departure from SS10, for a league of ~60 rather
 * than the handful the spec imagined.
 */

let handle: DatabaseHandle;
let db: Database;

const NOW = new Date("2024-09-01T12:00:00Z");
const GOOD = "correct horse battery";

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  await setupLeague(db);
});

afterEach(async () => {
  await handle.close();
});

async function member(email = "dana@example.com") {
  const [user] = await db
    .insert(users)
    .values({ email, displayName: "Dana", picksPurchased: 10 })
    .returning();
  return user!;
}

describe("hashing", () => {
  it("round-trips a password", async () => {
    const stored = await hashPassword(GOOD);
    expect(await verifyPassword(GOOD, stored)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const stored = await hashPassword(GOOD);
    expect(await verifyPassword("wrong horse battery", stored)).toBe(false);
  });

  it("never stores the password itself", async () => {
    const stored = await hashPassword(GOOD);
    expect(stored).not.toContain(GOOD);
    expect(stored.startsWith("scrypt$")).toBe(true);
  });

  it("salts, so identical passwords hash differently", async () => {
    expect(await hashPassword(GOOD)).not.toBe(await hashPassword(GOOD));
  });

  it("records its parameters so they can be raised later", async () => {
    const [algorithm, cost, block, parallel] = (await hashPassword(GOOD)).split("$");
    expect(algorithm).toBe("scrypt");
    expect(Number(cost)).toBeGreaterThanOrEqual(16384);
    expect(Number(block)).toBe(8);
    expect(Number(parallel)).toBe(1);
  });

  it("treats visually identical unicode as the same password", async () => {
    // Someone typing an accented character on a phone keyboard should not be
    // locked out by a normalisation difference they cannot see.
    const stored = await hashPassword("café passphrase");
    expect(await verifyPassword("café passphrase", stored)).toBe(true);
  });

  it("survives a malformed stored value without throwing", async () => {
    expect(await verifyPassword(GOOD, "not-a-hash")).toBe(false);
    expect(await verifyPassword(GOOD, "scrypt$x$y$z$a$b")).toBe(false);
    expect(await verifyPassword(GOOD, "")).toBe(false);
  });
});

describe("what counts as an acceptable password", () => {
  it("accepts a few ordinary words", () => {
    expect(validatePassword(GOOD)).toEqual({ ok: true });
  });

  it("rejects anything short", () => {
    const result = validatePassword("short1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("at least 10");
  });

  it("rejects the obvious guesses", () => {
    expect(validatePassword("password1").ok).toBe(false);
    expect(validatePassword("losersurvivor").ok).toBe(false);
  });

  it("does not demand punctuation and digits", () => {
    // Complexity rules mostly produce P@ssw0rd1, which is worse on both counts.
    expect(validatePassword("all lower case words here").ok).toBe(true);
  });
});

describe("signing in", () => {
  it("issues a session for the right password", async () => {
    const user = await member();
    await setPassword(db, { userId: user.id, password: GOOD }, { now: NOW });

    const result = await signInWithPassword(db, { email: user.email, password: GOOD }, { now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await resolveSession(db, result.sessionToken, { now: NOW }))?.id).toBe(user.id);
  });

  it("matches the address case-insensitively", async () => {
    const user = await member();
    await setPassword(db, { userId: user.id, password: GOOD }, { now: NOW });

    const result = await signInWithPassword(db, { email: "  DANA@Example.com ", password: GOOD }, { now: NOW });
    expect(result.ok).toBe(true);
  });

  it("gives the same answer for an unknown address as for a wrong password", async () => {
    // The login form must not become the enumeration oracle that
    // requestLoginLink was carefully written not to be.
    const user = await member();
    await setPassword(db, { userId: user.id, password: GOOD }, { now: NOW });

    const wrongPassword = await signInWithPassword(db, { email: user.email, password: "nope nope nope" }, { now: NOW });
    const unknownUser = await signInWithPassword(db, { email: "stranger@example.com", password: "nope nope nope" }, { now: NOW });

    expect(wrongPassword.ok).toBe(false);
    expect(unknownUser.ok).toBe(false);
    if (wrongPassword.ok || unknownUser.ok) return;
    expect(unknownUser.message).toBe(wrongPassword.message);
  });

  it("refuses a member who has no password, in the same words", async () => {
    const user = await member();
    const result = await signInWithPassword(db, { email: user.email, password: GOOD }, { now: NOW });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("emailed link");
  });

  it("refuses a deactivated member", async () => {
    const user = await member();
    await setPassword(db, { userId: user.id, password: GOOD }, { now: NOW });
    await db.update(users).set({ deactivatedAt: NOW }).where(eq(users.id, user.id));

    expect((await signInWithPassword(db, { email: user.email, password: GOOD }, { now: NOW })).ok).toBe(false);
  });
});

describe("lockout", () => {
  it("does not punish an ordinary typo", () => {
    expect(lockoutMsFor(1)).toBe(0);
    expect(lockoutMsFor(4)).toBe(0);
  });

  it("escalates, then stops at an hour", () => {
    expect(lockoutMsFor(5)).toBe(60_000);
    expect(lockoutMsFor(9)).toBe(15 * 60_000);
    expect(lockoutMsFor(50)).toBe(60 * 60_000);
    expect(lockoutMsFor(5000)).toBe(60 * 60_000); // never permanent
  });

  it("locks the account after repeated failures", async () => {
    const user = await member();
    await setPassword(db, { userId: user.id, password: GOOD }, { now: NOW });

    for (let i = 0; i < 5; i += 1) {
      await signInWithPassword(db, { email: user.email, password: "wrong wrong wrong" }, { now: NOW });
    }

    const result = await signInWithPassword(db, { email: user.email, password: GOOD }, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("locked");
    // A locked-out member on a Sunday still has a way in.
    expect(result.message).toContain("emailed link");
  });

  it("lets the lock expire", async () => {
    const user = await member();
    await setPassword(db, { userId: user.id, password: GOOD }, { now: NOW });
    for (let i = 0; i < 5; i += 1) {
      await signInWithPassword(db, { email: user.email, password: "wrong wrong wrong" }, { now: NOW });
    }

    const later = new Date(NOW.getTime() + 2 * 60_000);
    expect((await signInWithPassword(db, { email: user.email, password: GOOD }, { now: later })).ok).toBe(true);
  });

  it("forgets past failures after a successful sign-in", async () => {
    const user = await member();
    await setPassword(db, { userId: user.id, password: GOOD }, { now: NOW });
    await signInWithPassword(db, { email: user.email, password: "wrong wrong wrong" }, { now: NOW });
    await signInWithPassword(db, { email: user.email, password: GOOD }, { now: NOW });

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row?.failedLoginCount).toBe(0);
    expect(row?.lockedUntil).toBeNull();
  });
});

describe("managing a password", () => {
  it("refuses to set a weak one", async () => {
    const user = await member();
    const result = await setPassword(db, { userId: user.id, password: "abc" }, { now: NOW });

    expect(result.ok).toBe(false);
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row?.passwordHash).toBeNull();
  });

  it("replaces an existing password", async () => {
    const user = await member();
    await setPassword(db, { userId: user.id, password: GOOD }, { now: NOW });
    await setPassword(db, { userId: user.id, password: "a different long phrase" }, { now: NOW });

    expect((await signInWithPassword(db, { email: user.email, password: GOOD }, { now: NOW })).ok).toBe(false);
    expect(
      (await signInWithPassword(db, { email: user.email, password: "a different long phrase" }, { now: NOW })).ok,
    ).toBe(true);
  });

  it("can be removed, leaving magic links working", async () => {
    const user = await member();
    await setPassword(db, { userId: user.id, password: GOOD }, { now: NOW });
    await clearPassword(db, user.id);

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row?.passwordHash).toBeNull();
    expect((await signInWithPassword(db, { email: user.email, password: GOOD }, { now: NOW })).ok).toBe(false);
  });
});
