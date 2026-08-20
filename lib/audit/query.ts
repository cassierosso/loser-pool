import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";

import type { Database } from "@/lib/db/client";
import { auditLog, users, type AuditLogRow } from "@/lib/db/schema";

/**
 * SS7.5 -- reading the log.
 *
 * Readable by EVERY logged-in league member, not just admins. There is no role
 * check in here and there must never be one: a log only the referee can read
 * referees nothing.
 */

export interface AuditFilters {
  /** SS7.5: the default view shows admin actions only. */
  adminOnly?: boolean;
  actorUserId?: string;
  action?: string;
  /** Entries whose target resolves to this player. */
  affectedUserId?: string;
  limit?: number;
  offset?: number;
}

export interface AuditEntryView extends AuditLogRow {
  actorName: string | null;
}

function buildWhere(filters: AuditFilters): SQL | undefined {
  const clauses: SQL[] = [];

  if (filters.adminOnly) clauses.push(eq(auditLog.actorRole, "admin"));
  if (filters.actorUserId) clauses.push(eq(auditLog.actorUserId, filters.actorUserId));
  if (filters.action) clauses.push(eq(auditLog.action, filters.action));

  if (filters.affectedUserId) {
    // An entry concerns a player when it targets them directly, or targets one
    // of their pick slots or selections.
    clauses.push(
      sql`(
        (${auditLog.targetType} = 'user' and ${auditLog.targetId} = ${filters.affectedUserId})
        or exists (
          select 1 from pick_slot ps
          where ps.user_id = ${filters.affectedUserId}
            and ${auditLog.targetId} = ps.id::text
        )
      )`,
    );
  }

  return clauses.length === 0 ? undefined : and(...clauses);
}

export async function listAuditEntries(
  db: Database,
  filters: AuditFilters = {},
): Promise<{ entries: AuditEntryView[]; total: number }> {
  const where = buildWhere(filters);

  const rows = await db
    .select({ entry: auditLog, actorName: users.displayName })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(where)
    .orderBy(desc(auditLog.seq))
    .limit(filters.limit ?? 100)
    .offset(filters.offset ?? 0);

  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(where);

  return {
    entries: rows.map((row) => ({ ...row.entry, actorName: row.actorName })),
    total: count?.n ?? 0,
  };
}

/** Every entry, oldest first -- what an export and a verifier both want. */
export async function listAllAuditEntries(db: Database): Promise<AuditEntryView[]> {
  const rows = await db
    .select({ entry: auditLog, actorName: users.displayName })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .orderBy(asc(auditLog.seq));

  return rows.map((row) => ({ ...row.entry, actorName: row.actorName }));
}

/** The distinct actions present, for the filter dropdown. */
export async function listAuditActions(db: Database): Promise<string[]> {
  const rows = await db
    .selectDistinct({ action: auditLog.action })
    .from(auditLog)
    .orderBy(asc(auditLog.action));
  return rows.map((row) => row.action);
}

/**
 * SS7.5: "Any admin action taken after a week has locked raises a persistent
 * banner on the League Board." Those are the entries that most need looking at:
 * the ones made when the picks were already final.
 */
export async function countAdminActionsSinceLock(
  db: Database,
  lockAt: Date | null,
): Promise<number> {
  if (!lockAt) return 0;

  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(and(eq(auditLog.actorRole, "admin"), sql`${auditLog.occurredAt} >= ${lockAt}`));

  return row?.n ?? 0;
}
