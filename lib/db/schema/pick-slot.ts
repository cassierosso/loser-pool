import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { eliminationReasonEnum, pickSlotStatusEnum } from "./enums";
import { users } from "./user";

/**
 * SS2 / SS4: the persistent token. A pick is an entity with its own lifecycle
 * across the whole season, not a row that exists for one week.
 *
 * Rows are created only by the admin provisioning action (lib/admin), never at
 * signup. slot_number is stable for life: reducing picks_purchased removes the
 * highest-numbered eligible slots and never renumbers the survivors, so gaps
 * (Pick 1, Pick 2, Pick 5) are legal and a slot's history never shifts under it.
 */
export const pickSlots = pgTable(
  "pick_slot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    slotNumber: integer("slot_number").notNull(),
    label: text("label").notNull(),
    status: pickSlotStatusEnum("status").notNull().default("alive"),
    eliminatedSeasonType: integer("eliminated_season_type"),
    eliminatedWeek: integer("eliminated_week"),
    eliminatedReason: eliminationReasonEnum("eliminated_reason"),
    eliminatedAt: timestamp("eliminated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pick_slot_user_slot_number_idx").on(table.userId, table.slotNumber),
    uniqueIndex("pick_slot_user_label_idx").on(table.userId, table.label),
    check("pick_slot_number_positive", sql`${table.slotNumber} >= 1`),
    // An eliminated slot must say when and why; an alive slot must not pretend to.
    check(
      "pick_slot_elimination_consistent",
      sql`(${table.status} = 'eliminated' and ${table.eliminatedReason} is not null)
          or (${table.status} = 'alive' and ${table.eliminatedReason} is null
              and ${table.eliminatedSeasonType} is null and ${table.eliminatedWeek} is null)`,
    ),
  ],
);

export type PickSlotRow = typeof pickSlots.$inferSelect;
export type NewPickSlotRow = typeof pickSlots.$inferInsert;
