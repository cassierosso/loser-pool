CREATE TYPE "public"."actor_role" AS ENUM('player', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."audit_target_type" AS ENUM('user', 'pick_slot', 'selection', 'game', 'league', 'job');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_user_id" uuid,
	"actor_role" "actor_role" NOT NULL,
	"action" text NOT NULL,
	"target_type" "audit_target_type" NOT NULL,
	"target_id" text NOT NULL,
	"target_label" text NOT NULL,
	"before_json" jsonb NOT NULL,
	"after_json" jsonb NOT NULL,
	"reason" text NOT NULL,
	"self_affecting" boolean DEFAULT false NOT NULL,
	"prev_hash" char(64) NOT NULL,
	"entry_hash" char(64) NOT NULL,
	CONSTRAINT "audit_log_seq_positive" CHECK ("audit_log"."seq" >= 1),
	CONSTRAINT "audit_log_reason_present" CHECK (length(btrim("audit_log"."reason")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_seq_idx" ON "audit_log" USING btree ("seq");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_log_entry_hash_idx" ON "audit_log" USING btree ("entry_hash");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");