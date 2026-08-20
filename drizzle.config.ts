import { defineConfig } from "drizzle-kit";

import { resolveDatabaseUrl } from "./lib/db/url";

const target = resolveDatabaseUrl(process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL);

export default defineConfig({
  schema: "./lib/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // drizzle-kit generates plain Postgres DDL regardless of which driver applies
  // it, which is what keeps PGlite and Neon on identical migrations.
  ...(target.kind === "pglite"
    ? { driver: "pglite" as const, dbCredentials: { url: target.url } }
    : { dbCredentials: { url: target.url } }),
  strict: true,
  verbose: true,
});
