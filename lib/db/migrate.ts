import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";

import type { DatabaseHandle } from "./client";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Applies checked-in migrations. Idempotent: drizzle records what it has
 * applied, so a second run is a no-op.
 *
 * Runs as the migrator/owner connection. Phase 6 (SS7.3) adds the migration
 * that creates the restricted application role, which is precisely why the app
 * and the migrator are separate connection strings from day one.
 */
export async function runMigrations(handle: DatabaseHandle): Promise<void> {
  if (handle.kind === "pglite") {
    await migratePglite(handle.db as never, { migrationsFolder: MIGRATIONS_FOLDER });
    return;
  }

  await migratePostgres(handle.db as never, { migrationsFolder: MIGRATIONS_FOLDER });
}
