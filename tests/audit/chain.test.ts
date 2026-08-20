import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { GENESIS_PREV_HASH } from "@/lib/audit/hash";
import type { AuditEvent } from "@/lib/audit/port";
import { appendAuditEntry, createAuditRecorder, getChainHead } from "@/lib/audit/writer";
import { verifyAuditChain } from "@/lib/audit/verify";
import type { Database, DatabaseHandle } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";

import { createTestDatabase } from "../helpers/db";

/**
 * SS7.2, SS7.3 and SS7.4 -- the chain, its immutability, and its verification.
 * Acceptance tests 24, 25, 26 and 27.
 */

let handle: DatabaseHandle;
let db: Database;

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});

afterEach(async () => {
  await handle.close();
});

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    actorUserId: null,
    actorRole: "admin",
    action: "user.picks_purchased.change",
    targetType: "user",
    targetId: "u1",
    targetLabel: "Dave",
    beforeJson: { picksPurchased: 0 },
    afterJson: { picksPurchased: 10 },
    reason: "Paid $100 by Venmo",
    selfAffecting: false,
    ...overrides,
  };
}

/**
 * Drizzle wraps driver errors, so the Postgres message lives on the cause
 * chain. This digs it out, because "it threw something" is a much weaker
 * assertion than "the append-only trigger is what refused it".
 */
async function refusalMessage(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    const parts: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      parts.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    }
    return parts.join(" | ");
  }
  throw new Error("expected the statement to be refused, but it succeeded");
}

/**
 * Tampering, done the only way it actually could be: as the database owner,
 * turning the append-only trigger off first. That is precisely the threat SS7.3
 * says layers 1 and 2 cannot stop -- and what the hash chain exists to catch.
 */
async function tamper(work: () => Promise<void>): Promise<void> {
  await db.execute(sql`alter table audit_log disable trigger audit_log_no_update_or_delete`);
  try {
    await work();
  } finally {
    await db.execute(sql`alter table audit_log enable trigger audit_log_no_update_or_delete`);
  }
}

describe("appending entries", () => {
  it("starts the chain from 64 zeros", async () => {
    const written = await appendAuditEntry(db, event());

    expect(written.seq).toBe(1);
    expect(written.prevHash).toBe(GENESIS_PREV_HASH);
    expect(written.entryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("links each entry to the one before it", async () => {
    const first = await appendAuditEntry(db, event());
    const second = await appendAuditEntry(db, event({ action: "user.role.change" }));

    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.entryHash);
  });

  it("numbers entries with no gaps", async () => {
    for (let i = 0; i < 5; i += 1) await appendAuditEntry(db, event());

    const rows = await db.select({ seq: auditLog.seq }).from(auditLog).orderBy(auditLog.seq);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("leaves no gap when a caller's transaction fails", async () => {
    // A sequence would burn a number here, and a hole in the numbering is
    // indistinguishable from a deleted row.
    await appendAuditEntry(db, event());
    await expect(appendAuditEntry(db, event({ reason: "   " }))).rejects.toThrow();
    await appendAuditEntry(db, event());

    const rows = await db.select({ seq: auditLog.seq }).from(auditLog).orderBy(auditLog.seq);
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
  });

  it("refuses an empty reason", async () => {
    // Acceptance test 24, at the storage layer.
    await expect(appendAuditEntry(db, event({ reason: "" }))).rejects.toThrow(/empty reason/);
    await expect(appendAuditEntry(db, event({ reason: "  \t " }))).rejects.toThrow(/empty reason/);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("records the chain head", async () => {
    expect(await getChainHead(db)).toBeNull();
    await appendAuditEntry(db, event());
    const second = await appendAuditEntry(db, event());

    expect(await getChainHead(db)).toEqual({ seq: 2, entryHash: second.entryHash });
  });

  it("works through the recorder port the rest of the app uses", async () => {
    const recorder = createAuditRecorder(db);
    await recorder.record(event());
    await recorder.record(event());

    expect(await db.select().from(auditLog)).toHaveLength(2);
  });
});

describe("SS7.3 layer 2 -- the database refuses to mutate the log", () => {
  it("blocks UPDATE", async () => {
    // Acceptance test 25.
    await appendAuditEntry(db, event());

    const message = await refusalMessage(() =>
      db.execute(sql`update audit_log set reason = 'rewritten' where seq = 1`),
    );

    expect(message).toMatch(/append-only/);
    const [row] = await db.select().from(auditLog);
    expect(row?.reason).toBe("Paid $100 by Venmo");
  });

  it("blocks DELETE", async () => {
    await appendAuditEntry(db, event());

    const message = await refusalMessage(() =>
      db.execute(sql`delete from audit_log where seq = 1`),
    );

    expect(message).toMatch(/append-only/);
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it("blocks an UPDATE that touches nothing anyone would notice", async () => {
    await appendAuditEntry(db, event());
    const message = await refusalMessage(() =>
      db.execute(sql`update audit_log set self_affecting = self_affecting where seq = 1`),
    );

    expect(message).toMatch(/append-only/);
  });
});

describe("verifyAuditChain (SS7.4)", () => {
  it("passes on an empty log", async () => {
    expect(await verifyAuditChain(db)).toEqual({ valid: true, entries: 0, head: null });
  });

  it("passes on a clean log", async () => {
    // Acceptance test 26.
    for (let i = 0; i < 4; i += 1) await appendAuditEntry(db, event({ targetId: `u${i}` }));

    const result = await verifyAuditChain(db);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.entries).toBe(4);
    expect(result.head?.seq).toBe(4);
  });

  it("detects an altered payload, and names the entry", async () => {
    // Acceptance test 27, first case: a row's after_json is altered.
    for (let i = 0; i < 4; i += 1) await appendAuditEntry(db, event({ targetId: `u${i}` }));

    await tamper(async () => {
      await db.execute(
        sql`update audit_log set after_json = '{"picksPurchased": 99}'::jsonb where seq = 2`,
      );
    });

    const result = await verifyAuditChain(db);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.failure.kind).toBe("hash_mismatch");
    expect(result.failure.seq).toBe(2);
    expect(result.failure.detail).toContain("altered");
  });

  it("detects a deleted row, and names the missing entry", async () => {
    // Acceptance test 27, second case.
    for (let i = 0; i < 4; i += 1) await appendAuditEntry(db, event({ targetId: `u${i}` }));

    await tamper(async () => {
      await db.execute(sql`delete from audit_log where seq = 3`);
    });

    const result = await verifyAuditChain(db);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.failure.kind).toBe("seq_gap");
    expect(result.failure.seq).toBe(3);
  });

  it("detects a row inserted out of order", async () => {
    // Acceptance test 27, third case. The forged row carries a plausible seq
    // but cannot carry a prev_hash that matches the row now before it.
    for (let i = 0; i < 3; i += 1) await appendAuditEntry(db, event({ targetId: `u${i}` }));

    await tamper(async () => {
      await db.execute(sql`delete from audit_log where seq = 3`);
      await db.execute(sql`
        insert into audit_log
          (seq, occurred_at, actor_user_id, actor_role, action, target_type, target_id,
           target_label, before_json, after_json, reason, self_affecting, prev_hash, entry_hash)
        values
          (3, now(), null, 'admin', 'user.role.change', 'user', 'u9', 'Forged',
           '{}'::jsonb, '{}'::jsonb, 'Inserted by hand', false,
           ${"f".repeat(64)}, ${"e".repeat(64)})
      `);
    });

    const result = await verifyAuditChain(db);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.failure.kind).toBe("broken_link");
    expect(result.failure.seq).toBe(3);
  });

  it("detects a rewritten chain that stops at the wrong head", async () => {
    // The admin holds the owner credentials and could recompute everything.
    // What they cannot do is match a head hash somebody already wrote down --
    // which is why SS7.3 layer 3 exists.
    await appendAuditEntry(db, event());
    const remembered = (await getChainHead(db))!.entryHash;

    await tamper(async () => {
      await db.execute(sql`delete from audit_log`);
    });
    await appendAuditEntry(db, event({ reason: "A different history" }));

    const result = await verifyAuditChain(db);

    expect(result.valid).toBe(true); // internally consistent...
    if (!result.valid) return;
    expect(result.head?.entryHash).not.toBe(remembered); // ...but not the same log
  });
});
