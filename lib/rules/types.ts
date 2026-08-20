import type { AuditEvent } from "@/lib/audit/port";

/**
 * SS5 -- the rules engine's domain types.
 *
 * These are deliberately structural subsets of the Drizzle row types, so a row
 * read from the database can be passed straight in without mapping, while the
 * engine itself stays free of any dependency on the database. Nothing in
 * lib/rules performs I/O, reads a clock, or generates a random number: every
 * function is a pure transformation of its inputs, which is what makes the
 * whole of SS13 testable against fixtures.
 */

export type GameStatus = "scheduled" | "in_progress" | "final" | "canceled" | "postponed";
export type SelectionResult = "pending" | "survived" | "eliminated" | "void";
export type PickSlotStatus = "alive" | "eliminated";
export type EliminationReason = "team_won" | "tie" | "no_submission" | "admin";
export type WeekStatus = "upcoming" | "open" | "locked" | "grading" | "graded" | "skipped";

export interface RuleWeek {
  seasonType: number;
  weekNumber: number;
  /** SS2.1: the only axis anything may sort or step along. */
  displayOrdinal: number;
  displayLabel: string;
  status: WeekStatus;
  lockAt: Date | null;
}

export interface RuleGame {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  kickoffAt: Date;
  status: GameStatus;
  /**
   * SS3: on a final, null IS the tie. It is not "unknown" -- it is the outcome
   * that eliminates every pick on both teams.
   */
  winnerTeamId: string | null;
}

export interface RulePickSlot {
  id: string;
  userId: string;
  label: string;
  status: PickSlotStatus;
}

export interface RuleSelection {
  id: string;
  pickSlotId: string;
  teamId: string;
  gameId: string;
  result: SelectionResult;
  wasAutoAssigned: boolean;
}

/** A selection from an earlier week, carrying the ordinal it was made in. */
export interface RulePriorSelection extends RuleSelection {
  weekDisplayOrdinal: number;
}

/** Win-loss record, used only by the auto_underdog fallback. */
export interface TeamRecord {
  teamId: string;
  wins: number;
  losses: number;
  ties: number;
}

/**
 * The engine describes the audit entries its decisions warrant but never writes
 * them; the caller hands them to the SS7 recorder. Phase 1's port owns the
 * shape, minus the fields the writer itself supplies.
 */
export type RuleAuditEntry = AuditEvent;

export function teamsInGame(game: RuleGame): [string, string] {
  return [game.homeTeamId, game.awayTeamId];
}

export function gameForTeam(games: readonly RuleGame[], teamId: string): RuleGame | undefined {
  return games.find((game) => game.homeTeamId === teamId || game.awayTeamId === teamId);
}

/**
 * SS3: any team not appearing in the week's games is on bye and is not
 * selectable. In the postseason this is most of the league, which is expected.
 */
export function isTeamPlaying(games: readonly RuleGame[], teamId: string): boolean {
  return gameForTeam(games, teamId) !== undefined;
}
