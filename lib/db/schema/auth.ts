import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { users } from "./user";

/**
 * SS10 -- passwordless email magic link. No passwords are stored, and neither
 * are usable tokens.
 *
 * Both tables hold ONLY the SHA-256 hash of their token. The raw value exists
 * in the emailed URL and in the user's cookie and nowhere else, so a dump of
 * this database yields nothing anyone can log in with.
 */

export const loginTokens = pgTable(
  "login_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** sha256(raw token), hex. Never the token itself. */
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set the moment the link is used; enforced atomically so it is single-use. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("login_token_hash_idx").on(table.tokenHash),
    index("login_token_user_idx").on(table.userId),
  ],
);

export const sessions = pgTable(
  "session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("session_hash_idx").on(table.tokenHash),
    index("session_user_idx").on(table.userId),
  ],
);

export type LoginTokenRow = typeof loginTokens.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
