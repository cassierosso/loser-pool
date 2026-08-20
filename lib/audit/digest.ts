import { and, asc, eq, gte } from "drizzle-orm";

import type { Database } from "@/lib/db/client";
import { auditLog, users } from "@/lib/db/schema";
import { DISPLAY_TIME_ZONE } from "@/lib/time";

import { describeEntry } from "./describe";
import type { AuditEntryView } from "./query";
import { getChainHead } from "./writer";

/**
 * SS7.3 layer 3 -- the weekly digest.
 *
 * "Every member now holds independent, externally timestamped copies of the
 * chain head. Altering history becomes detectable by anyone who scrolls back
 * through their inbox."
 *
 * That sentence is the entire design. The digest is not a newsletter; it is a
 * distributed, tamper-evident witness. Which is why the head hash appears in
 * full, with an instruction to compare it, even in weeks when nothing happened.
 */

export const DIGEST_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export interface DigestData {
  since: Date;
  until: Date;
  adminActions: AuditEntryView[];
  head: { seq: number; entryHash: string } | null;
  recipients: Array<{ id: string; email: string; displayName: string }>;
}

export async function buildDigestData(
  db: Database,
  options: { now?: Date; since?: Date } = {},
): Promise<DigestData> {
  const until = options.now ?? new Date();
  const since = options.since ?? new Date(until.getTime() - DIGEST_PERIOD_MS);

  const rows = await db
    .select({ entry: auditLog, actorName: users.displayName })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(and(eq(auditLog.actorRole, "admin"), gte(auditLog.occurredAt, since)))
    .orderBy(asc(auditLog.seq));

  const recipients = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .orderBy(users.displayName);

  return {
    since,
    until,
    adminActions: rows.map((row) => ({ ...row.entry, actorName: row.actorName })),
    head: await getChainHead(db),
    // SS7.3: EVERY league member, not only the ones with picks. A member with
    // nothing at stake is still a witness.
    recipients: recipients.filter((person) => person.email.includes("@")),
  };
}

const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function renderDigestText(data: DigestData, leagueName: string): string {
  const lines: string[] = [];

  lines.push(`${leagueName} — weekly log digest`);
  lines.push(`${dateFormat.format(data.since)} to ${dateFormat.format(data.until)}`);
  lines.push("");

  if (data.adminActions.length === 0) {
    lines.push("No admin actions were taken this week.");
  } else {
    lines.push(
      `${data.adminActions.length} admin action${data.adminActions.length === 1 ? "" : "s"}:`,
    );
    lines.push("");
    for (const entry of data.adminActions) {
      lines.push(`#${entry.seq}  ${dateFormat.format(entry.occurredAt)}`);
      lines.push(`  ${describeEntry(entry)}`);
      lines.push(`  Reason given: ${entry.reason}`);
      if (entry.selfAffecting) {
        lines.push("  ** THIS WAS AN ADMIN ACTING ON THEIR OWN ENTRY **");
      }
      lines.push("");
    }
  }

  lines.push("—".repeat(50));
  lines.push("LOG INTEGRITY");
  lines.push("");

  if (data.head) {
    lines.push(`Chain head: entry #${data.head.seq}`);
    lines.push(data.head.entryHash);
    lines.push("");
    // SS7.3's required one-liner.
    lines.push("Compare this hash to the one shown on the League Board.");
    lines.push("");
    lines.push(
      "If they differ, the log has been altered since this email was sent. Keep this " +
        "message: it is a timestamped, independent copy that nobody with database access " +
        "can reach.",
    );
  } else {
    lines.push("The log is empty; there is nothing to anchor yet.");
  }

  return lines.join("\n");
}

/**
 * The LOG_ANCHOR.md contents -- the second, independent timestamp trail.
 *
 * Deliberately append-only in spirit: the job adds a row rather than rewriting
 * the file, so the repository's own history carries every head hash the league
 * has ever had, each with a commit timestamp GitHub records independently.
 */
export function renderAnchorRow(data: DigestData): string {
  const head = data.head;
  return `| ${data.until.toISOString()} | ${head ? `#${head.seq}` : "—"} | \`${head?.entryHash ?? "empty"}\` | ${data.adminActions.length} |`;
}

export const ANCHOR_HEADER = [
  "# Log anchor",
  "",
  "Each row records the audit log's chain head at the moment the weekly digest was sent.",
  "Written by the `weeklyDigest` job; see §7.3 of the spec.",
  "",
  "This file exists so the league has a second, independent timestamp trail alongside the",
  "digest emails. An admin can rewrite the database, but not this file's git history without",
  "that showing up too.",
  "",
  "| sent at (UTC) | chain head | entry hash | admin actions that week |",
  "|---|---|---|---|",
].join("\n");

export function renderAnchorFile(existing: string | null, data: DigestData): string {
  const row = renderAnchorRow(data);
  if (!existing || !existing.includes("| sent at (UTC) |")) {
    return `${ANCHOR_HEADER}\n${row}\n`;
  }
  return `${existing.trimEnd()}\n${row}\n`;
}
