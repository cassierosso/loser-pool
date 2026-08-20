-- SS7.3 layer 2 -- database-level enforcement.
--
-- Layer 1 is that no application code can mutate audit_log. This layer makes it
-- true even for code that tries: a trigger that refuses every UPDATE and DELETE
-- unconditionally, and a restricted role the application connects as which
-- holds INSERT and SELECT but not UPDATE or DELETE.
--
-- Neither layer stops the admin, who holds the owner credentials. Only the
-- external anchoring in Phase 6b does. These layers stop everything else --
-- including a bug, a stray migration, and an ORM doing something clever.

-- ---------------------------------------------------------------------------
-- The trigger. Fires for everyone, owner included.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log is append-only: % on entry #% is not permitted',
    TG_OP, COALESCE(OLD.seq, NEW.seq)
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_no_update_or_delete ON audit_log;
--> statement-breakpoint

CREATE TRIGGER audit_log_no_update_or_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The restricted application role.
--
-- Wrapped in a DO block because roles are cluster-wide: the role may already
-- exist from another deployment sharing the server, and CREATE ROLE would fail.
-- Skipped entirely where the platform does not support roles (PGlite runs
-- single-user, and the trigger above is what protects it).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'loser_survivor_app') THEN
    CREATE ROLE loser_survivor_app NOLOGIN;
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR feature_not_supported THEN
    RAISE NOTICE 'Skipping role creation: not supported here. The append-only trigger still applies.';
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  GRANT INSERT, SELECT ON audit_log TO loser_survivor_app;
  REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM loser_survivor_app;
  -- The sequence behind audit_log.id must be usable for INSERT to work.
  GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO loser_survivor_app;
EXCEPTION
  WHEN undefined_object OR insufficient_privilege OR feature_not_supported THEN
    RAISE NOTICE 'Skipping audit_log grants: role support unavailable.';
END
$$;
