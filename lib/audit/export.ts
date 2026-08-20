import type { AuditEntryView } from "./query";

/**
 * SS7.5 -- "Every member can export the full log as CSV or JSON. This lets a
 * suspicious member keep a personal snapshot and diff it later. Make it one
 * button."
 *
 * Both formats carry prev_hash and entry_hash, so an export is not just a
 * readable record: it is a verifiable one. Anyone can recompute the chain from
 * a snapshot they took weeks ago and compare it to what the app shows today.
 */

const COLUMNS = [
  "seq",
  "occurred_at",
  "actor_name",
  "actor_user_id",
  "actor_role",
  "action",
  "target_type",
  "target_id",
  "target_label",
  "before_json",
  "after_json",
  "reason",
  "self_affecting",
  "prev_hash",
  "entry_hash",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Quote whenever the value could otherwise break the row apart.
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(entries: AuditEntryView[]): string {
  const rows = entries.map((entry) =>
    [
      entry.seq,
      entry.occurredAt.toISOString(),
      entry.actorName ?? "(system)",
      entry.actorUserId ?? "",
      entry.actorRole,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.targetLabel,
      entry.beforeJson,
      entry.afterJson,
      entry.reason,
      entry.selfAffecting,
      entry.prevHash,
      entry.entryHash,
    ]
      .map(csvCell)
      .join(","),
  );

  return [COLUMNS.join(","), ...rows].join("\r\n");
}

export function toJson(entries: AuditEntryView[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      seq: entry.seq,
      occurred_at: entry.occurredAt.toISOString(),
      actor_name: entry.actorName,
      actor_user_id: entry.actorUserId,
      actor_role: entry.actorRole,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId,
      target_label: entry.targetLabel,
      before_json: entry.beforeJson,
      after_json: entry.afterJson,
      reason: entry.reason,
      self_affecting: entry.selfAffecting,
      prev_hash: entry.prevHash,
      entry_hash: entry.entryHash,
    })),
    null,
    2,
  );
}
