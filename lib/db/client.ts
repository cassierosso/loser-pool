import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";
import { resolveDatabaseUrl } from "./url";

export type Database = PgliteDatabase<typeof schema> | PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  kind: "pglite" | "postgres";
  close: () => Promise<void>;
}

/**
 * Builds a connection for scripts and tests. The application itself uses the
 * cached singleton below.
 *
 * Both drivers speak the same SQL and run the same migrations; PGlite just
 * removes the need for a server on a machine that has no Postgres.
 */
export async function createDatabase(url?: string): Promise<DatabaseHandle> {
  const target = resolveDatabaseUrl(url ?? process.env.DATABASE_URL);

  if (target.kind === "pglite") {
    const client = new PGlite(target.url === "memory://" ? undefined : target.url);
    await client.waitReady;
    return {
      db: drizzlePglite(client, { schema }),
      kind: "pglite",
      close: () => client.close(),
    };
  }

  const client = postgres(target.url, { max: 1 });
  return {
    db: drizzlePostgres(client, { schema }),
    kind: "postgres",
    close: () => client.end(),
  };
}

let cached: Promise<DatabaseHandle> | undefined;

/** Process-wide handle for the app. Never call this from a script. */
export function getDatabase(): Promise<DatabaseHandle> {
  cached ??= createDatabase();
  return cached;
}

export { schema };

/**
 * Runs `fn` inside a transaction on either driver.
 *
 * Both drivers expose the same transaction API but as a union of two call
 * signatures, which TypeScript will not call directly; picking one branch for
 * the signature and handing the callback back as `Database` is safe because the
 * query surface is identical.
 */
export async function withTransaction<T>(
  db: Database,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return (db as PgliteDatabase<typeof schema>).transaction(async (tx) =>
    fn(tx as unknown as Database),
  );
}
