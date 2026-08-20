import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import { argInt, loadEnv, parseArgs } from "./env";

/**
 * A local Postgres with nothing to install.
 *
 * PGlite is an embedded, SINGLE-PROCESS database. Pointing the app straight at
 * a PGlite data directory looks like it works and then falls apart: Next's dev
 * server reloads modules and keeps separate bundles for server components and
 * route handlers, so the directory gets opened more than once and the WASM
 * instance aborts. The symptom is a row written by one request being invisible
 * to the next.
 *
 * This process owns the database and speaks the Postgres wire protocol, so
 * everything else -- the dev server, scripts, drizzle-kit -- connects as an
 * ordinary client and none of that can happen. Swapping in Neon later is then
 * only a change of DATABASE_URL.
 *
 *   npm run db:serve
 */
async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const port = argInt(args, "port", 5432);
  const dataDir = process.env.PGLITE_DATA_DIR?.trim() || "./.pglite";

  const db = await PGlite.create(dataDir);
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
  await server.start();

  console.log(`PGlite is listening on 127.0.0.1:${port} (data: ${dataDir})`);
  console.log(`DATABASE_URL=postgres://postgres:postgres@localhost:${port}/postgres`);
  console.log("Any username and password are accepted. Ctrl-C to stop.\n");

  const shutdown = async () => {
    console.log("\nStopping…");
    await server.stop();
    await db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
