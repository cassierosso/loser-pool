import { describe, expect, it } from "vitest";

import { validateSelection, type ValidateSelectionInput } from "@/lib/rules/validate";

import { config, game, selection, slot, week } from "../helpers/fixtures";

/**
 * SS5.3 -- validation. Acceptance tests 3, 4, 5, 6 and the submit half of 7.
 * Every one of these runs server-side on every submit, whatever the client did.
 */

const KICKOFF = new Date("2024-10-06T17:00:00Z");
const BEFORE = new Date("2024-10-06T16:00:00Z");
const AFTER = new Date("2024-10-06T17:00:01Z");

function input(overrides: Partial<ValidateSelectionInput> = {}): ValidateSelectionInput {
  const matchup = game("BUF", "MIA", { kickoffAt: KICKOFF });
  return {
    config: config(),
    week: week(5, { status: "open", lockAt: KICKOFF }),
    pickSlot: slot("slot-1", { userId: "user-1" }),
    requestingUserId: "user-1",
    user: { id: "user-1", picksPurchased: 10 },
    teamId: "MIA",
    games: [matchup],
    otherSelectionsThisWeekForUser: [],
    now: BEFORE,
    ...overrides,
  };
}

describe("validateSelection (SS5.3)", () => {
  it("accepts a normal pick before lock", () => {
    const result = validateSelection(input());
    expect(result.ok).toBe(true);
  });

  it("rejects a submission after lock_at, whatever the client allowed", () => {
    // Acceptance test 5.
    const result = validateSelection(input({ now: AFTER }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("week_locked");
  });

  it("rejects a submission from an eliminated slot", () => {
    // Acceptance test 6. Eliminations are permanent.
    const result = validateSelection(
      input({ pickSlot: slot("slot-1", { userId: "user-1", status: "eliminated" }) }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("slot_eliminated");
  });

  it("rejects a user who has bought no picks", () => {
    // Acceptance test 7's submit half: they can log in and look, not submit.
    const result = validateSelection(input({ user: { id: "user-1", picksPurchased: 0 } }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("no_picks_purchased");
  });

  it("rejects a slot belonging to someone else", () => {
    const result = validateSelection(input({ requestingUserId: "user-2" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_your_slot");
  });

  it("rejects a team that is not playing this week", () => {
    // On bye in the regular season, or out of the round in the postseason.
    const result = validateSelection(input({ teamId: "DAL" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("team_not_playing");
  });

  it("rejects a pick in a week that is not open", () => {
    for (const status of ["upcoming", "locked", "grading", "graded", "skipped"] as const) {
      const result = validateSelection(
        input({ week: week(5, { status, lockAt: KICKOFF }) }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("week_not_open");
    }
  });
});

describe("what validation must NOT block (SS5.3)", () => {
  it("allows the same team in consecutive weeks", () => {
    // Acceptance test 3. Under teamReuse "unlimited" this is informational.
    const result = validateSelection(input({ priorUsesOfTeamByThisSlot: 3 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.map((entry) => entry.code)).toEqual(["team_reused"]);
    expect(result.info[0]?.message).toContain("3 times");
  });

  it("allows two of a user's own slots on the same team in one week", () => {
    // Acceptance test 4.
    const matchup = game("BUF", "MIA", { kickoffAt: KICKOFF });
    const result = validateSelection(
      input({
        games: [matchup],
        otherSelectionsThisWeekForUser: [selection("slot-2", "MIA", matchup.id)],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.map((entry) => entry.code)).toEqual(["same_team_as_another_slot"]);
  });

  it("reports both badges at once without blocking", () => {
    const matchup = game("BUF", "MIA", { kickoffAt: KICKOFF });
    const result = validateSelection(
      input({
        games: [matchup],
        priorUsesOfTeamByThisSlot: 1,
        otherSelectionsThisWeekForUser: [selection("slot-2", "MIA", matchup.id)],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.info.map((entry) => entry.code)).toEqual([
      "team_reused",
      "same_team_as_another_slot",
    ]);
  });
});

describe("lockPolicy: per_game (SS5.3)", () => {
  const perGame = config({ lockPolicy: "per_game" });

  it("rejects a pick on a game that has already kicked off", () => {
    const result = validateSelection(
      input({ config: perGame, week: week(5, { status: "open", lockAt: KICKOFF }), now: AFTER }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("game_kicked_off");
  });

  it("still allows a pick on a later game after the week's first kickoff", () => {
    // The whole point of per_game: the week is not shut by its first kickoff.
    const later = game("SF", "SEA", { kickoffAt: new Date("2024-10-06T20:25:00Z") });

    const result = validateSelection(
      input({
        config: perGame,
        week: week(5, { status: "open", lockAt: KICKOFF }),
        games: [later],
        teamId: "SEA",
        now: AFTER,
      }),
    );

    expect(result.ok).toBe(true);
  });
});
