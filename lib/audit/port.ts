/**
 * The Phase 6 seam.
 *
 * SS7.1 requires every admin mutation to write exactly one audit_log entry, and
 * SS14 builds the log in Phase 6 -- after provisioning exists. To keep that from
 * becoming a rewrite of every mutation path, provisioning already emits fully
 * formed audit events through this port and Phase 1 simply drops them on the
 * floor.
 *
 * Phase 6 implements this interface once, over the hash-chained insert-only
 * writer, and changes nothing in lib/admin. The shape below is SS7.2's entry
 * minus the fields the writer owns: seq, occurred_at, prev_hash, entry_hash.
 */
export type ActorRole = "player" | "admin" | "system";

export type AuditTargetType = "user" | "pick_slot" | "selection" | "game" | "league" | "job";

export interface AuditEvent {
  actorUserId: string | null;
  actorRole: ActorRole;
  /** SS7.2: e.g. 'user.picks_purchased.change', 'selection.override'. */
  action: string;
  targetType: AuditTargetType;
  targetId: string;
  /** Human-readable, e.g. "Dave -- Pick 4 -- Week 9". */
  targetLabel: string;
  beforeJson: Record<string, unknown>;
  afterJson: Record<string, unknown>;
  /** SS7.6: required and non-empty for every admin action. */
  reason: string;
  /**
   * SS7.2: true when the actor is an admin and the target resolves to the
   * actor's own user or one of their pick slots. Computed by the caller, which
   * is the only place that knows the relationship.
   */
  selfAffecting: boolean;
}

import type { Database } from "@/lib/db/client";

export interface AuditRecorder {
  /**
   * `tx` matters more than it looks. A caller already inside a transaction MUST
   * pass it, for two reasons: the entry then commits or rolls back with the
   * change it describes -- SS7.1 allows no silent paths, and an action without
   * its log entry is exactly that -- and on a single-connection pool, opening a
   * second transaction from inside the first simply deadlocks.
   */
  record(event: AuditEvent, tx?: Database): Promise<void>;
}

/**
 * The no-op that carried the app from Phase 1 to Phase 6. Kept only for tests
 * that do not care about logging; every real path now uses the hash-chained
 * writer in ./writer.ts.
 */
export const noopAuditRecorder: AuditRecorder = {
  async record(_event?: AuditEvent, _tx?: Database) {
    /* intentionally empty until Phase 6 (SS7.3) */
  },
};

export interface CollectingAuditRecorder extends AuditRecorder {
  readonly events: AuditEvent[];
}

/**
 * Test double. Lets Phase 1 assert that each mutation emits exactly one
 * well-formed event with populated before/after and a non-empty reason -- the
 * substance of acceptance test 23 -- before the storage layer exists.
 */
export function createCollectingAuditRecorder(): CollectingAuditRecorder {
  const events: AuditEvent[] = [];
  return {
    events,
    async record(event: AuditEvent, _tx?: Database) {
      events.push(event);
    },
  };
}
