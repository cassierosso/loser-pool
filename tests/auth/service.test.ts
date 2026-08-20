import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import {
  consumeLoginToken,
  destroySession,
  purgeExpiredAuthRows,
  requestLoginLink,
  resolveSession,
} from "@/lib/auth/service";
import { hashToken, LOGIN_TOKEN_TTL_MS, MAX_ACTIVE_TOKENS_PER_USER } from "@/lib/auth/tokens";
import type { Database, DatabaseHandle } from "@/lib/db/client";
import { loginTokens, sessions, users } from "@/lib/db/schema";
import { createCapturingMailer, type CapturingMailer } from "@/lib/mail/console";

import { createTestDatabase, setupLeague } from "../helpers/db";

/**
 * SS10 -- passwordless magic-link auth.
 */

let handle: DatabaseHandle;
let db: Database;
let mailer: CapturingMailer;

const NOW = new Date("2024-09-01T12:00:00Z");
const deps = () => ({ mailer, baseUrl: "https://league.example", now: NOW });

/** Pulls the raw token straight out of the emailed link. */
function tokenFromEmail(text: string): string {
  const match = /token=([^\s&]+)/.exec(text);
  if (!match) throw new Error("no token in email");
  return decodeURIComponent(match[1]!);
}

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  mailer = createCapturingMailer();
  await setupLeague(db);
});

afterEach(async () => {
  await handle.close();
});

async function addExistingUser(email = "dana@example.com") {
  const [user] = await db
    .insert(users)
    .values({ email, displayName: "Dana", picksPurchased: 10 })
    .returning();
  return user!;
}

describe("requesting a sign-in link", () => {
  it("emails a link to an existing member", async () => {
    await addExistingUser();

    const result = await requestLoginLink(db, { email: "dana@example.com" }, deps());

    expect(result).toMatchObject({ ok: true, delivered: true, created: false });
    expect(mailer.messages).toHaveLength(1);
    expect(mailer.messages[0]?.to).toBe("dana@example.com");
    expect(mailer.messages[0]?.text).toContain("https://league.example/api/auth/callback?token=");
  });

  it("matches the address case-insensitively", async () => {
    await addExistingUser();
    const result = await requestLoginLink(db, { email: "  DANA@Example.com " }, deps());
    expect(result).toMatchObject({ ok: true, delivered: true });
  });

  it("stores only a hash of the token, never the token itself", async () => {
    await addExistingUser();
    await requestLoginLink(db, { email: "dana@example.com" }, deps());

    const raw = tokenFromEmail(mailer.messages[0]!.text);
    const [stored] = await db.select().from(loginTokens);

    expect(stored?.tokenHash).toBe(hashToken(raw));
    expect(stored?.tokenHash).not.toBe(raw);
    expect(JSON.stringify(stored)).not.toContain(raw);
  });

  it("does not reveal whether an unknown address is in the league", async () => {
    // The sign-in page must not become a way to find out who is playing.
    const result = await requestLoginLink(db, { email: "stranger@example.com" }, deps());

    expect(result).toEqual({ ok: true, delivered: false, created: false });
    expect(mailer.messages).toHaveLength(0);
    expect(await db.select().from(users)).toHaveLength(0);
  });

  it("creates an account when a valid invite code is supplied", async () => {
    // SS10: users join via the league invite code. SS4: joining gets you an
    // account, not picks -- an admin provisions those.
    const result = await requestLoginLink(
      db,
      { email: "new@example.com", joinCode: "TEST", displayName: "Newcomer" },
      deps(),
    );

    expect(result).toMatchObject({ ok: true, delivered: true, created: true });
    const [created] = await db.select().from(users);
    expect(created).toMatchObject({
      displayName: "Newcomer",
      role: "player",
      picksPurchased: 0,
      paymentStatus: "unpaid",
    });
  });

  it("accepts the invite code case-insensitively but rejects a wrong one", async () => {
    const good = await requestLoginLink(
      db,
      { email: "a@example.com", joinCode: "test", displayName: "A" },
      deps(),
    );
    expect(good.ok).toBe(true);

    const bad = await requestLoginLink(
      db,
      { email: "b@example.com", joinCode: "NOPE", displayName: "B" },
      deps(),
    );
    expect(bad).toMatchObject({ ok: false, code: "invalid_invite_code" });
  });

  it("requires a name when joining", async () => {
    const result = await requestLoginLink(
      db,
      { email: "new@example.com", joinCode: "TEST" },
      deps(),
    );
    expect(result).toMatchObject({ ok: false, code: "name_required" });
  });

  it("refuses a deactivated account", async () => {
    const user = await addExistingUser();
    await db.update(users).set({ deactivatedAt: NOW }).where(eq(users.id, user.id));

    const result = await requestLoginLink(db, { email: user.email }, deps());
    expect(result).toMatchObject({ ok: false, code: "deactivated" });
  });

  it("rate limits repeated requests", async () => {
    await addExistingUser();

    for (let i = 0; i < MAX_ACTIVE_TOKENS_PER_USER; i += 1) {
      expect((await requestLoginLink(db, { email: "dana@example.com" }, deps())).ok).toBe(true);
    }

    const result = await requestLoginLink(db, { email: "dana@example.com" }, deps());
    expect(result).toMatchObject({ ok: false, code: "rate_limited" });
    expect(mailer.messages).toHaveLength(MAX_ACTIVE_TOKENS_PER_USER);
  });
});

describe("consuming a sign-in link", () => {
  async function requestFor(email = "dana@example.com") {
    await addExistingUser(email);
    await requestLoginLink(db, { email }, deps());
    return tokenFromEmail(mailer.messages.at(-1)!.text);
  }

  it("exchanges a valid token for a session", async () => {
    const raw = await requestFor();

    const result = await consumeLoginToken(db, raw, { now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.email).toBe("dana@example.com");

    const resolved = await resolveSession(db, result.sessionToken, { now: NOW });
    expect(resolved?.id).toBe(result.user.id);
  });

  it("stores only a hash of the session token", async () => {
    const raw = await requestFor();
    const result = await consumeLoginToken(db, raw, { now: NOW });
    if (!result.ok) throw new Error("expected success");

    const [stored] = await db.select().from(sessions);
    expect(stored?.tokenHash).toBe(hashToken(result.sessionToken));
    expect(stored?.tokenHash).not.toBe(result.sessionToken);
  });

  it("works exactly once", async () => {
    const raw = await requestFor();

    expect((await consumeLoginToken(db, raw, { now: NOW })).ok).toBe(true);
    expect(await consumeLoginToken(db, raw, { now: NOW })).toEqual({ ok: false, code: "used" });
  });

  it("cannot be won twice by simultaneous clicks", async () => {
    // Single use is enforced by the UPDATE matching only unconsumed rows, not
    // by a read-then-write in application code.
    const raw = await requestFor();

    const [first, second] = await Promise.all([
      consumeLoginToken(db, raw, { now: NOW }),
      consumeLoginToken(db, raw, { now: NOW }),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(sessions)).toHaveLength(1);
  });

  it("rejects an expired token", async () => {
    const raw = await requestFor();
    const later = new Date(NOW.getTime() + LOGIN_TOKEN_TTL_MS + 1000);

    expect(await consumeLoginToken(db, raw, { now: later })).toEqual({ ok: false, code: "expired" });
  });

  it("rejects a token that was never issued", async () => {
    expect(await consumeLoginToken(db, "not-a-real-token", { now: NOW })).toEqual({
      ok: false,
      code: "invalid",
    });
  });

  it("invalidates the user's other outstanding links on sign-in", async () => {
    await addExistingUser();
    await requestLoginLink(db, { email: "dana@example.com" }, deps());
    await requestLoginLink(db, { email: "dana@example.com" }, deps());

    const first = tokenFromEmail(mailer.messages[0]!.text);
    const second = tokenFromEmail(mailer.messages[1]!.text);

    expect((await consumeLoginToken(db, first, { now: NOW })).ok).toBe(true);
    expect(await consumeLoginToken(db, second, { now: NOW })).toEqual({ ok: false, code: "used" });
  });
});

describe("sessions", () => {
  async function signIn() {
    await addExistingUser();
    await requestLoginLink(db, { email: "dana@example.com" }, deps());
    const raw = tokenFromEmail(mailer.messages[0]!.text);
    const result = await consumeLoginToken(db, raw, { now: NOW });
    if (!result.ok) throw new Error("sign-in failed");
    return result;
  }

  it("refuses an unknown session token", async () => {
    expect(await resolveSession(db, "nope", { now: NOW })).toBeNull();
  });

  it("refuses an expired session", async () => {
    const session = await signIn();
    const later = new Date(session.expiresAt.getTime() + 1000);
    expect(await resolveSession(db, session.sessionToken, { now: later })).toBeNull();
  });

  it("refuses a session whose user has been deactivated", async () => {
    const session = await signIn();
    await db.update(users).set({ deactivatedAt: NOW }).where(eq(users.id, session.user.id));

    expect(await resolveSession(db, session.sessionToken, { now: NOW })).toBeNull();
  });

  it("signing out destroys the session", async () => {
    const session = await signIn();
    await destroySession(db, session.sessionToken);

    expect(await resolveSession(db, session.sessionToken, { now: NOW })).toBeNull();
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("purges expired rows", async () => {
    const session = await signIn();
    await purgeExpiredAuthRows(db, new Date(session.expiresAt.getTime() + 1000));

    const [tokenCount] = await db.select({ n: sql<number>`count(*)::int` }).from(loginTokens);
    const [sessionCount] = await db.select({ n: sql<number>`count(*)::int` }).from(sessions);
    expect(tokenCount?.n).toBe(0);
    expect(sessionCount?.n).toBe(0);
  });
});
