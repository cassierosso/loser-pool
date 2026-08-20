import { createDatabase, type Database, type DatabaseHandle } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { DEFAULT_LEAGUE_CONFIG, type LeagueConfig } from "@/lib/config";
import { leagues, weekStates } from "@/lib/db/schema";
import { allWeekDescriptors } from "@/lib/week/ordinal";

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
