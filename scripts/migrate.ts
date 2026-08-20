import { createDatabase } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";

import { loadEnv } from "./env";

/**
 * Applies checked-in migrations using the migrator/owner connection.
 * Safe to run repeatedly.
 */
async function main(): Promise<void> {
  loadEnv();
  const url = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL;
  const handle = await createDatabase(url);

  try {
    await runMigrations(handle);
    console.log(`Migrations applied (${handle.kind}).`);
  } finally {
    await handle.close();
  }
}

await main();
