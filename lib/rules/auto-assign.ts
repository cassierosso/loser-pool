import type { LeagueConfig } from "@/lib/config/schema";

import {
  gameForTeam,
  type RuleAuditEntry,
  type RuleGame,
  type RulePickSlot,
  type RulePriorSelection,
  type RuleSelection,
  type RuleWeek,
  type TeamRecord,
} from "./types";

/**
 * SS5.2 -- missed-pick auto-assignment. Pure: no I/O, no clock.
 *
 * Runs at lock time, before grading, for every alive slot with no selection for
 * the current week. Two steps, first success wins:
 *
 *   1. Repeat the team from the immediately preceding PLAYED week, if that team
 *      is playing this week.
 *   2. Otherwise apply missedPickFallback.
 *
 * Step 1 fails more often than it sounds like it should. It fails in Week 1
 * (nothing precedes it), when the prior team is on bye, and -- the common case
 * -- throughout the postseason, where most of the league is not in the round at
 * all. The fallback is not an edge case; it is most of the postseason.
 */

export interface AutoAssignInput {
  config: LeagueConfig;
  /** The week being locked. */
  week: RuleWeek;
  /** Every week of the season, used to walk backwards by display_ordinal. */
  weeks: RuleWeek[];
  /** This week's games. Teams absent from these are on bye or out of the round. */
  games: RuleGame[];
  aliveSlots: RulePickSlot[];
  /** Selections already submitted for this week, by any means. */
  selectionsThisWeek: RuleSelection[];
  /** Every earlier selection belonging to the slots above. */
  priorSelections: RulePriorSelection[];
  /** Required only when missedPickFallback is auto_underdog. */
  standings?: TeamRecord[];
}

export type AutoAssignResolution = "repeat_last_week" | "auto_underdog" | "eliminate" | "survive";

export interface AutoAssignment {
  slotId: string;
  teamId: string;
  gameId: string;
  resolution: Extract<AutoAssignResolution, "repeat_last_week" | "auto_underdog">;
}

export interface AutoElimination {
  slotId: string;
  reason: "no_submission";
}

export interface AutoAssignOutput {
  assignments: AutoAssignment[];
  eliminations: AutoElimination[];
  /** Slots the "survive" fallback advances with no selection recorded. */
  survivedWithoutSelection: string[];
  auditEntries: RuleAuditEntry[];
}

/**
 * The slot's selection from the immediately preceding played week.
 *
 * Walks down the display_ordinal axis rather than doing arithmetic on
 * week_number, which is what makes the regular/postseason boundary resolve to
 * Week 18 instead of postseason week 0 (acceptance test 21). Weeks marked
 * skipped -- the Pro Bowl -- are stepped over (acceptance test 20), as are
 * weeks where this slot's selection was voided by a canceled game, since a
 * voided pick is not a pick anyone made a decision about.
 */
export function previousPlayedSelection(
  slotId: string,
  week: RuleWeek,
  weeks: readonly RuleWeek[],
  priorSelections: readonly RulePriorSelection[],
): RulePriorSelection | null {
  const earlier = weeks
    .filter((candidate) => candidate.displayOrdinal < week.displayOrdinal)
    .filter((candidate) => candidate.status !== "skipped")
    .sort((a, b) => b.displayOrdinal - a.displayOrdinal);

  for (const candidate of earlier) {
    const selection = priorSelections.find(
      (prior) =>
        prior.pickSlotId === slotId && prior.weekDisplayOrdinal === candidate.displayOrdinal,
    );
    if (!selection) continue;
    if (selection.result === "void") continue;
    return selection;
  }

  return null;
}

/**
 * SS5.2's auto_underdog: "the team least likely to win this week".
 *
 * v1 has no betting odds by design (SS12), so the proxy is the worst record
 * among the teams actually playing -- fewest wins, then most losses, then team
 * id, so the choice is deterministic and reproducible in a fixture. This is a
 * proxy, not a probability; if the league ever wants real odds, this is the one
 * function to replace.
 */
export function leastLikelyToWin(
  games: readonly RuleGame[],
  standings: readonly TeamRecord[],
): string | null {
  const playing = new Set(games.flatMap((game) => [game.homeTeamId, game.awayTeamId]));
  const candidates = standings.filter((record) => playing.has(record.teamId));
  if (candidates.length === 0) return null;

  const [worst] = [...candidates].sort((a, b) => {
    if (a.wins !== b.wins) return a.wins - b.wins;
    if (a.losses !== b.losses) return b.losses - a.losses;
    return a.teamId.localeCompare(b.teamId);
  });

  return worst?.teamId ?? null;
}

function auditFor(
  slot: RulePickSlot,
  week: RuleWeek,
  resolution: AutoAssignResolution,
  detail: Record<string, unknown>,
): RuleAuditEntry {
  return {
    actorUserId: null,
    actorRole: "system",
    action: "selection.auto_assigned",
    targetType: "pick_slot",
    targetId: slot.id,
    targetLabel: `${slot.label} -- ${week.displayLabel}`,
    beforeJson: { selection: null },
    afterJson: { resolution, ...detail },
    reason: `No selection submitted before ${week.displayLabel} locked; resolved by ${resolution}`,
    selfAffecting: false,
  };
}

export function autoAssignWeek(input: AutoAssignInput): AutoAssignOutput {
  const { config, week, weeks, games, aliveSlots, selectionsThisWeek, priorSelections } = input;

  const submitted = new Set(selectionsThisWeek.map((selection) => selection.pickSlotId));
  const missing = aliveSlots.filter((slot) => !submitted.has(slot.id));

  const assignments: AutoAssignment[] = [];
  const eliminations: AutoElimination[] = [];
  const survivedWithoutSelection: string[] = [];
  const auditEntries: RuleAuditEntry[] = [];

  for (const slot of missing) {
    // Step 1: repeat last week's team.
    if (config.missedPick === "repeat_last_week") {
      const prior = previousPlayedSelection(slot.id, week, weeks, priorSelections);
      const game = prior ? gameForTeam(games, prior.teamId) : undefined;

      if (prior && game) {
        assignments.push({
          slotId: slot.id,
          teamId: prior.teamId,
          gameId: game.id,
          resolution: "repeat_last_week",
        });
        auditEntries.push(
          auditFor(slot, week, "repeat_last_week", { teamId: prior.teamId, gameId: game.id }),
        );
        continue;
      }
    }

    // Step 2: the fallback.
    switch (config.missedPickFallback) {
      case "eliminate": {
        eliminations.push({ slotId: slot.id, reason: "no_submission" });
        auditEntries.push(auditFor(slot, week, "eliminate", { eliminated: true }));
        break;
      }
      case "auto_underdog": {
        if (!input.standings) {
          throw new Error(
            "missedPickFallback is auto_underdog but no standings were supplied to autoAssignWeek().",
          );
        }
        const teamId = leastLikelyToWin(games, input.standings);
        const game = teamId ? gameForTeam(games, teamId) : undefined;

        if (!teamId || !game) {
          // No team to assign at all (an empty round). Falling through to an
          // elimination here would kill a slot for the scheduler's mistake.
          survivedWithoutSelection.push(slot.id);
          auditEntries.push(
            auditFor(slot, week, "survive", { note: "no team available to assign" }),
          );
          break;
        }

        assignments.push({ slotId: slot.id, teamId, gameId: game.id, resolution: "auto_underdog" });
        auditEntries.push(auditFor(slot, week, "auto_underdog", { teamId, gameId: game.id }));
        break;
      }
      case "survive": {
        survivedWithoutSelection.push(slot.id);
        auditEntries.push(auditFor(slot, week, "survive", { advanced: true }));
        break;
      }
    }
  }

  return { assignments, eliminations, survivedWithoutSelection, auditEntries };
}
