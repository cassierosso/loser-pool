import { createHash } from "node:crypto";

/**
 * SS7.2 -- the hash chain.
 *
 *   entry_hash = sha256(prev_hash || seq || occurred_at || actor_user_id ||
 *                       action || target_type || target_id || before_json ||
 *                       after_json || reason)
 *
 * with the genesis entry using 64 zeros as prev_hash, "serialised
 * deterministically (sorted JSON keys, ISO-8601 UTC timestamps) so the hash is
 * reproducible".
 *
 * Reproducible is the whole point: a member who exported the log last week must
 * be able to recompute today's chain head and get the same string. So the rules
 * below are fixed and documented rather than incidental.
 *
 * ONE DEVIATION from the spec's formula, deliberate: the fields are joined with
 * a newline rather than concatenated directly. Bare concatenation is ambiguous
 * -- action "a" + target "bc" hashes identically to action "ab" + target "c" --
 * which would let two different histories share a hash. The separator closes
 * that. Any independent verifier must use it too.
 */

export const GENESIS_PREV_HASH = "0".repeat(64);

/** The field separator. A newline cannot appear in a hash, seq, or timestamp. */
const FIELD_SEPARATOR = "\n";

/**
 * JSON with object keys sorted at every depth, so two structurally identical
 * payloads always serialise byte-for-byte identically. Array order is preserved
 * -- it carries meaning.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      // undefined members are absent from JSON, so they must not affect the hash.
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
  }

  return "null";
}

export interface HashableEntry {
  seq: number;
  occurredAt: Date;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  beforeJson: unknown;
  afterJson: unknown;
  reason: string;
}

/** The exact string that gets hashed. Exposed so a verifier can show its work. */
export function canonicalPayload(entry: HashableEntry, prevHash: string): string {
  return [
    prevHash,
    String(entry.seq),
    entry.occurredAt.toISOString(),
    // A null actor is the system. Empty string is its canonical form, and it
    // cannot collide with a uuid.
    entry.actorUserId ?? "",
    entry.action,
    entry.targetType,
    entry.targetId,
    canonicalJson(entry.beforeJson),
    canonicalJson(entry.afterJson),
    entry.reason,
  ].join(FIELD_SEPARATOR);
}

export function computeEntryHash(entry: HashableEntry, prevHash: string): string {
  return createHash("sha256").update(canonicalPayload(entry, prevHash), "utf8").digest("hex");
}
