import type { AuditEntryView } from "./query";

/**
 * SS7.3 -- "Every admin action from the past week, rendered in plain English
 * with before/after."
 *
 * The digest is the part of the log most people will ever actually read, and
 * they will read it in an email on a phone. So an entry has to explain itself
 * without the reader knowing what a pick_slot is, and the before/after has to
 * be in the sentence rather than in a JSON blob underneath it.
 */

function value(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const found = (payload as Record<string, unknown>)[key];
  if (found === null || found === undefined) return null;
  return String(found);
}

function actorName(entry: AuditEntryView): string {
  return entry.actorName ?? (entry.actorRole === "system" ? "The system" : "Someone");
}

/** One sentence, in plain English, with the change stated in it. */
export function describeEntry(entry: AuditEntryView): string {
  const who = actorName(entry);
  const target = entry.targetLabel;

  switch (entry.action) {
    case "user.picks_purchased.change": {
      const before = value(entry.beforeJson, "picksPurchased") ?? "?";
      const after = value(entry.afterJson, "picksPurchased") ?? "?";
      const override = value(entry.afterJson, "overrideUsed") === "true";
      return (
        `${who} changed ${target}'s pick count from ${before} to ${after}` +
        (override ? ", overriding the mid-season freeze to do it." : ".")
      );
    }

    case "user.payment_status.change":
      return `${who} marked ${target} as ${value(entry.afterJson, "payment_status") ?? "changed"} (was ${value(entry.beforeJson, "payment_status") ?? "unset"}).`;

    case "user.payment_note.change":
      return `${who} updated the payment note for ${target}.`;

    case "user.role.change":
      return `${who} changed ${target}'s role from ${value(entry.beforeJson, "role")} to ${value(entry.afterJson, "role")}.`;

    case "user.create":
      return `${who} added ${target} to the league.`;

    case "pick_slot.eliminate":
      return `${who} ELIMINATED ${target} by hand.`;

    case "pick_slot.revive":
      return `${who} REVIVED ${target}, which had been eliminated.`;

    case "selection.override": {
      const beforeTeam = value(entry.beforeJson, "result");
      const afterTeam = value(entry.afterJson, "result");
      return `${who} changed ${target}: result ${beforeTeam ?? "?"} → ${afterTeam ?? "?"}.`;
    }

    case "selection.submit":
      return `${target} was submitted.`;

    case "selection.edit":
      return `${target} was changed from ${value(entry.beforeJson, "team") ?? "?"} to ${value(entry.afterJson, "team") ?? "?"}.`;

    case "selection.clear":
      return `${target} was removed (${value(entry.beforeJson, "team") ?? "?"}).`;

    case "selection.auto_assigned":
      return `${target} had no pick at lock, so the system resolved it by ${value(entry.afterJson, "resolution") ?? "fallback"}.`;

    case "game.override":
      return (
        `${who} overrode ${target}: ` +
        `${value(entry.beforeJson, "homeScore") ?? "–"}-${value(entry.beforeJson, "awayScore") ?? "–"} ` +
        `(${value(entry.beforeJson, "status")}) → ` +
        `${value(entry.afterJson, "homeScore") ?? "–"}-${value(entry.afterJson, "awayScore") ?? "–"} ` +
        `(${value(entry.afterJson, "status")}).`
      );

    case "league.config.change":
      return `${who} edited the league settings. ${describeConfigDiff(entry)}`;

    case "season.playoff_decision":
      return `${who} resolved the playoff decision: ${value(entry.afterJson, "playoffMode")}.`;

    case "job.trigger":
      return `${who} manually ran the ${value(entry.afterJson, "job") ?? "unknown"} job.`;

    case "week.locked":
      return `${target}. ${value(entry.afterJson, "autoAssigned") ?? 0} picks were auto-assigned, ${value(entry.afterJson, "eliminated") ?? 0} eliminated for no submission.`;

    case "week.graded":
      return `${target}: ${value(entry.afterJson, "survived") ?? 0} survived, ${value(entry.afterJson, "eliminated") ?? 0} eliminated, ${value(entry.afterJson, "slotsEliminated") ?? 0} picks knocked out.`;

    case "season.champion":
      return `The season closed. ${entry.reason}`;

    case "season.co_champions":
      return `The season closed with co-champions. ${entry.reason}`;

    default:
      // An action nobody wrote a sentence for still has to appear -- silence is
      // the one thing the log may never do.
      return `${who} performed ${entry.action} on ${target}.`;
  }
}

/** Names only the settings that actually moved. */
function describeConfigDiff(entry: AuditEntryView): string {
  const before = (entry.beforeJson as { config?: Record<string, unknown> })?.config ?? {};
  const after = (entry.afterJson as { config?: Record<string, unknown> })?.config ?? {};

  const changes = Object.keys(after)
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => `${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(after[key])}`);

  return changes.length === 0 ? "No values changed." : changes.join("; ") + ".";
}
