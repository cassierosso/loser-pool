import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { weekStatusEnum } from "./enums";

/**
 * SS2 / SS2.1. A bare integer week is not an identity: week_number resets to 1
 * at the start of the postseason. A week is (season_year, season_type,
 * week_number).
 *
 * season_year is not in the spec's field list, but game carries it and Phase 7
 * replays a full completed prior season -- without it, two seasons of week rows
 * collide. Added deliberately.
 *
 * display_ordinal is the only thing anything may sort by or walk backwards
 * through. Never do arithmetic on week_number. The Pro Bowl week is a real row
 * holding a real ordinal with status 'skipped', so that "the previous played
 * week" steps over it by status rather than by an off-by-one someone has to
 * remember.
 */
export const weekStates = pgTable(
  "week_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seasonYear: integer("season_year").notNull(),
    seasonType: integer("season_type").notNull(),
    weekNumber: integer("week_number").notNull(),
    displayOrdinal: integer("display_ordinal").notNull(),
    displayLabel: text("display_label").notNull(),
    /** SS8: recomputed by syncSchedule as the earliest kickoff_at in the week. */
    lockAt: timestamp("lock_at", { withTimezone: true }),
    status: weekStatusEnum("status").notNull().default("upcoming"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("week_state_identity_idx").on(table.seasonYear, table.seasonType, table.weekNumber),
    uniqueIndex("week_state_ordinal_idx").on(table.seasonYear, table.displayOrdinal),
    check("week_state_season_type_valid", sql`${table.seasonType} in (2, 3)`),
    check("week_state_week_number_positive", sql`${table.weekNumber} >= 1`),
  ],
);

export type WeekStateRow = typeof weekStates.$inferSelect;
export type NewWeekStateRow = typeof weekStates.$inferInsert;
