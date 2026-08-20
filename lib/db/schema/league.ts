import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import type { LeagueConfig } from "@/lib/config/schema";

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
