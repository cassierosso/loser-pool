import { desc, sql } from "drizzle-orm";

import { withTransaction, type Database } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";

import { computeEntryHash, GENESIS_PREV_HASH } from "./hash";
import type { AuditEvent, AuditRecorder } from "./port";

/**
 * SS7.3 layer 1 -- "no application path to mutate".
 *
 * This is the ONLY function in the codebase that writes to audit_log. There is
 * no update, no delete, no upsert, and no admin affordance anywhere that could
 * reach one. Everything else in the app emits events through the AuditRecorder
 * port and this is what finally stores them.
 */

/**
 * A fixed key for the advisory lock that serialises writers.
 *
 * SS7.2 demands seq be "strictly increasing, no gaps". A Postgres sequence
 * cannot do that -- it burns a value on every rolled-back transaction, and a
 * hole in the numbering is indistinguishable from a deleted row, which is
 * precisely the tampering the log exists to expose. So seq is max(seq)+1,
 * computed under this lock. Two concurrent writers queue rather than race.
 */
const AUDIT_LOCK_KEY = 0x105e5_5a17; // "loser-survivor audit"

export interface WrittenEntry {
  seq: number;
  entryHash: string;
  prevHash: string;
  occurredAt: Date;
}

/**
 * Appends an entry using an executor that is ALREADY inside a transaction.
 *
 * Kept separate from appendAuditEntry because opening a nested transaction here
 * is not merely redundant: on a single-connection pool it deadlocks the caller
 * against itself, which is exactly how the first version of this failed.
 */
export async function appendAuditEntryWithin(
  tx: Database,
  event: AuditEvent,
  options: { now?: Date } = {},
): Promise<WrittenEntry> {
  const reason = event.reason?.trim() ?? "";

  // SS7.6: rejected at the server, not just the client. No default text, no
  // placeholder. A database check constraint backs this up.
  if (reason === "") {
    throw new Error(`Refusing to log "${event.action}" with an empty reason.`);
  }

  // Serialises writers so seq has no gaps. Released when the caller's
  // transaction ends, which is also when the change being recorded lands.
  await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`);

  const [head] = await tx
    .select({ seq: auditLog.seq, entryHash: auditLog.entryHash })
    .from(auditLog)
    .orderBy(desc(auditLog.seq))
    .limit(1);

  const seq = (head?.seq ?? 0) + 1;
  const prevHash = head?.entryHash ?? GENESIS_PREV_HASH;
  // SS7.2: the server clock, not the caller's.
  const occurredAt = options.now ?? new Date();

  const entryHash = computeEntryHash(
    {
      seq,
      occurredAt,
      actorUserId: event.actorUserId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      beforeJson: event.beforeJson,
      afterJson: event.afterJson,
      reason,
    },
    prevHash,
  );

  await tx.insert(auditLog).values({
    seq,
    occurredAt,
    actorUserId: event.actorUserId,
    actorRole: event.actorRole,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    targetLabel: event.targetLabel,
    beforeJson: event.beforeJson,
    afterJson: event.afterJson,
    reason,
    selfAffecting: event.selfAffecting,
    prevHash,
    entryHash,
  });

  return { seq, entryHash, prevHash, occurredAt };
}

/** Appends an entry in a transaction of its own. */
export async function appendAuditEntry(
  db: Database,
  event: AuditEvent,
  options: { now?: Date } = {},
): Promise<WrittenEntry> {
  return withTransaction(db, (tx) => appendAuditEntryWithin(tx, event, options));
}

/** The real recorder. Replaces the Phase 1 no-op everywhere. */
export function createAuditRecorder(db: Database, options: { now?: Date } = {}): AuditRecorder {
  return {
    async record(event, tx) {
      // On the caller's transaction when there is one, so the entry and the
      // change it records commit together -- and without nesting.
      if (tx) await appendAuditEntryWithin(tx, event, options);
      else await appendAuditEntry(db, event, options);
    },
  };
}

export async function getChainHead(
  db: Database,
): Promise<{ seq: number; entryHash: string } | null> {
  const [head] = await db
    .select({ seq: auditLog.seq, entryHash: auditLog.entryHash })
    .from(auditLog)
    .orderBy(desc(auditLog.seq))
    .limit(1);

  return head ?? null;
}
