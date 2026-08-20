import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm";

import type { Database } from "@/lib/db/client";
import { auditLog, users, weekStates } from "@/lib/db/schema";

/**
 * SS7.5 -- "Any admin action taken after a week has locked raises a persistent
 * banner on the League Board until every member has viewed the log screen once,
 * or for seven days, whichever is longer."
 *
 * An admin editing things while picks are already final is the situation the
 * whole of SS7 exists for, so the league is told loudly and the telling does not
 * stop just because one person clicked through.
 */

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface PostLockNotice {
  show: boolean;
  count: number;
  latestAt: Date | null;
  /** How many members still have not opened the log since it happened. */
  unseenBy: number;
}

export async function getPostLockAdminNotice(
  db: Database,
  seasonYear: number,
  now: Date = new Date(),
): Promise<PostLockNotice> {
  // The most recent week that has actually locked.
  const [week] = await db
    .select({ lockAt: weekStates.lockAt })
    .from(weekStates)
    .where(
      and(
        eq(weekStates.seasonYear, seasonYear),
        sql`${weekStates.status} in ('locked','grading','graded')`,
        sql`${weekStates.lockAt} is not null`,
      ),
    )
    .orderBy(desc(weekStates.displayOrdinal))
    .limit(1);

  if (!week?.lockAt) return { show: false, count: 0, latestAt: null, unseenBy: 0 };

  const actions = await db
    .select({ occurredAt: auditLog.occurredAt })
    .from(auditLog)
    .where(and(eq(auditLog.actorRole, "admin"), gt(auditLog.occurredAt, week.lockAt)))
    .orderBy(desc(auditLog.occurredAt));

  if (actions.length === 0) return { show: false, count: 0, latestAt: null, unseenBy: 0 };

  const latestAt = actions[0]!.occurredAt;

  const [unseen] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(
        sql`${users.deactivatedAt} is null`,
        or(sql`${users.logLastViewedAt} is null`, lt(users.logLastViewedAt, latestAt)),
      ),
    );

  const unseenBy = unseen?.n ?? 0;
  const withinSevenDays = now.getTime() - latestAt.getTime() < SEVEN_DAYS_MS;

  return {
    // "whichever is longer": seven days at minimum, and beyond that for as long
    // as anyone still has not looked.
    show: withinSevenDays || unseenBy > 0,
    count: actions.length,
    latestAt,
    unseenBy,
  };
}

/** Called when a member opens the League Log. */
export async function markLogViewed(db: Database, userId: string, now = new Date()): Promise<void> {
  await db.update(users).set({ logLastViewedAt: now }).where(eq(users.id, userId));
}
