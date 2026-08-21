import { createDatabase } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";

import { loadEnv } from "./env";
import { redact } from "./guard";

/**
 * Applies checked-in migrations using the migrator/owner connection.
 * Safe to run repeatedly.
 */
async function main(): Promise<void> {
  loadEnv();
  const url = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;

  /**
   * Always say which database is about to be changed.
   *
   * Migrating production is legitimate, so this is not guarded like db:seed --
   * but "I thought that was my local database" is how the wrong thing gets
   * migrated, and a connection string in an env file looks identical either way.
   */
  console.log(`Migrating ${redact(url ?? "local PGlite")}`);
  const handle = await createDatabase(url);

  try {
    await runMigrations(handle);
    console.log(`Migrations applied (${handle.kind}).`);
  } finally {
    await handle.close();
  }
}

await main();
