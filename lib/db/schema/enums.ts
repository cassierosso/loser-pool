import { pgEnum } from "drizzle-orm/pg-core";

/**
 * SS2. Every status field in the spec is a closed set, so each one is a real
 * Postgres enum rather than a text column with a check constraint -- a bad
 * value should be impossible to insert, not merely discouraged.
 */

export const userRoleEnum = pgEnum("user_role", ["player", "admin"]);

export const paymentStatusEnum = pgEnum("payment_status", ["unpaid", "paid", "comped"]);

export const pickSlotStatusEnum = pgEnum("pick_slot_status", ["alive", "eliminated"]);

export const eliminationReasonEnum = pgEnum("elimination_reason", [
  "team_won",
  "tie",
  "no_submission",
  "admin",
]);

export const gameStatusEnum = pgEnum("game_status", [
  "scheduled",
  "in_progress",
  "final",
  "canceled",
  "postponed",
]);

export const selectionResultEnum = pgEnum("selection_result", [
  "pending",
  "survived",
  "eliminated",
  "void",
]);

/**
 * SS6. A season is active until it resolves; admin_decides freezes it in
 * pending_admin, where no week may open until the admin answers.
 */
export const seasonStatusEnum = pgEnum("season_status", ["active", "pending_admin", "closed"]);

export const weekStatusEnum = pgEnum("week_status", [
  "upcoming",
  "open",
  "locked",
  "grading",
  "graded",
  "skipped",
]);

/**
 * SS2.1: season_type is ESPN's own numbering and is stored as the integer ESPN
 * uses, not remapped, so provider responses map straight through.
 */
export const SEASON_TYPE = {
  REGULAR: 2,
  POSTSEASON: 3,
} as const;

export type SeasonType = (typeof SEASON_TYPE)[keyof typeof SEASON_TYPE];
