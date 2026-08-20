import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { actorRoleEnum, auditTargetTypeEnum } from "./enums";

/**
 * SS7 -- the admin accountability log.
 *
 * "This is a league of friends arguing about a game, and the admin is one of
 * the players; the audit log is the referee." Append-only, hash-chained, and
 * readable by every entrant.
 *
 * Two deliberate choices about what is NOT here:
 *
 * 1. `actor_user_id` carries no foreign key. A FK would give the database a
 *    reason to touch these rows -- and one careless ON DELETE CASCADE would
 *    erase exactly the history the log exists to preserve. The id is stored
 *    plainly and resolved at read time.
 * 2. There is no updated_at, no soft-delete flag, no status. Nothing about a
 *    row is ever meant to change.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /**
     * SS7.2: strictly increasing, NO GAPS. Not a sequence -- a bigserial leaves
     * holes whenever a transaction rolls back, and a hole is indistinguishable
     * from a deletion. Allocated as max(seq)+1 under an advisory lock instead.
     */
    seq: bigint("seq", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** Null for system actions (jobs, auto-assignment). */
    actorUserId: uuid("actor_user_id"),
    actorRole: actorRoleEnum("actor_role").notNull(),
    /** e.g. 'selection.override', 'user.picks_purchased.change'. */
    action: text("action").notNull(),
    targetType: auditTargetTypeEnum("target_type").notNull(),
    targetId: text("target_id").notNull(),
    /** Human-readable, e.g. "Dave — Pick 4 — Week 9". */
    targetLabel: text("target_label").notNull(),
    beforeJson: jsonb("before_json").notNull(),
    afterJson: jsonb("after_json").notNull(),
    /** SS7.6: required and non-empty for every admin action. */
    reason: text("reason").notNull(),
    /** SS7.2: an admin acting on their own entry. Rendered in high contrast. */
    selfAffecting: boolean("self_affecting").notNull().default(false),
    prevHash: char("prev_hash", { length: 64 }).notNull(),
    entryHash: char("entry_hash", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("audit_log_seq_idx").on(table.seq),
    uniqueIndex("audit_log_entry_hash_idx").on(table.entryHash),
    index("audit_log_actor_idx").on(table.actorUserId),
    index("audit_log_action_idx").on(table.action),
    index("audit_log_target_idx").on(table.targetType, table.targetId),
    check("audit_log_seq_positive", sql`${table.seq} >= 1`),
    // A blank reason must be impossible at the storage layer too, not only in
    // the service that writes it (SS7.6).
    check("audit_log_reason_present", sql`length(btrim(${table.reason})) > 0`),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
