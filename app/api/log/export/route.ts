import { requireUser } from "@/lib/auth/current-user";
import { toCsv, toJson } from "@/lib/audit/export";
import { listAllAuditEntries } from "@/lib/audit/query";
import { getDatabase } from "@/lib/db/client";

/**
 * SS7.5 -- "Every member can export the full log as CSV or JSON."
 *
 * EVERY member, deliberately: requireUser, not requireAdmin. A log only the
 * admin can export is not accountability (acceptance test 29).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  await requireUser();

  const format = new URL(request.url).searchParams.get("format") === "csv" ? "csv" : "json";
  const { db } = await getDatabase();
  const entries = await listAllAuditEntries(db);

  const body = format === "csv" ? toCsv(entries) : toJson(entries);
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json",
      "content-disposition": `attachment; filename="league-log-${stamp}.${format}"`,
      // A snapshot is only useful if it is the log as it stands right now.
      "cache-control": "no-store",
    },
  });
}
