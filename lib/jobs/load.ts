import { and, eq, inArray, or } from "drizzle-orm";

import type { Database } from "@/lib/db/client";
import { games, pickSlots, selections, weekStates, type WeekStateRow } from "@/lib/db/schema";
import type { RulePriorSelection } from "@/lib/rules/types";
import type { EntrantState } from "@/lib/rules/season";

/**
 * Loads rules-engine inputs out of the database.
 *
 * The engine's types are structural subsets of the row types, so rows go
 * straight in without mapping -- see tests/rules/row-compatibility.test.ts.
 */

export async function loadGamesForWeek(db: Database, week: WeekStateRow) {
  return db.select().from(games).where(eq(games.weekStateId, week.id));
}

export async function loadAliveSlots(db: Database) {
  return db.select().from(pickSlots).where(eq(pickSlots.status, "alive"));
}

export async function loadSelectionsForWeek(db: Database, week: WeekStateRow) {
  return db.select().from(selections).where(eq(selections.weekStateId, week.id));
}

/**
 * Every earlier selection for the given slots, tagged with the display_ordinal
 * of the week it was made in -- which is what SS5.2 walks backwards along.
 */
export async function loadPriorSelections(
  db: Database,
  slotIds: string[],
  beforeOrdinal: number,
): Promise<RulePriorSelection[]> {
  if (slotIds.length === 0) return [];

  const rows = await db
    .select({
      id: selections.id,
      pickSlotId: selections.pickSlotId,
      teamId: selections.teamId,
      gameId: selections.gameId,
      result: selections.result,
      wasAutoAssigned: selections.wasAutoAssigned,
      weekDisplayOrdinal: weekStates.displayOrdinal,
    })
    .from(selections)
    .innerJoin(weekStates, eq(weekStates.id, selections.weekStateId))
    .where(inArray(selections.pickSlotId, slotIds));

  return rows.filter((row) => row.weekDisplayOrdinal < beforeOrdinal);
}

function tally(rows: Array<{ userId: string }>): EntrantState[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
  return [...counts].map(([userId, aliveSlotCount]) => ({ userId, aliveSlotCount }));
}

/** Entrants and their alive counts right now. */
export async function loadEntrantStates(db: Database): Promise<EntrantState[]> {
  const rows = await db
    .select({ userId: pickSlots.userId })
    .from(pickSlots)
    .where(eq(pickSlots.status, "alive"));
  return tally(rows);
}

/**
 * Entrants who were alive ENTERING the given week -- SS6's wipeout rule crowns
 * exactly this set.
 *
 * Computed as "alive now, plus anything eliminated during this week", so it
 * gives the same answer whether or not lockWeek has already killed slots for a
 * missed submission.
 */
export async function loadEntrantStatesEnteringWeek(
  db: Database,
  week: WeekStateRow,
): Promise<EntrantState[]> {
  const rows = await db
    .select({ userId: pickSlots.userId })
    .from(pickSlots)
    .where(
      or(
        eq(pickSlots.status, "alive"),
        and(
          eq(pickSlots.status, "eliminated"),
          eq(pickSlots.eliminatedSeasonType, week.seasonType),
          eq(pickSlots.eliminatedWeek, week.weekNumber),
        ),
      ),
    );
  return tally(rows);
}
