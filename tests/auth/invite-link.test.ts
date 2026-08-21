import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { issueInviteLink } from "@/lib/admin";
import { createCollectingAuditRecorder } from "@/lib/audit/port";
import { consumeLoginToken, pendingAdminLinkNotice, resolveSession } from "@/lib/auth/service";
import { INVITE_LINK_TTL_MS } from "@/lib/auth/tokens";
import type { Database, DatabaseHandle } from "@/lib/db/client";
import { loginTokens, users } from "@/lib/db/schema";

import { createTestDatabase, setupLeague } from "../helpers/db";

/**
 * SS7 -- admin-minted sign-in links. The most powerful action in the app, so
 * the tests are mostly about it being impossible to do quietly.
 */

let handle: DatabaseHandle;
let db: Database;
let recorder: ReturnType<typeof createCollectingAuditRecorder>;

const NOW = new Date("2024-09-01T12:00:00Z");
const BASE = "https://league.example";

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  recorder = createCollectingAuditRecorder();
  await setupLeague(db);
});

afterEach(async () => {
  await handle.close();
});

async function person(name: string, role: "player" | "admin" = "player") {
  const [user] = await db
    .insert(users)
    .values({ email: `${name}@example.com`, displayName: name, role, picksPurchased: 5 })
    .returning();
  return user!;
}

const actor = (id: string, reason = "No email domain yet; sending by text") => ({
  actorUserId: id,
  actorRole: "admin" as const,
  reason,
});

function tokenFrom(url: string): string {
  return decodeURIComponent(new URL(url).searchParams.get("token")!);
}

describe("minting a link", () => {
  it("produces a working sign-in URL", async () => {
    const admin = await person("dana", "admin");
    const dave = await person("dave");

    const result = await issueInviteLink(db, { userId: dave.id, baseUrl: BASE }, actor(admin.id), recorder);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const consumed = await consumeLoginToken(db, tokenFrom(result.value.url), { now: NOW });
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) return;
    expect(consumed.user.id).toBe(dave.id);
  });

  it("stores only a hash, like every other token", async () => {
    const admin = await person("dana", "admin");
    const dave = await person("dave");
    const result = await issueInviteLink(db, { userId: dave.id, baseUrl: BASE }, actor(admin.id), recorder);
    if (!result.ok) return;

    const raw = tokenFrom(result.value.url);
    const [stored] = await db.select().from(loginTokens);
    expect(JSON.stringify(stored)).not.toContain(raw);
  });

  it("lasts longer than an emailed link, because it travels by group chat", async () => {
    const admin = await person("dana", "admin");
    const dave = await person("dave");
    const result = await issueInviteLink(db, { userId: dave.id, baseUrl: BASE }, actor(admin.id), recorder);
    if (!result.ok) return;

    const [stored] = await db.select().from(loginTokens);
    const lifetime = stored!.expiresAt.getTime() - stored!.createdAt.getTime();
    expect(lifetime).toBeGreaterThan(60 * 60 * 1000);
    expect(lifetime).toBeLessThanOrEqual(INVITE_LINK_TTL_MS + 1000);
  });

  it("is still single-use", async () => {
    const admin = await person("dana", "admin");
    const dave = await person("dave");
    const result = await issueInviteLink(db, { userId: dave.id, baseUrl: BASE }, actor(admin.id), recorder);
    if (!result.ok) return;

    const raw = tokenFrom(result.value.url);
    expect((await consumeLoginToken(db, raw, { now: NOW })).ok).toBe(true);
    expect(await consumeLoginToken(db, raw, { now: NOW })).toEqual({ ok: false, code: "used" });
  });

  it("refuses without a typed reason", async () => {
    // SS7.6, at the server.
    const admin = await person("dana", "admin");
    const dave = await person("dave");

    const result = await issueInviteLink(db, { userId: dave.id, baseUrl: BASE }, actor(admin.id, "   "), recorder);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("reason_required");
    expect(await db.select().from(loginTokens)).toHaveLength(0);
    expect(recorder.events).toHaveLength(0);
  });

  it("refuses for a deactivated member", async () => {
    const admin = await person("dana", "admin");
    const dave = await person("dave");
    await db.update(users).set({ deactivatedAt: NOW }).where(eq(users.id, dave.id));

    expect((await issueInviteLink(db, { userId: dave.id, baseUrl: BASE }, actor(admin.id), recorder)).ok).toBe(false);
  });
});

describe("it cannot be done quietly (SS7)", () => {
  it("logs the mint, without putting the token in the log", async () => {
    // The log is public to the whole league; an entry containing a working
    // credential would hand everyone the keys.
    const admin = await person("dana", "admin");
    const dave = await person("dave");
    const result = await issueInviteLink(db, { userId: dave.id, baseUrl: BASE }, actor(admin.id), recorder);
    if (!result.ok) return;

    expect(recorder.events).toHaveLength(1);
    expect(recorder.events[0]).toMatchObject({
      action: "user.invite_link.create",
      actorUserId: admin.id,
      targetId: dave.id,
      selfAffecting: false,
    });
    expect(JSON.stringify(recorder.events[0])).not.toContain(tokenFrom(result.value.url));
  });

  it("flags an admin minting one for their own account", async () => {
    const admin = await person("dana", "admin");
    await issueInviteLink(db, { userId: admin.id, baseUrl: BASE }, actor(admin.id), recorder);

    expect(recorder.events[0]?.selfAffecting).toBe(true);
  });

  it("reports the admin who minted it when the link is used", async () => {
    const admin = await person("dana", "admin");
    const dave = await person("dave");
    const result = await issueInviteLink(db, { userId: dave.id, baseUrl: BASE }, actor(admin.id), recorder);
    if (!result.ok) return;

    const consumed = await consumeLoginToken(db, tokenFrom(result.value.url), { now: NOW });
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) return;
    // The callback route turns this into a second public log entry.
    expect(consumed.mintedByUserId).toBe(admin.id);
  });

  it("does not flag a link the member requested themselves", async () => {
    const { requestLoginLink } = await import("@/lib/auth/service");
    const { createCapturingMailer } = await import("@/lib/mail/console");
    const mailer = createCapturingMailer();
    const dave = await person("dave");

    await requestLoginLink(db, { email: dave.email }, { mailer, baseUrl: BASE, now: NOW });
    const raw = /token=([^\s&]+)/.exec(mailer.messages[0]!.text)![1]!;

    const consumed = await consumeLoginToken(db, decodeURIComponent(raw), { now: NOW });
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) return;
    expect(consumed.mintedByUserId).toBeNull();
  });

  it("tells the member on their own screen once it has been used", async () => {
    const admin = await person("dana", "admin");
    const dave = await person("dave");
    const result = await issueInviteLink(db, { userId: dave.id, baseUrl: BASE }, actor(admin.id), recorder);
    if (!result.ok) return;

    // Nothing to say before it is used.
    expect(await pendingAdminLinkNotice(db, dave.id)).toBeNull();

    await consumeLoginToken(db, tokenFrom(result.value.url), { now: NOW });

    const notice = await pendingAdminLinkNotice(db, dave.id);
    expect(notice).not.toBeNull();
    expect(notice?.adminName).toBe("dana");
  });

  it("says nothing to a member nobody minted a link for", async () => {
    const dave = await person("dave");
    expect(await pendingAdminLinkNotice(db, dave.id)).toBeNull();
  });

  it("gives the holder a real session, which is exactly why it is disclosed", async () => {
    // Stated as a test so the risk is written down: this IS impersonation.
    const admin = await person("dana", "admin");
    const dave = await person("dave");
    const result = await issueInviteLink(db, { userId: dave.id, baseUrl: BASE }, actor(admin.id), recorder);
    if (!result.ok) return;

    const consumed = await consumeLoginToken(db, tokenFrom(result.value.url), { now: NOW });
    if (!consumed.ok) return;

    const who = await resolveSession(db, consumed.sessionToken, { now: NOW });
    expect(who?.id).toBe(dave.id);
    expect(who?.id).not.toBe(admin.id);
  });
});
