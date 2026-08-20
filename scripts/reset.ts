import { createDatabase, type Database } from "@/lib/db/client";
import { games, leagues, pickSlots, selections, teams, users, weekStates } from "@/lib/db/schema";

import { loadEnv } from "./env";

/**
 * Deletes every row in foreign-key-safe order. Used by the seed so that seeding
 * is idempotent by construction rather than by upsert gymnastics.
 *
 * Note for Phase 6: audit_log is append-only and must NOT be added here. When
 * the log exists, resetting a database means dropping and recreating it.
 */
export async function truncateAll(db: Database): Promise<void> {
  await db.delete(selections);
  await db.delete(pickSlots);
  await db.delete(games);
  await db.delete(weekStates);
  await db.delete(users);
  await db.delete(leagues);
  await db.delete(teams);
}

async function main(): Promise<void> {
  loadEnv();
  const handle = await createDatabase(process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL);
  try {
    await truncateAll(handle.db);
    console.log("All rows deleted.");
  } finally {
    await handle.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
