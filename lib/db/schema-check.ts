import { sql } from "drizzle-orm";

import journal from "@/drizzle/meta/_journal.json";

import type { Database } from "./client";

/**
 * Compares the migrations this BUILD expects against the ones the DATABASE has
 * actually applied.
 *
 * Written after an incident: a build was deployed whose code referenced four
 * columns its migration had not yet added, and because Drizzle selects every
 * column it knows about, both sign-in paths returned 500 for everybody. Nothing
 * detected it. The build was green, the deploy was green, and the failure
 * surfaced as a member unable to log in.
 *
 * The journal is imported rather than read from disk so it is bundled into the
 * deployment; `created_at` in Drizzle's bookkeeping table is exactly the
 * journal's `when`, so the comparison needs no hashing and survives a migration
 * file being edited afterwards -- which is precisely what happened during the
 * recovery.
 */

export interface SchemaState {
  ok: boolean;
  expected: number;
  applied: number;
  /** Migrations this build needs that the database does not have. */
  pending: string[];
  /** Migrations the database has that this build does not know about. */
  ahead: string[];
  error?: string;
}

export async function checkSchemaState(db: Database): Promise<SchemaState> {
  const expected = journal.entries.map((entry) => ({ tag: entry.tag, when: String(entry.when) }));

  let appliedWhens: Set<string>;
  try {
    const rows = await db.execute<{ created_at: string }>(
      sql`select created_at from drizzle.__drizzle_migrations`,
    );
    const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
    appliedWhens = new Set(
      (list as Array<{ created_at: string | number | bigint }>).map((row) =>
        String(row.created_at),
      ),
    );
  } catch (error) {
    // No bookkeeping table at all means nothing has ever been migrated.
    return {
      ok: false,
      expected: expected.length,
      applied: 0,
      pending: expected.map((entry) => entry.tag),
      ahead: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const expectedWhens = new Set(expected.map((entry) => entry.when));
  const pending = expected.filter((entry) => !appliedWhens.has(entry.when)).map((e) => e.tag);
  const ahead = [...appliedWhens].filter((when) => !expectedWhens.has(when));

  return {
    ok: pending.length === 0,
    expected: expected.length,
    applied: appliedWhens.size,
    pending,
    // Being "ahead" is a rollback, not a failure: the database has migrations
    // from a newer build. Worth reporting, but the app is not broken by it.
    ahead,
  };
}

export function describeSchemaState(state: SchemaState): string {
  if (state.error) return `Cannot read migration state: ${state.error}`;
  if (state.pending.length > 0) {
    return (
      `Database is missing ${state.pending.length} migration(s) this build needs: ` +
      `${state.pending.join(", ")}. Run: npm run db:migrate`
    );
  }
  if (state.ahead.length > 0) {
    return `Database has ${state.ahead.length} migration(s) newer than this build. A rollback is in progress.`;
  }
  return `Schema up to date (${state.applied}/${state.expected} migrations applied).`;
}
