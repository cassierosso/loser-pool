import type { AuditRecorder } from "@/lib/audit/port";
import type { Database } from "@/lib/db/client";
import type { ScheduleProvider } from "@/lib/providers/types";

/**
 * SS8 -- the jobs.
 *
 * Every job is a plain function over this context, so it can be driven by the
 * cron endpoint, by an admin button (Phase 6), or by a test with a fixture
 * provider and an in-memory database. The HTTP route is a thin wrapper that
 * checks the bearer token and calls one of these.
 */
export interface JobContext {
  db: Database;
  provider: ScheduleProvider;
  recorder: AuditRecorder;
  /** Injected so job behaviour around lock times is testable. */
  now: Date;
}

export interface JobResult {
  job: string;
  ok: boolean;
  /** A one-line summary for the admin banner and the job log. */
  summary: string;
  /** Structured detail; shape varies per job. */
  detail: Record<string, unknown>;
  /**
   * SS8: failures must be loud, never a silent half-apply. Anything here is
   * surfaced to the admin rather than swallowed.
   */
  warnings: string[];
}
