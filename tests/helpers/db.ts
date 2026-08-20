import { createDatabase, type Database, type DatabaseHandle } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { DEFAULT_LEAGUE_CONFIG, type LeagueConfig } from "@/lib/config";
import { leagues, teams, weekStates, type TeamRow } from "@/lib/db/schema";
import { allWeekDescriptors } from "@/lib/week/ordinal";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TEST_SEASON_YEAR = 2024;

/**
 * A throwaway in-memory Postgres per suite, migrated from the same checked-in
 * migrations the real database uses. Nothing is shared between test files.
 */
export async function createTestDatabase(): Promise<DatabaseHandle> {
  const handle = await createDatabase("memory://");
  await runMigrations(handle);
  return handle;
}

export interface SetupLeagueOptions {
  config?: Partial<LeagueConfig>;
  /**
   * lock_at for the week at display_ordinal 1, which is what picksFrozenAt
   * resolves against. Omit to leave every week unsynced (nothing frozen).
   */
  week1LockAt?: Date;
  /**
   * Set false to create the league with no week rows at all, so a test can
   * watch syncSchedule build them (SS8).
   */
  createWeeks?: boolean;
}

export async function setupLeague(
  db: Database,
  options: SetupLeagueOptions = {},
): Promise<void> {
  await db.insert(leagues).values({
    name: "Test League",
    seasonYear: TEST_SEASON_YEAR,
    joinCode: "TEST",
    config: { ...DEFAULT_LEAGUE_CONFIG, ...options.config },
  });

  if (options.createWeeks === false) return;

  await db.insert(weekStates).values(
    allWeekDescriptors().map((week) => ({
      seasonYear: TEST_SEASON_YEAR,
      seasonType: week.seasonType,
      weekNumber: week.weekNumber,
      displayOrdinal: week.displayOrdinal,
      displayLabel: week.displayLabel,
      lockAt: week.displayOrdinal === 1 ? (options.week1LockAt ?? null) : null,
      status: week.skipped ? ("skipped" as const) : ("upcoming" as const),
    })),
  );
}

/** The 32 real teams, so a sync can map ESPN ids onto our rows. */
export async function seedTeams(db: Database): Promise<TeamRow[]> {
  const path = fileURLToPath(new URL("../../fixtures/teams.json", import.meta.url));
  const rows = JSON.parse(readFileSync(path, "utf8")) as Array<Omit<TeamRow, "id">>;
  return db.insert(teams).values(rows).returning();
}
