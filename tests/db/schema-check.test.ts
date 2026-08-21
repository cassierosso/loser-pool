import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import journal from "@/drizzle/meta/_journal.json";
import type { Database, DatabaseHandle } from "@/lib/db/client";
import { checkSchemaState, describeSchemaState } from "@/lib/db/schema-check";

import { createTestDatabase } from "../helpers/db";

/**
 * The check that would have caught the incident: a build deployed ahead of its
 * migration, green everywhere, failing only as a member unable to sign in.
 */

let handle: DatabaseHandle;
let db: Database;

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
});

afterEach(async () => {
  await handle.close();
});

describe("checkSchemaState", () => {
  it("passes on a fully migrated database", async () => {
    const state = await checkSchemaState(db);

    expect(state.ok).toBe(true);
    expect(state.pending).toEqual([]);
    expect(state.applied).toBe(journal.entries.length);
    expect(describeSchemaState(state)).toContain("up to date");
  });

  it("reports a migration the build needs but the database lacks", async () => {
    // Exactly the production state during the incident.
    const last = journal.entries.at(-1)!;
    await db.execute(
      sql`delete from drizzle.__drizzle_migrations where created_at = ${String(last.when)}`,
    );

    const state = await checkSchemaState(db);

    expect(state.ok).toBe(false);
    expect(state.pending).toEqual([last.tag]);
    expect(describeSchemaState(state)).toContain(last.tag);
    expect(describeSchemaState(state)).toContain("npm run db:migrate");
  });

  it("names every pending migration, not just the first", async () => {
    const recent = journal.entries.slice(-3);
    for (const entry of recent) {
      await db.execute(
        sql`delete from drizzle.__drizzle_migrations where created_at = ${String(entry.when)}`,
      );
    }

    const state = await checkSchemaState(db);
    expect(state.pending).toEqual(recent.map((entry) => entry.tag));
  });

  it("treats a database ahead of the build as a rollback, not a failure", async () => {
    // The app is not broken by columns it does not use.
    await db.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('future', 9999999999999)`,
    );

    const state = await checkSchemaState(db);

    expect(state.ok).toBe(true);
    expect(state.ahead).toEqual(["9999999999999"]);
    expect(describeSchemaState(state)).toContain("rollback");
  });

  it("reports an unmigrated database rather than throwing", async () => {
    await db.execute(sql`drop schema drizzle cascade`);

    const state = await checkSchemaState(db);

    expect(state.ok).toBe(false);
    expect(state.applied).toBe(0);
    expect(state.pending).toHaveLength(journal.entries.length);
    expect(describeSchemaState(state)).toContain("Cannot read migration state");
  });
});
