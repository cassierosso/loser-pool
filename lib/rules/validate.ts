import type { LeagueConfig } from "@/lib/config/schema";

import { gameForTeam, type RuleGame, type RulePickSlot, type RuleSelection, type RuleWeek } from "./types";

/**
 * SS5.3 -- selection validation. Pure: no I/O; the clock is an input.
 *
 * NEVER TRUST THE CLIENT. This runs server-side on every submit, whatever the
 * UI believed was allowed. Acceptance test 5 exists precisely because a client
 * that permits a late submission must still be refused.
 */

export type ValidationCode =
  | "not_your_slot"
  | "no_picks_purchased"
  | "slot_eliminated"
  | "week_not_open"
  | "week_locked"
  | "team_not_playing"
  | "game_kicked_off";

/** Never a block -- SS5.3 requires these be shown as badges only. */
export type ValidationInfoCode = "team_reused" | "same_team_as_another_slot";

export interface ValidationInfo {
  code: ValidationInfoCode;
  message: string;
}

export type ValidationResult =
  | { ok: true; info: ValidationInfo[] }
  | { ok: false; code: ValidationCode; reason: string };

export interface ValidateSelectionInput {
  config: LeagueConfig;
  week: RuleWeek;
  pickSlot: RulePickSlot;
  /** The signed-in user attempting the submission. */
  requestingUserId: string;
  /** The owner of the slot, whose entitlement is being checked. */
  user: { id: string; picksPurchased: number };
  teamId: string;
  games: RuleGame[];
  otherSelectionsThisWeekForUser: RuleSelection[];
  /** How many times this slot has already used this team. Badge data only. */
  priorUsesOfTeamByThisSlot?: number;
  now: Date;
}

export function validateSelection(input: ValidateSelectionInput): ValidationResult {
  const { config, week, pickSlot, requestingUserId, user, teamId, games, now } = input;

  if (pickSlot.userId !== requestingUserId || user.id !== pickSlot.userId) {
    return {
      ok: false,
      code: "not_your_slot",
      reason: "That pick slot belongs to another entrant.",
    };
  }

  // SS2: a user with picks_purchased = 0 can log in and look around, but has
  // nothing to submit with.
  if (user.picksPurchased === 0) {
    return {
      ok: false,
      code: "no_picks_purchased",
      reason: "You have no picks. Ask the admin to record your payment first.",
    };
  }

  if (pickSlot.status === "eliminated") {
    return {
      ok: false,
      code: "slot_eliminated",
      reason: `${pickSlot.label} was eliminated and cannot pick again. Eliminations are permanent.`,
    };
  }

  if (week.status !== "open") {
    return {
      ok: false,
      code: "week_not_open",
      reason:
        week.status === "skipped"
          ? `${week.displayLabel} is not played in this league.`
          : `${week.displayLabel} is ${week.status} and is not accepting picks.`,
    };
  }

  // SS0 lockPolicy "first_kickoff": ALL picks for the week lock at the earliest
  // kickoff, whether or not the picked team has played yet.
  if (config.lockPolicy === "first_kickoff" && week.lockAt && now.getTime() >= week.lockAt.getTime()) {
    return {
      ok: false,
      code: "week_locked",
      reason: `${week.displayLabel} locked at its first kickoff. Picks are final.`,
    };
  }

  const game = gameForTeam(games, teamId);
  if (!game) {
    // SS3: a team absent from the week's games is on bye, or is not in this
    // round of the postseason. Both are the same answer to the entrant.
    return {
      ok: false,
      code: "team_not_playing",
      reason: `That team is not playing in ${week.displayLabel}.`,
    };
  }

  if (config.lockPolicy === "per_game" && now.getTime() >= game.kickoffAt.getTime()) {
    return {
      ok: false,
      code: "game_kicked_off",
      reason: "That game has already kicked off.",
    };
  }

  // Everything below is informational. SS5.3: under teamReuse "unlimited" there
  // is no rejection for reusing a team, and none for putting two of your own
  // slots on the same team. Surface both, block neither.
  const info: ValidationInfo[] = [];
  const priorUses = input.priorUsesOfTeamByThisSlot ?? 0;

  if (config.teamReuse === "unlimited" && priorUses > 0) {
    info.push({
      code: "team_reused",
      message: `${pickSlot.label} has already used this team ${priorUses} time${priorUses === 1 ? "" : "s"} this season.`,
    });
  }

  if (input.otherSelectionsThisWeekForUser.some((selection) => selection.teamId === teamId)) {
    info.push({
      code: "same_team_as_another_slot",
      message: "Another of your picks is already on this team this week.",
    });
  }

  return { ok: true, info };
}
