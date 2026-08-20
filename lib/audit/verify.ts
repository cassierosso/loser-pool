import { asc } from "drizzle-orm";

import type { Database } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";

import { computeEntryHash, GENESIS_PREV_HASH } from "./hash";

/**
 * SS7.4 -- verifyAuditChain().
 *
 * "Walks the log, recomputes every hash, and confirms seq has no gaps."
 *
 * Three distinct kinds of tampering, three distinct findings:
 *
 *   - a row's contents were altered  -> its recomputed hash stops matching
 *   - a row was deleted              -> a gap appears in seq
 *   - a row was inserted or reordered-> its prev_hash stops matching the row
 *                                       actually before it
 *
 * Layers 1 and 2 of SS7.3 cannot stop the admin, who holds the database owner
 * credentials and could rewrite the whole chain. This function plus the
 * external anchoring in Phase 6b is what makes that detectable anyway.
 */

export type ChainFailureKind = "hash_mismatch" | "seq_gap" | "broken_link" | "duplicate_seq";

export interface ChainFailure {
  kind: ChainFailureKind;
  /** The seq the problem was found AT -- what the red badge reports. */
  seq: number;
  detail: string;
}

export type VerifyResult =
  | { valid: true; entries: number; head: { seq: number; entryHash: string } | null }
  | { valid: false; entries: number; failure: ChainFailure };

export async function verifyAuditChain(db: Database): Promise<VerifyResult> {
  const rows = await db
    .select({
      seq: auditLog.seq,
      occurredAt: auditLog.occurredAt,
      actorUserId: auditLog.actorUserId,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      beforeJson: auditLog.beforeJson,
      afterJson: auditLog.afterJson,
      reason: auditLog.reason,
      prevHash: auditLog.prevHash,
      entryHash: auditLog.entryHash,
    })
    .from(auditLog)
    .orderBy(asc(auditLog.seq));

  if (rows.length === 0) {
    return { valid: true, entries: 0, head: null };
  }

  let previousHash = GENESIS_PREV_HASH;
  let expectedSeq = 1;

  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      return {
        valid: false,
        entries: rows.length,
        failure:
          row.seq > expectedSeq
            ? {
                kind: "seq_gap",
                seq: expectedSeq,
                detail: `Entry #${expectedSeq} is missing; the log jumps to #${row.seq}. A row has been deleted.`,
              }
            : {
                kind: "duplicate_seq",
                seq: row.seq,
                detail: `Entry #${row.seq} appears more than once.`,
              },
      };
    }

    if (row.prevHash !== previousHash) {
      return {
        valid: false,
        entries: rows.length,
        failure: {
          kind: "broken_link",
          seq: row.seq,
          detail:
            `Entry #${row.seq} does not follow the entry before it: it records a previous ` +
            `hash of ${row.prevHash.slice(0, 12)}… but #${row.seq - 1} hashes to ` +
            `${previousHash.slice(0, 12)}…. A row has been inserted, removed, or reordered.`,
        },
      };
    }

    const recomputed = computeEntryHash(
      {
        seq: row.seq,
        occurredAt: row.occurredAt,
        actorUserId: row.actorUserId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        beforeJson: row.beforeJson,
        afterJson: row.afterJson,
        reason: row.reason,
      },
      row.prevHash,
    );

    if (recomputed !== row.entryHash) {
      return {
        valid: false,
        entries: rows.length,
        failure: {
          kind: "hash_mismatch",
          seq: row.seq,
          detail:
            `Entry #${row.seq} has been altered: it stores hash ${row.entryHash.slice(0, 12)}… ` +
            `but its contents hash to ${recomputed.slice(0, 12)}….`,
        },
      };
    }

    previousHash = row.entryHash;
    expectedSeq += 1;
  }

  const last = rows.at(-1)!;
  return {
    valid: true,
    entries: rows.length,
    head: { seq: last.seq, entryHash: last.entryHash },
  };
}
