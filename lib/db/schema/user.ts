import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { paymentStatusEnum, userRoleEnum } from "./enums";

/**
 * SS2. Named `app_user` because `user` is reserved in Postgres.
 *
 * `picks_purchased` is admin-set and, per the league's own rules, set once
 * before the season starts. The invariant that everything else hangs off:
 *
 *     count(pick_slot WHERE user_id = U) == U.picks_purchased
 *
 * for the whole season, counting eliminated slots. Alive/eliminated counts are
 * derived from pick_slot.status and never stored -- otherwise a player who
 * bought 10 and lost 6 would read as having bought 4.
 *
 * A user with picks_purchased = 0 can log in and view the league but has no
 * slots and cannot submit.
 */
export const users = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    role: userRoleEnum("role").notNull().default("player"),
    picksPurchased: integer("picks_purchased").notNull().default(0),
    paymentStatus: paymentStatusEnum("payment_status").notNull().default("unpaid"),
    /** SS2: free text for the admin's offsite bookkeeping -- amount, method, date. */
    paymentNote: text("payment_note"),
    /**
     * Users with history are deactivated, never deleted: SS7 audit entries and
     * pick_slot rows must keep resolving to a real person forever.
     */
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    /**
     * scrypt hash, or null for a member who signs in by magic link only.
     * A departure from SS10, taken because 60 people cannot all be clicking
     * email links five minutes before kickoff. See lib/auth/password.ts.
     */
    passwordHash: text("password_hash"),
    passwordSetAt: timestamp("password_set_at", { withTimezone: true }),
    /** Reset on any successful sign-in; drives the lockout backoff. */
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /**
     * SS7.5: an admin action after lock raises a banner "until every member has
     * viewed the log screen once, or for seven days, whichever is longer". This
     * is how we know who has looked.
     */
    logLastViewedAt: timestamp("log_last_viewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("app_user_email_idx").on(sql`lower(${table.email})`),
    check("app_user_picks_purchased_non_negative", sql`${table.picksPurchased} >= 0`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
