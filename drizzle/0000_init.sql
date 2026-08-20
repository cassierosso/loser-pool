CREATE TYPE "public"."elimination_reason" AS ENUM('team_won', 'tie', 'no_submission', 'admin');--> statement-breakpoint
CREATE TYPE "public"."game_status" AS ENUM('scheduled', 'in_progress', 'final', 'canceled', 'postponed');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('unpaid', 'paid', 'comped');--> statement-breakpoint
CREATE TYPE "public"."pick_slot_status" AS ENUM('alive', 'eliminated');--> statement-breakpoint
CREATE TYPE "public"."selection_result" AS ENUM('pending', 'survived', 'eliminated', 'void');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('player', 'admin');--> statement-breakpoint
CREATE TYPE "public"."week_status" AS ENUM('upcoming', 'open', 'locked', 'grading', 'graded', 'skipped');--> statement-breakpoint
CREATE TABLE "league" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"name" text NOT NULL,
	"season_year" integer NOT NULL,
	"join_code" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "league_singleton_true" CHECK ("league"."singleton" = true)
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" DEFAULT 'player' NOT NULL,
	"picks_purchased" integer DEFAULT 0 NOT NULL,
	"payment_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"payment_note" text,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_picks_purchased_non_negative" CHECK ("app_user"."picks_purchased" >= 0)
);
--> statement-breakpoint
CREATE TABLE "team" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"espn_team_id" text NOT NULL,
	"abbreviation" text NOT NULL,
	"display_name" text NOT NULL,
	"logo_url" text,
	"conference" text NOT NULL,
	"division" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "week_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_year" integer NOT NULL,
	"season_type" integer NOT NULL,
	"week_number" integer NOT NULL,
	"display_ordinal" integer NOT NULL,
	"display_label" text NOT NULL,
	"lock_at" timestamp with time zone,
	"status" "week_status" DEFAULT 'upcoming' NOT NULL,
	"last_synced_at" timestamp with time zone,
	CONSTRAINT "week_state_season_type_valid" CHECK ("week_state"."season_type" in (2, 3)),
	CONSTRAINT "week_state_week_number_positive" CHECK ("week_state"."week_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "pick_slot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"slot_number" integer NOT NULL,
	"label" text NOT NULL,
	"status" "pick_slot_status" DEFAULT 'alive' NOT NULL,
	"eliminated_season_type" integer,
	"eliminated_week" integer,
	"eliminated_reason" "elimination_reason",
	"eliminated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pick_slot_number_positive" CHECK ("pick_slot"."slot_number" >= 1),
	CONSTRAINT "pick_slot_elimination_consistent" CHECK (("pick_slot"."status" = 'eliminated' and "pick_slot"."eliminated_reason" is not null)
          or ("pick_slot"."status" = 'alive' and "pick_slot"."eliminated_reason" is null
              and "pick_slot"."eliminated_season_type" is null and "pick_slot"."eliminated_week" is null))
);
--> statement-breakpoint
CREATE TABLE "game" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"espn_event_id" text NOT NULL,
	"season_year" integer NOT NULL,
	"season_type" integer NOT NULL,
	"week_number" integer NOT NULL,
	"week_state_id" uuid NOT NULL,
	"kickoff_at" timestamp with time zone NOT NULL,
	"home_team_id" uuid NOT NULL,
	"away_team_id" uuid NOT NULL,
	"home_score" integer,
	"away_score" integer,
	"status" "game_status" DEFAULT 'scheduled' NOT NULL,
	"winner_team_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_teams_distinct" CHECK ("game"."home_team_id" <> "game"."away_team_id"),
	CONSTRAINT "game_season_type_valid" CHECK ("game"."season_type" in (2, 3)),
	CONSTRAINT "game_winner_is_a_participant" CHECK ("game"."winner_team_id" is null
          or "game"."winner_team_id" = "game"."home_team_id"
          or "game"."winner_team_id" = "game"."away_team_id"),
	CONSTRAINT "game_winner_requires_final" CHECK ("game"."winner_team_id" is null or "game"."status" = 'final')
);
--> statement-breakpoint
CREATE TABLE "selection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pick_slot_id" uuid NOT NULL,
	"week_state_id" uuid NOT NULL,
	"season_type" integer NOT NULL,
	"week_number" integer NOT NULL,
	"team_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_by_user_id" uuid NOT NULL,
	"was_auto_assigned" boolean DEFAULT false NOT NULL,
	"result" "selection_result" DEFAULT 'pending' NOT NULL,
	"graded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pick_slot" ADD CONSTRAINT "pick_slot_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game" ADD CONSTRAINT "game_week_state_id_week_state_id_fk" FOREIGN KEY ("week_state_id") REFERENCES "public"."week_state"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game" ADD CONSTRAINT "game_home_team_id_team_id_fk" FOREIGN KEY ("home_team_id") REFERENCES "public"."team"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game" ADD CONSTRAINT "game_away_team_id_team_id_fk" FOREIGN KEY ("away_team_id") REFERENCES "public"."team"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game" ADD CONSTRAINT "game_winner_team_id_team_id_fk" FOREIGN KEY ("winner_team_id") REFERENCES "public"."team"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection" ADD CONSTRAINT "selection_pick_slot_id_pick_slot_id_fk" FOREIGN KEY ("pick_slot_id") REFERENCES "public"."pick_slot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection" ADD CONSTRAINT "selection_week_state_id_week_state_id_fk" FOREIGN KEY ("week_state_id") REFERENCES "public"."week_state"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection" ADD CONSTRAINT "selection_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection" ADD CONSTRAINT "selection_game_id_game_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."game"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selection" ADD CONSTRAINT "selection_submitted_by_user_id_app_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "league_singleton_idx" ON "league" USING btree ("singleton");--> statement-breakpoint
CREATE UNIQUE INDEX "league_join_code_idx" ON "league" USING btree ("join_code");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_idx" ON "app_user" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "team_espn_team_id_idx" ON "team" USING btree ("espn_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_abbreviation_idx" ON "team" USING btree ("abbreviation");--> statement-breakpoint
CREATE UNIQUE INDEX "week_state_identity_idx" ON "week_state" USING btree ("season_year","season_type","week_number");--> statement-breakpoint
CREATE UNIQUE INDEX "week_state_ordinal_idx" ON "week_state" USING btree ("season_year","display_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "pick_slot_user_slot_number_idx" ON "pick_slot" USING btree ("user_id","slot_number");--> statement-breakpoint
CREATE UNIQUE INDEX "pick_slot_user_label_idx" ON "pick_slot" USING btree ("user_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "game_espn_event_id_idx" ON "game" USING btree ("espn_event_id");--> statement-breakpoint
CREATE INDEX "game_week_state_idx" ON "game" USING btree ("week_state_id");--> statement-breakpoint
CREATE INDEX "game_kickoff_idx" ON "game" USING btree ("kickoff_at");--> statement-breakpoint
CREATE UNIQUE INDEX "selection_slot_week_idx" ON "selection" USING btree ("pick_slot_id","week_state_id");