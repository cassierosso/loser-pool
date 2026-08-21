-- Idempotent, per the 0006 incident: a migration must survive being
-- partially applied by hand during a recovery.
ALTER TABLE "login_token" ADD COLUMN IF NOT EXISTS "created_by_user_id" uuid;