import { DEFAULT_LEAGUE_CONFIG, type LeagueConfig } from "@/lib/config/schema";
import type {
  RuleGame,
  RulePickSlot,
  RulePriorSelection,
  RuleSelection,
  RuleWeek,
} from "@/lib/rules/types";
import { allWeekDescriptors } from "@/lib/week/ordinal";

/**
 * Builders for the rules-engine tests. The engine is pure, so its fixtures are
 * plain objects -- no database, no network, nothing recorded from ESPN.
 * Team ids are just abbreviations, which keeps failures readable.
 */

export function config(overrides: Partial<LeagueConfig> = {}): LeagueConfig {
  return { ...DEFAULT_LEAGUE_CONFIG, ...overrides };
}

/** All 23 weeks, with the Pro Bowl skipped. Statuses set per ordinal. */
export function weeks(statuses: Record<number, RuleWeek["status"]> = {}): RuleWeek[] {
  return allWeekDescriptors().map((week) => ({
    seasonType: week.seasonType,
    weekNumber: week.weekNumber,
    displayOrdinal: week.displayOrdinal,
    displayLabel: week.displayLabel,
    status: week.skipped ? "skipped" : (statuses[week.displayOrdinal] ?? "upcoming"),
    lockAt: null,
  }));
}

export function week(displayOrdinal: number, overrides: Partial<RuleWeek> = {}): RuleWeek {
  const found = weeks().find((candidate) => candidate.displayOrdinal === displayOrdinal);
  if (!found) throw new Error(`No week at ordinal ${displayOrdinal}`);
  return { ...found, ...overrides };
}

let gameCounter = 0;

export function game(
  home: string,
  away: string,
  overrides: Partial<RuleGame> = {},
): RuleGame {
  gameCounter += 1;
  return {
    id: `game-${gameCounter}`,
    homeTeamId: home,
    awayTeamId: away,
    kickoffAt: new Date("2024-09-08T17:00:00Z"),
    status: "scheduled",
    winnerTeamId: null,
    ...overrides,
  };
}

/** A completed game. Pass null as the winner to make it a tie. */
export function finalGame(home: string, away: string, winner: string | null): RuleGame {
  return game(home, away, { status: "final", winnerTeamId: winner });
}

export function slot(id: string, overrides: Partial<RulePickSlot> = {}): RulePickSlot {
  return { id, userId: "user-1", label: id, status: "alive", ...overrides };
}

export function selection(
  pickSlotId: string,
  teamId: string,
  gameId: string,
  overrides: Partial<RuleSelection> = {},
): RuleSelection {
  return {
    id: `sel-${pickSlotId}-${gameId}`,
    pickSlotId,
    teamId,
    gameId,
    result: "pending",
    wasAutoAssigned: false,
    ...overrides,
  };
}

export function priorSelection(
  pickSlotId: string,
  teamId: string,
  weekDisplayOrdinal: number,
  overrides: Partial<RulePriorSelection> = {},
): RulePriorSelection {
  return {
    id: `prior-${pickSlotId}-${weekDisplayOrdinal}`,
    pickSlotId,
    teamId,
    gameId: `game-prior-${weekDisplayOrdinal}`,
    result: "survived",
    wasAutoAssigned: false,
    weekDisplayOrdinal,
    ...overrides,
  };
}
