import { describe, expect, it } from "vitest";

import { gradeWeek, type GradeWeekInput } from "@/lib/rules/grade";
import type { RuleSelection } from "@/lib/rules/types";

import { config, finalGame, game, selection, slot } from "../helpers/fixtures";

/**
 * SS5.1 -- grading. Acceptance tests 1, 2, 14, 15 and 16.
 */

describe("gradeWeek (SS5.1)", () => {
  it("survives a pick on the team that lost, eliminates a pick on the team that won", () => {
    // Acceptance test 1.
    const played = finalGame("BUF", "MIA", "BUF");
    const loser = selection("slot-1", "MIA", played.id);
    const winner = selection("slot-2", "BUF", played.id);

    const result = gradeWeek({
      config: config(),
      seasonType: 2,
      weekNumber: 5,
      games: [played],
      selections: [loser, winner],
      aliveSlots: [slot("slot-1"), slot("slot-2")],
    });

    expect(result.canGrade).toBe(true);
    expect(result.selectionResults).toEqual([
      { selectionId: loser.id, pickSlotId: "slot-1", from: "pending", to: "survived" },
      {
        selectionId: winner.id,
        pickSlotId: "slot-2",
        from: "pending",
        to: "eliminated",
        eliminationReason: "team_won",
      },
    ]);
    expect(result.slotUpdates).toEqual([
      { slotId: "slot-2", status: "eliminated", reason: "team_won", seasonType: 2, weekNumber: 5 },
    ]);
  });

  it("eliminates every pick on BOTH teams when the game ties", () => {
    // Acceptance test 2 -- the rule most likely to be got wrong, and the one
    // the UI has to keep repeating to entrants.
    const tied = finalGame("DEN", "LAC", null);

    const result = gradeWeek({
      config: config(),
      seasonType: 2,
      weekNumber: 7,
      games: [tied],
      selections: [selection("slot-1", "DEN", tied.id), selection("slot-2", "LAC", tied.id)],
      aliveSlots: [slot("slot-1"), slot("slot-2")],
    });

    expect(result.selectionResults.map((r) => [r.pickSlotId, r.to, r.eliminationReason])).toEqual([
      ["slot-1", "eliminated", "tie"],
      ["slot-2", "eliminated", "tie"],
    ]);
    expect(result.slotUpdates.map((s) => s.reason)).toEqual(["tie", "tie"]);
  });

  it("voids selections on a canceled game without eliminating anyone", () => {
    // Acceptance test 16.
    const canceled = game("NYJ", "NE", { status: "canceled" });

    const result = gradeWeek({
      config: config(),
      seasonType: 2,
      weekNumber: 9,
      games: [canceled],
      selections: [selection("slot-1", "NYJ", canceled.id)],
      aliveSlots: [slot("slot-1")],
    });

    expect(result.canGrade).toBe(true);
    expect(result.selectionResults[0]).toMatchObject({ to: "void" });
    expect(result.slotUpdates).toEqual([]);
  });

  it("refuses to grade a week containing a postponed game", () => {
    // Acceptance test 15: the selections stay pending and the week does not
    // grade at all -- a week is graded whole or not at all.
    const postponed = game("CHI", "GB", { status: "postponed" });
    const finished = finalGame("SF", "SEA", "SF");
    const onPostponed = selection("slot-1", "CHI", postponed.id);
    const onFinished = selection("slot-2", "SF", finished.id);

    const result = gradeWeek({
      config: config(),
      seasonType: 2,
      weekNumber: 11,
      games: [postponed, finished],
      selections: [onPostponed, onFinished],
      aliveSlots: [slot("slot-1"), slot("slot-2")],
    });

    expect(result.canGrade).toBe(false);
    expect(result.blockedBy).toEqual([postponed.id]);
    expect(result.selectionResults).toEqual([]);
    expect(result.slotUpdates).toEqual([]);
    // Nothing was graded, so the pick on the winning team is not yet dead.
    expect(onFinished.result).toBe("pending");
  });

  it("grades a week whose only unplayed game was canceled", () => {
    const canceled = game("NYJ", "NE", { status: "canceled" });
    const finished = finalGame("SF", "SEA", "SF");

    const result = gradeWeek({
      config: config(),
      seasonType: 2,
      weekNumber: 11,
      games: [canceled, finished],
      selections: [selection("slot-1", "SEA", finished.id)],
      aliveSlots: [slot("slot-1")],
    });

    expect(result.canGrade).toBe(true);
    expect(result.selectionResults[0]).toMatchObject({ to: "survived" });
  });

  it("produces no changes at all on a second run", () => {
    // Acceptance test 14 / SS8: gradeWeek must be safe to run twice.
    const played = finalGame("BUF", "MIA", "BUF");
    const tied = finalGame("DEN", "LAC", null);
    const canceled = game("NYJ", "NE", { status: "canceled" });

    const selections: RuleSelection[] = [
      selection("slot-1", "MIA", played.id),
      selection("slot-2", "BUF", played.id),
      selection("slot-3", "DEN", tied.id),
      selection("slot-4", "NYJ", canceled.id),
    ];
    const input: GradeWeekInput = {
      config: config(),
      seasonType: 2,
      weekNumber: 5,
      games: [played, tied, canceled],
      selections,
      aliveSlots: ["slot-1", "slot-2", "slot-3", "slot-4"].map((id) => slot(id)),
    };

    const first = gradeWeek(input);
    // slot-1 survived, slot-2 lost to a win, slot-3 lost to the tie, slot-4 voided.
    expect(first.selectionResults).toHaveLength(4);
    expect(first.slotUpdates.map((update) => update.slotId)).toEqual(["slot-2", "slot-3"]);
    expect(first.auditEntries).toHaveLength(1);

    // Apply the first run's output, exactly as the job would.
    const eliminated = new Set(first.slotUpdates.map((update) => update.slotId));
    const second = gradeWeek({
      ...input,
      selections: selections.map((candidate) => {
        const update = first.selectionResults.find((r) => r.selectionId === candidate.id);
        return update ? { ...candidate, result: update.to } : candidate;
      }),
      aliveSlots: input.aliveSlots.filter((candidate) => !eliminated.has(candidate.id)),
    });

    expect(second.selectionResults).toEqual([]);
    expect(second.slotUpdates).toEqual([]);
    expect(second.auditEntries).toEqual([]);
  });

  it("kills a slot only once even if it somehow holds two selections in a week", () => {
    // The unique constraint makes this unreachable through the app; the engine
    // still must not emit two eliminations for one slot.
    const played = finalGame("BUF", "MIA", "BUF");

    const result = gradeWeek({
      config: config(),
      seasonType: 2,
      weekNumber: 5,
      games: [played],
      selections: [
        selection("slot-1", "BUF", played.id, { id: "a" }),
        selection("slot-1", "BUF", played.id, { id: "b" }),
      ],
      aliveSlots: [slot("slot-1")],
    });

    expect(result.slotUpdates).toHaveLength(1);
  });
});
