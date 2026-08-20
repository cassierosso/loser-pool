import { and, eq, inArray, sql } from "drizzle-orm";

import { loadLeague } from "@/lib/config";
import type { Database } from "@/lib/db/client";
import {
  pickSlots,
  selections,
  teams,
  users,
  weekStates,
  type LeagueRow,
  type WeekStateRow,
} from "@/lib/db/schema";

import { isWeekRevealed } from "./visibility";

/**
 * SS9 -- League Board. All entrants, their alive/eliminated counts and what
 * they bought, plus this week's picks once the week has locked.
 *
 * Before lock this query DOES NOT FETCH other entrants' selections. That is the
 * whole point of acceptance test 22: their picks must be absent from the
 * response, not merely undrawn, and the only reliable way to guarantee that is
 * never to load them.
 */

export interface BoardEntrant {
  userId: string;
  displayName: string;
  isAdmin: boolean;
  isViewer: boolean;
  picksPurchased: number;
  aliveCount: number;
  eliminatedCount: number;
}

export interface BoardPick {
  userId: string;
  displayName: string;
  slotLabel: string;
  teamAbbreviation: string;
  teamName: string;
  wasAutoAssigned: boolean;
  result: "pending" | "survived" | "eliminated" | "void";
}

export interface BoardData {
  league: Pick<LeagueRow, "name" | "seasonYear" | "seasonStatus" | "seasonOutcome">;
  week: WeekStateRow | null;
  /** False while picks are still secret. */
  revealed: boolean;
  entrants: BoardEntrant[];
  /** Empty until the week is revealed, apart from the viewer's own picks. */
  picks: BoardPick[];
  championUserIds: string[];
}

export async function getLeagueBoard(
  db: Database,
  viewer: { id: string },
  now: Date = new Date(),
): Promise<BoardData> {
  const { row: league } = await loadLeague(db);

  const entrantRows = await db
    .select({
      userId: users.id,
      displayName: users.displayName,
      role: users.role,
      picksPurchased: users.picksPurchased,
      aliveCount: sql<number>`count(*) filter (where ${pickSlots.status} = 'alive')::int`,
      eliminatedCount: sql<number>`count(*) filter (where ${pickSlots.status} = 'eliminated')::int`,
    })
    .from(users)
    .leftJoin(pickSlots, eq(pickSlots.userId, users.id))
    .groupBy(users.id)
    .orderBy(users.displayName);

  const entrants: BoardEntrant[] = entrantRows
    .map((row) => ({
      userId: row.userId,
      displayName: row.displayName,
      isAdmin: row.role === "admin",
      isViewer: row.userId === viewer.id,
      picksPurchased: row.picksPurchased,
      aliveCount: row.aliveCount,
      eliminatedCount: row.eliminatedCount,
    }))
    // Most picks still alive first; that is the standing.
    .sort(
      (a, b) => b.aliveCount - a.aliveCount || a.displayName.localeCompare(b.displayName),
    );

  // The week people are currently looking at: the latest one that has started.
  const [week] = await db
    .select()
    .from(weekStates)
    .where(
      and(
        eq(weekStates.seasonYear, league.seasonYear),
        sql`${weekStates.status} in ('open','locked','grading','graded')`,
      ),
    )
    .orderBy(sql`${weekStates.displayOrdinal} desc`)
    .limit(1);

  const revealed = week ? isWeekRevealed(week, now) : false;

  return {
    league: {
      name: league.name,
      seasonYear: league.seasonYear,
      seasonStatus: league.seasonStatus,
      seasonOutcome: league.seasonOutcome,
    },
    week: week ?? null,
    revealed,
    entrants,
    picks: week ? await loadPicks(db, week, viewer.id, revealed) : [],
    championUserIds: league.seasonOutcome?.userIds ?? [],
  };
}

/**
 * Loads the week's picks -- everyone's once revealed, otherwise only the
 * viewer's own. The `where` clause is the security boundary.
 */
async function loadPicks(
  db: Database,
  week: WeekStateRow,
  viewerId: string,
  revealed: boolean,
): Promise<BoardPick[]> {
  const ownSlots = await db
    .select({ id: pickSlots.id })
    .from(pickSlots)
    .where(eq(pickSlots.userId, viewerId));

  if (!revealed && ownSlots.length === 0) return [];

  const rows = await db
    .select({
      userId: users.id,
      displayName: users.displayName,
      slotLabel: pickSlots.label,
      slotNumber: pickSlots.slotNumber,
      teamAbbreviation: teams.abbreviation,
      teamName: teams.displayName,
      wasAutoAssigned: selections.wasAutoAssigned,
      result: selections.result,
    })
    .from(selections)
    .innerJoin(pickSlots, eq(pickSlots.id, selections.pickSlotId))
    .innerJoin(users, eq(users.id, pickSlots.userId))
    .innerJoin(teams, eq(teams.id, selections.teamId))
    .where(
      revealed
        ? eq(selections.weekStateId, week.id)
        : and(
            eq(selections.weekStateId, week.id),
            inArray(
              selections.pickSlotId,
              ownSlots.map((slot) => slot.id),
            ),
          ),
    )
    .orderBy(users.displayName, pickSlots.slotNumber);

  return rows.map((row) => ({
    userId: row.userId,
    displayName: row.displayName,
    slotLabel: row.slotLabel,
    teamAbbreviation: row.teamAbbreviation,
    teamName: row.teamName,
    wasAutoAssigned: row.wasAutoAssigned,
    result: row.result,
  }));
}
