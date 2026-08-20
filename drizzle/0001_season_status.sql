CREATE TYPE "public"."season_status" AS ENUM('active', 'pending_admin', 'closed');--> statement-breakpoint
ALTER TABLE "league" ADD COLUMN "season_status" "season_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "league" ADD COLUMN "season_outcome" jsonb;