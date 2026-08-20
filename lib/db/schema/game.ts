import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { gameStatusEnum } from "./enums";
import { teams } from "./team";
import { weekStates } from "./week-state";

/**
 * SS2 / SS3. Upserted by espn_event_id, which is the only stable identifier
 * ESPN gives us.
 *
 * winner_team_id is nullable and its nullability carries meaning: on a row with
 * status 'final', a null winner IS the tie. SS3 defines a tie as completed and
 * no competitor flagged winner and equal scores; SS5.1 then eliminates every
 * selection on BOTH teams. Do not add an is_tie boolean -- two sources of truth
 * for the same fact is how a tie quietly stops eliminating people.
 */
export const games = pgTable(
  "game",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    espnEventId: text("espn_event_id").notNull(),
    seasonYear: integer("season_year").notNull(),
    seasonType: integer("season_type").notNull(),
    weekNumber: integer("week_number").notNull(),
    /** Denormalized columns above stay for readable queries; this is the key. */
    weekStateId: uuid("week_state_id")
      .notNull()
      .references(() => weekStates.id, { onDelete: "restrict" }),
    kickoffAt: timestamp("kickoff_at", { withTimezone: true }).notNull(),
    homeTeamId: uuid("home_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    awayTeamId: uuid("away_team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    homeScore: integer("home_score"),
    awayScore: integer("away_score"),
    status: gameStatusEnum("status").notNull().default("scheduled"),
    winnerTeamId: uuid("winner_team_id").references(() => teams.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("game_espn_event_id_idx").on(table.espnEventId),
    index("game_week_state_idx").on(table.weekStateId),
    index("game_kickoff_idx").on(table.kickoffAt),
    check("game_teams_distinct", sql`${table.homeTeamId} <> ${table.awayTeamId}`),
    check("game_season_type_valid", sql`${table.seasonType} in (2, 3)`),
    check(
      "game_winner_is_a_participant",
      sql`${table.winnerTeamId} is null
          or ${table.winnerTeamId} = ${table.homeTeamId}
          or ${table.winnerTeamId} = ${table.awayTeamId}`,
    ),
    // Only a completed game may name a winner.
    check(
      "game_winner_requires_final",
      sql`${table.winnerTeamId} is null or ${table.status} = 'final'`,
    ),
  ],
);

export type GameRow = typeof games.$inferSelect;
export type NewGameRow = typeof games.$inferInsert;
