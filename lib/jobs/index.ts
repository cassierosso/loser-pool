import { createAuditRecorder } from "@/lib/audit/writer";
import { getDatabase } from "@/lib/db/client";
import { createEspnProvider } from "@/lib/providers/espn";
import type { ScheduleProvider } from "@/lib/providers/types";

import { createAnchorPublisher } from "@/lib/anchor";
import { createMailer } from "@/lib/mail";

import { runGradeWeek } from "./grade-week";
import { lockWeek } from "./lock-week";
import { syncResults } from "./sync-results";
import { syncSchedule } from "./sync-schedule";
import { weeklyDigest } from "./weekly-digest";
import type { JobContext, JobResult } from "./types";

export * from "./types";
export { syncSchedule } from "./sync-schedule";
export { syncResults } from "./sync-results";
export { lockWeek } from "./lock-week";
export { runGradeWeek } from "./grade-week";
export { weeklyDigest } from "./weekly-digest";
export { authorizeJobRequest } from "./auth";

export const JOB_NAMES = [
  "syncSchedule",
  "syncResults",
  "lockWeek",
  "gradeWeek",
  "weeklyDigest",
] as const;
export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}

export async function runJob(
  name: JobName,
  ctx: JobContext,
  options: { ordinal?: number } = {},
): Promise<JobResult> {
  switch (name) {
    case "syncSchedule":
      return syncSchedule(ctx, options.ordinal !== undefined ? { ordinals: [options.ordinal] } : {});
    case "syncResults":
      return syncResults(ctx, options);
    case "lockWeek":
      return lockWeek(ctx, options);
    case "gradeWeek":
      return runGradeWeek(ctx, options);
    case "weeklyDigest":
      // SS7.3 layer 3. Its dependencies are resolved here rather than passed
      // through JobContext, since no other job needs them.
      return weeklyDigest(ctx, { mailer: createMailer(), anchor: createAnchorPublisher() });
  }
}

/**
 * The context the HTTP endpoint and the admin panel both use. Tests build their
 * own with a fixture provider and an in-memory database instead -- SS13: never
 * live ESPN calls.
 */
export async function createJobContext(
  overrides: { provider?: ScheduleProvider; now?: Date } = {},
): Promise<JobContext> {
  const { db } = await getDatabase();
  return {
    db,
    provider: overrides.provider ?? createEspnProvider(),
    recorder: createAuditRecorder(db),
    now: overrides.now ?? new Date(),
  };
}
