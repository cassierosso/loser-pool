import { describe, expect, it } from "vitest";

import { autoAssignWeek, leastLikelyToWin, previousPlayedSelection } from "@/lib/rules/auto-assign";

import { config, game, priorSelection, selection, slot, week, weeks } from "../helpers/fixtures";

/**
 * SS5.2 -- missed-pick auto-assignment. Acceptance tests 10, 11, 12, 13,
 * and the SS2.1/SS3.1 lookup behaviour behind 20 and 21.
 */

const playedThrough = (ordinal: number) =>
  Object.fromEntries(
    Array.from({ length: ordinal }, (_, index) => [index + 1, "graded" as const]),
  );

describe("repeat last week's team (SS5.2 step 1)", () => {
  it("repeats the previous week's team when that team is playing", () => {
    // Acceptance test 10: missed pick in Week 5 repeats the Week 4 team.
    const thisWeek = game("BUF", "MIA");
    const other = game("SF", "SEA");

    const result = autoAssignWeek({
      config: config(),
      week: week(5, { status: "locked" }),
      weeks: weeks(playedThrough(4)),
      games: [thisWeek, other],
      aliveSlots: [slot("slot-1")],
      selectionsThisWeek: [],
      priorSelections: [priorSelection("slot-1", "MIA", 4)],
    });

    expect(result.assignments).toEqual([
      { slotId: "slot-1", teamId: "MIA", gameId: thisWeek.id, resolution: "repeat_last_week" },
    ]);
    expect(result.eliminations).toEqual([]);
    expect(result.auditEntries).toHaveLength(1);
    expect(result.auditEntries[0]?.action).toBe("selection.auto_assigned");
  });

  it("leaves slots that already submitted alone", () => {
    const thisWeek = game("BUF", "MIA");

    const result = autoAssignWeek({
      config: config(),
      week: week(5, { status: "locked" }),
      weeks: weeks(playedThrough(4)),
      games: [thisWeek],
      aliveSlots: [slot("slot-1"), slot("slot-2")],
      selectionsThisWeek: [selection("slot-1", "BUF", thisWeek.id)],
      priorSelections: [priorSelection("slot-1", "MIA", 4), priorSelection("slot-2", "MIA", 4)],
    });

    expect(result.assignments.map((a) => a.slotId)).toEqual(["slot-2"]);
  });

  it("skips a week whose selection was voided by a canceled game", () => {
    // A voided pick is not a decision anyone made, so it is not the pick to
    // repeat -- the engine reaches further back for a real one.
    const thisWeek = game("BUF", "MIA");

    const result = autoAssignWeek({
      config: config(),
      week: week(6, { status: "locked" }),
      weeks: weeks(playedThrough(5)),
      games: [thisWeek],
      aliveSlots: [slot("slot-1")],
      selectionsThisWeek: [],
      priorSelections: [
        priorSelection("slot-1", "MIA", 4),
        priorSelection("slot-1", "NYJ", 5, { result: "void" }),
      ],
    });

    expect(result.assignments[0]?.teamId).toBe("MIA");
  });
});

describe("the fallback (SS5.2 step 2)", () => {
  it("falls back in Week 1, where nothing precedes", () => {
    // Acceptance test 11.
    const result = autoAssignWeek({
      config: config({ missedPickFallback: "eliminate" }),
      week: week(1, { status: "locked" }),
      weeks: weeks(),
      games: [game("BUF", "MIA")],
      aliveSlots: [slot("slot-1")],
      selectionsThisWeek: [],
      priorSelections: [],
    });

    expect(result.assignments).toEqual([]);
    expect(result.eliminations).toEqual([{ slotId: "slot-1", reason: "no_submission" }]);
  });

  it("falls back when the prior team is on bye", () => {
    // Acceptance test 12: MIA does not appear in this week's games at all.
    const result = autoAssignWeek({
      config: config({ missedPickFallback: "eliminate" }),
      week: week(9, { status: "locked" }),
      weeks: weeks(playedThrough(8)),
      games: [game("BUF", "NYJ"), game("SF", "SEA")],
      aliveSlots: [slot("slot-1")],
      selectionsThisWeek: [],
      priorSelections: [priorSelection("slot-1", "MIA", 8)],
    });

    expect(result.eliminations).toEqual([{ slotId: "slot-1", reason: "no_submission" }]);
  });

  it("falls back in the Wild Card round when the prior team missed the playoffs", () => {
    // Acceptance test 13. This is the common postseason case, not an edge case:
    // most of the league is not in the round.
    const result = autoAssignWeek({
      config: config({ missedPickFallback: "eliminate" }),
      week: week(19, { status: "locked" }),
      weeks: weeks(playedThrough(18)),
      games: [game("BUF", "MIA"), game("KC", "PIT")],
      aliveSlots: [slot("slot-1")],
      selectionsThisWeek: [],
      priorSelections: [priorSelection("slot-1", "CAR", 18)],
    });

    expect(result.assignments).toEqual([]);
    expect(result.eliminations).toEqual([{ slotId: "slot-1", reason: "no_submission" }]);
    expect(result.auditEntries[0]?.afterJson).toMatchObject({ resolution: "eliminate" });
  });

  it("advances the slot with no selection under missedPickFallback: survive", () => {
    const result = autoAssignWeek({
      config: config({ missedPickFallback: "survive" }),
      week: week(1, { status: "locked" }),
      weeks: weeks(),
      games: [game("BUF", "MIA")],
      aliveSlots: [slot("slot-1")],
      selectionsThisWeek: [],
      priorSelections: [],
    });

    expect(result.eliminations).toEqual([]);
    expect(result.assignments).toEqual([]);
    expect(result.survivedWithoutSelection).toEqual(["slot-1"]);
  });

  it("assigns the worst record under missedPickFallback: auto_underdog", () => {
    const underdogGame = game("CAR", "NYG");
    const result = autoAssignWeek({
      config: config({ missedPickFallback: "auto_underdog" }),
      week: week(1, { status: "locked" }),
      weeks: weeks(),
      games: [game("BUF", "MIA"), underdogGame],
      aliveSlots: [slot("slot-1")],
      selectionsThisWeek: [],
      priorSelections: [],
      standings: [
        { teamId: "BUF", wins: 5, losses: 0, ties: 0 },
        { teamId: "MIA", wins: 3, losses: 2, ties: 0 },
        { teamId: "NYG", wins: 2, losses: 3, ties: 0 },
        { teamId: "CAR", wins: 0, losses: 5, ties: 0 },
      ],
    });

    expect(result.assignments).toEqual([
      { slotId: "slot-1", teamId: "CAR", gameId: underdogGame.id, resolution: "auto_underdog" },
    ]);
  });

  it("refuses to guess an underdog with no standings supplied", () => {
    expect(() =>
      autoAssignWeek({
        config: config({ missedPickFallback: "auto_underdog" }),
        week: week(1, { status: "locked" }),
        weeks: weeks(),
        games: [game("BUF", "MIA")],
        aliveSlots: [slot("slot-1")],
        selectionsThisWeek: [],
        priorSelections: [],
      }),
    ).toThrow(/standings/);
  });

  it("picks the underdog deterministically when records are level", () => {
    const only = game("ARI", "ATL");
    const pick = leastLikelyToWin(
      [only],
      [
        { teamId: "ATL", wins: 1, losses: 4, ties: 0 },
        { teamId: "ARI", wins: 1, losses: 4, ties: 0 },
      ],
    );
    expect(pick).toBe("ARI");
  });
});

describe("finding the previous played week (SS2.1, SS3.1)", () => {
  it("crosses the season-type boundary to Week 18, not postseason week 0", () => {
    // Acceptance test 21.
    const found = previousPlayedSelection(
      "slot-1",
      week(19),
      weeks(playedThrough(18)),
      [priorSelection("slot-1", "DAL", 18)],
    );

    expect(found?.teamId).toBe("DAL");
    expect(found?.weekDisplayOrdinal).toBe(18);
  });

  it("steps over the Pro Bowl week", () => {
    // Acceptance test 20: the Super Bowl's previous played week is the
    // Conference Championship at ordinal 21, never the all-star game at 22.
    const found = previousPlayedSelection(
      "slot-1",
      week(23),
      weeks({ ...playedThrough(21) }),
      [priorSelection("slot-1", "KC", 21)],
    );

    expect(found?.weekDisplayOrdinal).toBe(21);
  });

  it("never repeats a Pro Bowl selection even if one somehow exists", () => {
    const found = previousPlayedSelection(
      "slot-1",
      week(23),
      weeks(playedThrough(21)),
      [priorSelection("slot-1", "KC", 21), priorSelection("slot-1", "NFC", 22)],
    );

    expect(found?.weekDisplayOrdinal).toBe(21);
  });

  it("returns null when the slot has no prior selection at all", () => {
    expect(previousPlayedSelection("slot-1", week(1), weeks(), [])).toBeNull();
  });
});
