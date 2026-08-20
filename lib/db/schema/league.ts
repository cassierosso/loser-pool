import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { seasonStatusEnum } from "./enums";

import type { LeagueConfig } from "@/lib/config/schema";

/** Mirrors the SS6 outcome union; kept structural to avoid a schema->rules import cycle. */
export interface SeasonOutcomeRecord {
  kind: "champion" | "co_champions" | "pending_admin";
  userIds?: string[];
  cause?: string;
  question?: string;
  reason: string;
  decidedAt: string;
}

/**
 * SS2 / SS12: exactly one league per deployment. The `singleton` column is
 * pinned to true by a check constraint and made unique, so a second row is a
 * database error rather than a convention someone forgets.
 */
export const leagues = pgTable(
  "league",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singleton: boolean("singleton").notNull().default(true),
    name: text("name").notNull(),
    seasonYear: integer("season_year").notNull(),
    joinCode: text("join_code").notNull(),
    /**
     * SS0: LEAGUE_CONFIG. Read and written only through lib/config -- nothing
     * else in the codebase may name a setting or its default.
     */
    config: jsonb("config").$type<LeagueConfig>().notNull(),
    /**
     * SS6. Written only by the end-of-season evaluation and by an admin
     * resolving a pending_admin decision.
     */
    seasonStatus: seasonStatusEnum("season_status").notNull().default("active"),
    /** The SS6 outcome that closed or froze the season, verbatim. */
    seasonOutcome: jsonb("season_outcome").$type<SeasonOutcomeRecord>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("league_singleton_idx").on(table.singleton),
    uniqueIndex("league_join_code_idx").on(table.joinCode),
    check("league_singleton_true", sql`${table.singleton} = true`),
  ],
);

export type LeagueRow = typeof leagues.$inferSelect;
export type NewLeagueRow = typeof leagues.$inferInsert;
