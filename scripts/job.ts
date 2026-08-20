import { noopAuditRecorder } from "@/lib/audit/port";
import { createDatabase } from "@/lib/db/client";
import { isJobName, JOB_NAMES, runJob } from "@/lib/jobs";
import { createEspnProvider } from "@/lib/providers/espn";

import { argInt, loadEnv, parseArgs } from "./env";

/**
 * Runs an SS8 job from the command line, against the real provider.
 *
 * The same functions the cron endpoint calls, and the same ones the Phase 6
 * admin panel will call. Until then this is how a job is triggered by hand.
 *
 *   npm run job -- syncSchedule
 *   npm run job -- syncResults --ordinal 10
 *   npm run job -- lockWeek
 *   npm run job -- gradeWeek --ordinal 10
 */
async function main(): Promise<void> {
  loadEnv();
  const [name, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!name || !isJobName(name)) {
    console.error(`Usage: npm run job -- <${JOB_NAMES.join("|")}> [--ordinal N]`);
    process.exitCode = 1;
    return;
  }

  const ordinalArg = args.has("ordinal") ? argInt(args, "ordinal", 0) : undefined;
  const handle = await createDatabase(process.env.DATABASE_URL);

  try {
    const result = await runJob(
      name,
      {
        db: handle.db,
        provider: createEspnProvider(),
        // Phase 6 swaps in the real hash-chained writer.
        recorder: noopAuditRecorder,
        now: new Date(),
      },
      ordinalArg !== undefined ? { ordinal: ordinalArg } : {},
    );

    console.log(`\n${result.ok ? "OK" : "FAILED"}: ${result.summary}`);
    if (Object.keys(result.detail).length > 0) {
      console.log(`detail: ${JSON.stringify(result.detail)}`);
    }
    for (const warning of result.warnings) console.warn(`  warning: ${warning}`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
