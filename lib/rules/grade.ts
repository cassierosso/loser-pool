import type { LeagueConfig } from "@/lib/config/schema";

import type {
  EliminationReason,
  RuleAuditEntry,
  RuleGame,
  RulePickSlot,
  RuleSelection,
  SelectionResult,
} from "./types";

/**
 * SS5.1 -- grading a week. Pure: no I/O, no clock.
 *
 * The outcome of a selection is decided by the game its team played:
 *
 *   team lost outright  -> survived
 *   team won            -> eliminated (team_won)
 *   game tied           -> eliminated (tie)      <- both teams, SS0 tieResult
 *   game canceled       -> void, the pick lives on
 *   game postponed      -> pending, and the week cannot be graded at all
 */

export interface GradeWeekInput {
  config: LeagueConfig;
  seasonType: number;
  weekNumber: number;
  /** Every game in the week, whatever its status. */
  games: RuleGame[];
  selections: RuleSelection[];
  aliveSlots: RulePickSlot[];
}

export interface SelectionResultUpdate {
  selectionId: string;
  pickSlotId: string;
  from: SelectionResult;
  to: SelectionResult;
  /** Present only when the outcome eliminates the slot. */
  eliminationReason?: EliminationReason;
}

export interface SlotUpdate {
  slotId: string;
  status: "eliminated";
  reason: EliminationReason;
  seasonType: number;
  weekNumber: number;
}

export interface GradeWeekOutput {
  /**
   * SS8: the job runs only when every non-canceled game in the week is final.
   * When false, the two update lists are empty -- a week is graded as a whole
   * or not at all, never half-applied.
   */
  canGrade: boolean;
  /** Game ids preventing grading, so the admin banner can name them. */
  blockedBy: string[];
  selectionResults: SelectionResultUpdate[];
  slotUpdates: SlotUpdate[];
  auditEntries: RuleAuditEntry[];
}

/** A game blocks grading unless it is finished or called off entirely. */
function blocksGrading(game: RuleGame): boolean {
  return game.status !== "final" && game.status !== "canceled";
}

function outcomeFor(
  game: RuleGame | undefined,
  selection: RuleSelection,
  config: LeagueConfig,
): { result: SelectionResult; eliminationReason?: EliminationReason } {
  // A selection whose game is missing from the input is not something to guess
  // about: leave it pending and let the caller notice.
  if (!game) return { result: "pending" };

  if (game.status === "canceled") return { result: "void" };
  if (game.status !== "final") return { result: "pending" };

  if (game.winnerTeamId === null) {
    // SS0 tieResult. Written as an exhaustive switch so that adding a second
    // value to the union is a compile error here rather than a silent fall
    // through to "survived" -- which is exactly the bug that would let a tie
    // quietly stop eliminating people.
    switch (config.tieResult) {
      case "eliminate":
        return { result: "eliminated", eliminationReason: "tie" };
      default: {
        const unhandled: never = config.tieResult;
        throw new Error(`Unhandled tieResult: ${String(unhandled)}`);
      }
    }
  }

  if (game.winnerTeamId === selection.teamId) {
    return { result: "eliminated", eliminationReason: "team_won" };
  }

  return { result: "survived" };
}

/**
 * Grades every selection in a week.
 *
 * Idempotent by construction: an update is emitted only where the computed
 * outcome differs from what the selection already says, and a slot update only
 * where the slot is still alive. Running this twice over the state produced by
 * the first run yields empty lists -- SS8's "must be safe to run twice", and
 * acceptance test 14.
 */
export function gradeWeek(input: GradeWeekInput): GradeWeekOutput {
  const { config, seasonType, weekNumber, games, selections, aliveSlots } = input;

  const blockedBy = games.filter(blocksGrading).map((game) => game.id);
  if (blockedBy.length > 0) {
    return { canGrade: false, blockedBy, selectionResults: [], slotUpdates: [], auditEntries: [] };
  }

  const gamesById = new Map(games.map((game) => [game.id, game]));
  const aliveSlotIds = new Set(aliveSlots.map((slot) => slot.id));

  const selectionResults: SelectionResultUpdate[] = [];
  const slotUpdates: SlotUpdate[] = [];

  for (const selection of selections) {
    const { result, eliminationReason } = outcomeFor(
      gamesById.get(selection.gameId),
      selection,
      config,
    );

    if (result !== selection.result) {
      selectionResults.push({
        selectionId: selection.id,
        pickSlotId: selection.pickSlotId,
        from: selection.result,
        to: result,
        ...(eliminationReason ? { eliminationReason } : {}),
      });
    }

    // Only a slot that is still alive can be killed, and only once.
    if (eliminationReason && aliveSlotIds.has(selection.pickSlotId)) {
      slotUpdates.push({
        slotId: selection.pickSlotId,
        status: "eliminated",
        reason: eliminationReason,
        seasonType,
        weekNumber,
      });
      aliveSlotIds.delete(selection.pickSlotId);
    }
  }

  const auditEntries: RuleAuditEntry[] =
    selectionResults.length === 0 && slotUpdates.length === 0
      ? [] // A no-op second run records nothing.
      : [
          {
            actorUserId: null,
            actorRole: "system",
            action: "week.graded",
            targetType: "job",
            targetId: `${seasonType}:${weekNumber}`,
            targetLabel: `Grading -- season type ${seasonType}, week ${weekNumber}`,
            beforeJson: { pendingSelections: selections.filter((s) => s.result === "pending").length },
            afterJson: {
              survived: selectionResults.filter((r) => r.to === "survived").length,
              eliminated: selectionResults.filter((r) => r.to === "eliminated").length,
              void: selectionResults.filter((r) => r.to === "void").length,
              slotsEliminated: slotUpdates.length,
            },
            reason: `Automatic grading of season type ${seasonType}, week ${weekNumber}`,
            selfAffecting: false,
          },
        ];

  return { canGrade: true, blockedBy: [], selectionResults, slotUpdates, auditEntries };
}
