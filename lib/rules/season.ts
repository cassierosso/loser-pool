import type { LeagueConfig } from "@/lib/config/schema";
import { REGULAR_SEASON_WEEKS } from "@/lib/week/ordinal";

import type { RuleAuditEntry, RuleWeek } from "./types";

/**
 * SS6 -- how the season ends. Pure: no I/O, no clock.
 *
 * Evaluated immediately after each week is graded, on a single question: how
 * many entrants still hold at least one alive pick slot?
 */

export interface EntrantState {
  userId: string;
  aliveSlotCount: number;
}

export interface EvaluateSeasonEndInput {
  config: LeagueConfig;
  /** The week that was just graded. */
  gradedWeek: RuleWeek;
  /** Every week of the season, for finding what comes next. */
  weeks: RuleWeek[];
  /** Entrants and their alive counts AFTER grading. */
  entrantsAfter: EntrantState[];
  /**
   * Entrants who were alive ENTERING the graded week. Only consulted for the
   * wipeout rule, where everyone died at once and the co-champions are the
   * people who were still standing when the week began.
   */
  entrantsEnteringWeek: EntrantState[];
}

export type SeasonEndOutcome =
  | { kind: "champion"; userIds: string[]; reason: string }
  | {
      kind: "co_champions";
      userIds: string[];
      cause: "wipeout" | "final_tie" | "regular_season_stop";
      reason: string;
    }
  | { kind: "open_week"; week: RuleWeek; reason: string }
  | { kind: "pending_admin"; question: "playoff_mode" | "wipeout"; reason: string };

export interface EvaluateSeasonEndOutput {
  outcome: SeasonEndOutcome;
  auditEntries: RuleAuditEntry[];
}

/** The next week that is actually played -- the Pro Bowl is never it. */
export function nextPlayableWeek(weeks: readonly RuleWeek[], afterOrdinal: number): RuleWeek | null {
  return (
    [...weeks]
      .filter((week) => week.displayOrdinal > afterOrdinal && week.status !== "skipped")
      .sort((a, b) => a.displayOrdinal - b.displayOrdinal)[0] ?? null
  );
}

function alive(entrants: readonly EntrantState[]): EntrantState[] {
  return entrants.filter((entrant) => entrant.aliveSlotCount > 0);
}

/** Everyone tied at the highest surviving pick count. */
function topByAliveCount(entrants: readonly EntrantState[]): string[] {
  const best = Math.max(...entrants.map((entrant) => entrant.aliveSlotCount));
  return entrants
    .filter((entrant) => entrant.aliveSlotCount === best)
    .map((entrant) => entrant.userId)
    .sort();
}

function audit(action: string, label: string, detail: Record<string, unknown>, reason: string): RuleAuditEntry {
  return {
    actorUserId: null,
    actorRole: "system",
    action,
    targetType: "league",
    targetId: "league",
    targetLabel: label,
    beforeJson: {},
    afterJson: detail,
    reason,
    selfAffecting: false,
  };
}

export function evaluateSeasonEnd(input: EvaluateSeasonEndInput): EvaluateSeasonEndOutput {
  const { config, gradedWeek, weeks, entrantsAfter, entrantsEnteringWeek } = input;

  const survivors = alive(entrantsAfter);
  const isLastRegularSeasonWeek =
    gradedWeek.seasonType === 2 && gradedWeek.weekNumber === REGULAR_SEASON_WEEKS;
  const next = nextPlayableWeek(weeks, gradedWeek.displayOrdinal);

  // Exactly one entrant left: they have won, and the season closes here even if
  // postseason weeks are sitting there unplayed. Acceptance test 17.
  if (survivors.length === 1) {
    const reason = `One entrant remains after ${gradedWeek.displayLabel}.`;
    return {
      outcome: { kind: "champion", userIds: [survivors[0]!.userId], reason },
      auditEntries: [
        audit("season.champion", "Season closed", { userIds: [survivors[0]!.userId] }, reason),
      ],
    };
  }

  // Nobody left: everyone still standing died in the same week.
  if (survivors.length === 0) {
    if (config.wipeoutRule === "admin_decides") {
      const reason = `Every remaining entrant was eliminated in ${gradedWeek.displayLabel}; wipeoutRule is admin_decides.`;
      return {
        outcome: { kind: "pending_admin", question: "wipeout", reason },
        auditEntries: [audit("season.pending_admin", "Wipeout", { week: gradedWeek.displayLabel }, reason)],
      };
    }

    const coChampions = alive(entrantsEnteringWeek)
      .map((entrant) => entrant.userId)
      .sort();
    const reason = `Every remaining entrant was eliminated in ${gradedWeek.displayLabel}; all who entered the week share the title.`;
    return {
      outcome: { kind: "co_champions", userIds: coChampions, cause: "wipeout", reason },
      auditEntries: [audit("season.co_champions", "Wipeout", { userIds: coChampions }, reason)],
    };
  }

  // Two or more remain. Past the Super Bowl there is nothing left to play.
  if (!next) {
    const champions = topByAliveCount(survivors);
    const reason = `${survivors.length} entrants survived the Super Bowl; finalTieRule is ${config.finalTieRule}.`;
    return {
      outcome: { kind: "co_champions", userIds: champions, cause: "final_tie", reason },
      auditEntries: [audit("season.co_champions", "Final tie", { userIds: champions }, reason)],
    };
  }

  // Two or more remain and Week 18 has just been graded: the playoff question.
  if (isLastRegularSeasonWeek) {
    switch (config.playoffMode) {
      case "continue": {
        const reason = `${survivors.length} entrants survived the regular season; playoffMode is continue.`;
        return {
          outcome: { kind: "open_week", week: next, reason },
          auditEntries: [audit("week.opened", next.displayLabel, { ordinal: next.displayOrdinal }, reason)],
        };
      }
      case "stop_at_regular_season": {
        const champions = topByAliveCount(survivors);
        const reason = `playoffMode is stop_at_regular_season; ranked by surviving picks, then finalTieRule ${config.finalTieRule}.`;
        return {
          outcome: {
            kind: "co_champions",
            userIds: champions,
            cause: "regular_season_stop",
            reason,
          },
          auditEntries: [
            audit(
              "season.co_champions",
              "Regular season finish",
              {
                userIds: champions,
                ranking: [...survivors].sort((a, b) => b.aliveSlotCount - a.aliveSlotCount),
              },
              reason,
            ),
          ],
        };
      }
      case "admin_decides": {
        // SS6: freeze and prompt. Do NOT open a week until they answer.
        const reason = `${survivors.length} entrants survived the regular season; playoffMode is admin_decides.`;
        return {
          outcome: { kind: "pending_admin", question: "playoff_mode", reason },
          auditEntries: [audit("season.pending_admin", "Playoff decision", {}, reason)],
        };
      }
    }
  }

  // Ordinary case: play on. Round by round in the postseason, with the pool
  // shrinking 6 -> 4 -> 2 -> 1, which is expected rather than a problem.
  const reason = `${survivors.length} entrants remain after ${gradedWeek.displayLabel}.`;
  return {
    outcome: { kind: "open_week", week: next, reason },
    auditEntries: [audit("week.opened", next.displayLabel, { ordinal: next.displayOrdinal }, reason)],
  };
}
