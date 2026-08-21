-- Idempotent on purpose.
--
-- These four columns were applied by hand in the Neon console during an
-- incident (the app was deployed before its migration had run, and every
-- sign-in was 500ing because Drizzle selects every column it knows about).
-- Re-running a plain ADD COLUMN then fails on "column already exists", which
-- leaves the migration journal permanently out of step with the database.
--
-- IF NOT EXISTS costs nothing and makes recovery-by-hand survivable, which is
-- exactly the situation where a migration most needs to be re-runnable.
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "password_hash" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "password_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "failed_login_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
