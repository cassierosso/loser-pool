import { sql } from "drizzle-orm";

import { createDatabase, type Database } from "@/lib/db/client";
import { games, leagues, pickSlots, selections, teams, users, weekStates } from "@/lib/db/schema";

import { loadEnv } from "./env";

import { assertLocalDatabase } from "./guard";

/**
 * Deletes every row in foreign-key-safe order. Used by the seed so that seeding
 * is idempotent by construction rather than by upsert gymnastics.
 *
 * audit_log is append-only and is deliberately NOT listed. There is no code
 * path anywhere that deletes an audit entry, and adding one here "just for
 * development" would be the first hole in the thing the log exists to
 * guarantee. Starting over means dropping the database, not emptying the log --
 * see dropEverything below.
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
  assertLocalDatabase("reset the database");

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

/**
 * Drops the whole schema and starts again.
 *
 * This is how a development database is reset, precisely because truncateAll
 * cannot touch audit_log. Dropping a database is a different act from deleting
 * rows out of a log: nobody is left holding a chain that no longer matches
 * their copy, because there is no chain left at all.
 */
export async function dropEverything(db: Database): Promise<void> {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`create schema public`);
  // Drizzle records applied migrations in its own schema; it has to go too, or
  // the next migrate run believes everything is already applied.
  await db.execute(sql`drop schema if exists drizzle cascade`);
}
