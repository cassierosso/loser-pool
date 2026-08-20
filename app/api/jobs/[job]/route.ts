import { NextResponse } from "next/server";

import { authorizeJobRequest, createJobContext, isJobName, runJob } from "@/lib/jobs";

/**
 * SS8: each job is an HTTP endpoint protected by a shared CRON_SECRET bearer
 * token, triggered by GitHub Actions cron and (from Phase 6) by an admin.
 *
 *   POST /api/jobs/syncSchedule
 *   POST /api/jobs/gradeWeek?ordinal=5
 *   Authorization: Bearer $CRON_SECRET
 *
 * Node runtime: the database drivers are not edge-compatible.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ job: string }> },
): Promise<NextResponse> {
  const auth = authorizeJobRequest(request.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.message }, { status: auth.status });
  }

  const { job } = await context.params;
  if (!isJobName(job)) {
    return NextResponse.json({ ok: false, error: `Unknown job "${job}".` }, { status: 404 });
  }

  const url = new URL(request.url);
  const rawOrdinal = url.searchParams.get("ordinal");
  const ordinal = rawOrdinal === null ? undefined : Number.parseInt(rawOrdinal, 10);
  if (ordinal !== undefined && (Number.isNaN(ordinal) || ordinal < 1 || ordinal > 23)) {
    return NextResponse.json(
      { ok: false, error: "ordinal must be a display_ordinal between 1 and 23." },
      { status: 400 },
    );
  }

  try {
    const ctx = await createJobContext();
    const result = await runJob(job, ctx, ordinal !== undefined ? { ordinal } : {});

    // SS8: failures are loud. A job that could not complete returns 409 so the
    // cron run is visibly red rather than a 200 nobody reads.
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        job,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
