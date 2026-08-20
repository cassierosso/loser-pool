import { boolean, integer, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { selectionResultEnum } from "./enums";
import { games } from "./game";
import { pickSlots } from "./pick-slot";
import { teams } from "./team";
import { users } from "./user";
import { weekStates } from "./week-state";

/**
 * SS2: one row per pick_slot per week -- the team that slot is betting LOSES.
 *
 * The spec's unique constraint is (pick_slot_id, season_type, week_number);
 * keyed on week_state_id instead, which is the same constraint with the season
 * year folded in. The denormalized season_type/week_number columns are kept for
 * legible queries and for the audit log's target_label.
 */
export const selections = pgTable(
  "selection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pickSlotId: uuid("pick_slot_id")
      .notNull()
      .references(() => pickSlots.id, { onDelete: "restrict" }),
    weekStateId: uuid("week_state_id")
      .notNull()
      .references(() => weekStates.id, { onDelete: "restrict" }),
    seasonType: integer("season_type").notNull(),
    weekNumber: integer("week_number").notNull(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "restrict" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    submittedByUserId: uuid("submitted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** SS5.2: set by the lock-time auto-assignment, surfaced as a badge in the UI. */
    wasAutoAssigned: boolean("was_auto_assigned").notNull().default(false),
    result: selectionResultEnum("result").notNull().default("pending"),
    gradedAt: timestamp("graded_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("selection_slot_week_idx").on(table.pickSlotId, table.weekStateId),
  ],
);

export type SelectionRow = typeof selections.$inferSelect;
export type NewSelectionRow = typeof selections.$inferInsert;
