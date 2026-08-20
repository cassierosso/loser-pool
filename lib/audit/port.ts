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

export interface AuditRecorder {
  record(event: AuditEvent): Promise<void>;
}

/** Phase 1 default. Phase 6 replaces this with the real chained writer. */
export const noopAuditRecorder: AuditRecorder = {
  async record() {
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
    async record(event) {
      events.push(event);
    },
  };
}
