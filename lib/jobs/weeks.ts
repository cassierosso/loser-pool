import { and, eq } from "drizzle-orm";

import type { Database } from "@/lib/db/client";
import { weekStates, type WeekStateRow } from "@/lib/db/schema";
import { allWeekDescriptors } from "@/lib/week/ordinal";

/**
 * Week bookkeeping shared by the jobs.
 *
 * SS3.1: the Pro Bowl week is created like any other week so the ordinal axis
 * stays contiguous, but it is born 'skipped' and no job ever opens, syncs, or
 * grades it.
 */

export async function ensureWeekStates(db: Database, seasonYear: number): Promise<WeekStateRow[]> {
  const existing = await db
    .select()
    .from(weekStates)
    .where(eq(weekStates.seasonYear, seasonYear))
    .orderBy(weekStates.displayOrdinal);

  const known = new Set(existing.map((week) => week.displayOrdinal));
  const missing = allWeekDescriptors()
    .filter((week) => !known.has(week.displayOrdinal))
    .map((week) => ({
      seasonYear,
      seasonType: week.seasonType,
      weekNumber: week.weekNumber,
      displayOrdinal: week.displayOrdinal,
      displayLabel: week.displayLabel,
      lockAt: null,
      status: week.skipped ? ("skipped" as const) : ("upcoming" as const),
    }));

  if (missing.length === 0) return existing;

  await db.insert(weekStates).values(missing);

  return db
    .select()
    .from(weekStates)
    .where(eq(weekStates.seasonYear, seasonYear))
    .orderBy(weekStates.displayOrdinal);
}

export async function loadWeeks(db: Database, seasonYear: number): Promise<WeekStateRow[]> {
  return db
    .select()
    .from(weekStates)
    .where(eq(weekStates.seasonYear, seasonYear))
    .orderBy(weekStates.displayOrdinal);
}

export async function loadWeek(
  db: Database,
  seasonYear: number,
  displayOrdinal: number,
): Promise<WeekStateRow | undefined> {
  const [week] = await db
    .select()
    .from(weekStates)
    .where(
      and(eq(weekStates.seasonYear, seasonYear), eq(weekStates.displayOrdinal, displayOrdinal)),
    )
    .limit(1);
  return week;
}

/**
 * The week the league is currently living in: the earliest played week that is
 * not finished with. Deliberately not clock-based -- a week stays current until
 * it has actually been graded, so a job running late does not skip it.
 */
export function resolveCurrentWeek(weeks: readonly WeekStateRow[]): WeekStateRow | undefined {
  return weeks
    .filter((week) => week.status !== "skipped" && week.status !== "graded")
    .sort((a, b) => a.displayOrdinal - b.displayOrdinal)[0];
}

export function nextPlayable(
  weeks: readonly WeekStateRow[],
  afterOrdinal: number,
): WeekStateRow | undefined {
  return weeks
    .filter((week) => week.displayOrdinal > afterOrdinal && week.status !== "skipped")
    .sort((a, b) => a.displayOrdinal - b.displayOrdinal)[0];
}
