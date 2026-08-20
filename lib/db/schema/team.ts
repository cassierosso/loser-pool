import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * SS2: 32 rows. Seeded from fixtures/teams.json in Phase 1 -- Phase 3's
 * provider getTeams() reconciles against this table rather than replacing it.
 */
export const teams = pgTable(
  "team",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    espnTeamId: text("espn_team_id").notNull(),
    abbreviation: text("abbreviation").notNull(),
    displayName: text("display_name").notNull(),
    logoUrl: text("logo_url"),
    conference: text("conference").notNull(),
    division: text("division").notNull(),
  },
  (table) => [
    uniqueIndex("team_espn_team_id_idx").on(table.espnTeamId),
    uniqueIndex("team_abbreviation_idx").on(table.abbreviation),
  ],
);

export type TeamRow = typeof teams.$inferSelect;
export type NewTeamRow = typeof teams.$inferInsert;
