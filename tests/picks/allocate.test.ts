import { describe, expect, it } from "vitest";

import { allocateSlots, findBothSidesConflicts, type Allocation } from "@/lib/picks/allocate";
import type { PickSlotRow } from "@/lib/db/schema";

/**
 * Mapping an aggregate allocation onto slots. Pure, so no database here.
 */

function slot(slotNumber: number): PickSlotRow {
  return {
    id: `slot-${slotNumber}`,
    userId: "user-1",
    slotNumber,
    label: `Pick ${slotNumber}`,
    status: "alive",
    eliminatedSeasonType: null,
    eliminatedWeek: null,
    eliminatedReason: null,
    eliminatedAt: null,
    createdAt: new Date(),
  };
}

const five = [slot(1), slot(2), slot(3), slot(4), slot(5)];

function allocate(allocations: Allocation[], existing: Record<string, string> = {}) {
  const outcome = allocateSlots({
    aliveSlots: five,
    existingBySlotId: existing,
    allocations,
  });
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.result;
}

describe("allocating picks across teams", () => {
  it("spreads a mixed allocation across slots", () => {
    // The spec-by-example: five picks, 2 on Dallas, 1 on Tampa Bay, 2 on Arizona.
    const result = allocate([
      { teamId: "DAL", count: 2 },
      { teamId: "TB", count: 1 },
      { teamId: "ARI", count: 2 },
    ]);

    expect(result.assignments).toHaveLength(5);
    const counts = result.assignments.reduce<Record<string, number>>((acc, a) => {
      acc[a.teamId] = (acc[a.teamId] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ DAL: 2, TB: 1, ARI: 2 });
    // Every slot used exactly once.
    expect(new Set(result.assignments.map((a) => a.slotId)).size).toBe(5);
  });

  it("leaves spare slots unassigned when fewer picks are allocated", () => {
    const result = allocate([{ teamId: "DAL", count: 2 }]);

    expect(result.assignments).toHaveLength(2);
    expect(result.cleared).toEqual([]);
  });

  it("refuses to allocate more picks than the entrant has alive", () => {
    const outcome = allocateSlots({
      aliveSlots: five,
      existingBySlotId: {},
      allocations: [{ teamId: "DAL", count: 6 }],
    });

    expect(outcome).toMatchObject({ ok: false, code: "too_many_picks" });
    if (outcome.ok) return;
    expect(outcome.message).toContain("only have 5");
  });

  it("counts allocations across teams toward the same limit", () => {
    const outcome = allocateSlots({
      aliveSlots: five,
      existingBySlotId: {},
      allocations: [
        { teamId: "DAL", count: 3 },
        { teamId: "TB", count: 3 },
      ],
    });

    expect(outcome).toMatchObject({ ok: false, code: "too_many_picks" });
  });

  it("rejects a negative count", () => {
    const outcome = allocateSlots({
      aliveSlots: five,
      existingBySlotId: {},
      allocations: [{ teamId: "DAL", count: -1 }],
    });
    expect(outcome).toMatchObject({ ok: false, code: "negative_count" });
  });

  it("is deterministic regardless of the order teams arrive in", () => {
    const forwards = allocate([
      { teamId: "DAL", count: 2 },
      { teamId: "ARI", count: 1 },
    ]);
    const backwards = allocate([
      { teamId: "ARI", count: 1 },
      { teamId: "DAL", count: 2 },
    ]);

    expect(forwards.assignments).toEqual(backwards.assignments);
  });
});

describe("keeping slot histories stable", () => {
  it("leaves an existing pick exactly where it is", () => {
    // Pick 3 is already on Dallas; re-allocating Dallas must not move it, or
    // SS5.2's repeat-last-week would follow a different slot next week.
    const existing = { "slot-3": "DAL" };
    const result = allocate([{ teamId: "DAL", count: 1 }], existing);

    expect(result.assignments).toEqual([{ slotId: "slot-3", teamId: "DAL" }]);
    expect(result.cleared).toEqual([]);
  });

  it("changes nothing at all when the same allocation is submitted twice", () => {
    const first = allocate([
      { teamId: "DAL", count: 2 },
      { teamId: "TB", count: 1 },
    ]);
    const existing = Object.fromEntries(
      first.assignments.map((a) => [a.slotId, a.teamId]),
    );

    const second = allocate(
      [
        { teamId: "DAL", count: 2 },
        { teamId: "TB", count: 1 },
      ],
      existing,
    );

    expect([...second.assignments].sort((a, b) => a.slotId.localeCompare(b.slotId))).toEqual(
      [...first.assignments].sort((a, b) => a.slotId.localeCompare(b.slotId)),
    );
    expect(second.cleared).toEqual([]);
  });

  it("keeps one and clears the other when a count is reduced", () => {
    const existing = { "slot-1": "DAL", "slot-2": "DAL" };
    const result = allocate([{ teamId: "DAL", count: 1 }], existing);

    expect(result.assignments).toEqual([{ slotId: "slot-1", teamId: "DAL" }]);
    expect(result.cleared).toEqual(["slot-2"]);
  });

  it("adds to an existing team without disturbing what is there", () => {
    const existing = { "slot-2": "DAL" };
    const result = allocate([{ teamId: "DAL", count: 3 }], existing);

    expect(result.assignments).toContainEqual({ slotId: "slot-2", teamId: "DAL" });
    expect(result.assignments).toHaveLength(3);
    expect(result.cleared).toEqual([]);
  });

  it("clears a team that has been dropped entirely", () => {
    const existing = { "slot-1": "DAL", "slot-2": "TB" };
    const result = allocate([{ teamId: "DAL", count: 1 }], existing);

    expect(result.assignments).toEqual([{ slotId: "slot-1", teamId: "DAL" }]);
    expect(result.cleared).toEqual(["slot-2"]);
  });

  it("reuses a slot freed by a dropped team rather than growing the total", () => {
    const existing = { "slot-1": "TB" };
    const result = allocate([{ teamId: "DAL", count: 1 }], existing);

    expect(result.assignments).toEqual([{ slotId: "slot-1", teamId: "DAL" }]);
    expect(result.cleared).toEqual([]);
  });
});

describe("finding both-sides conflicts", () => {
  const games = [
    { id: "g1", homeTeamId: "DAL", awayTeamId: "NYG" },
    { id: "g2", homeTeamId: "TB", awayTeamId: "ARI" },
  ];

  it("spots an allocation that backs both teams in one game", () => {
    const conflicts = findBothSidesConflicts({
      allocations: [
        { teamId: "DAL", count: 2 },
        { teamId: "NYG", count: 1 },
      ],
      games,
    });

    expect(conflicts).toEqual([{ gameId: "g1", homeTeamId: "DAL", awayTeamId: "NYG" }]);
  });

  it("is happy with picks spread across different games", () => {
    const conflicts = findBothSidesConflicts({
      allocations: [
        { teamId: "DAL", count: 2 },
        { teamId: "ARI", count: 2 },
      ],
      games,
    });

    expect(conflicts).toEqual([]);
  });

  it("ignores a team allocated zero picks", () => {
    const conflicts = findBothSidesConflicts({
      allocations: [
        { teamId: "DAL", count: 2 },
        { teamId: "NYG", count: 0 },
      ],
      games,
    });

    expect(conflicts).toEqual([]);
  });

  it("reports every clashing game", () => {
    const conflicts = findBothSidesConflicts({
      allocations: [
        { teamId: "DAL", count: 1 },
        { teamId: "NYG", count: 1 },
        { teamId: "TB", count: 1 },
        { teamId: "ARI", count: 1 },
      ],
      games,
    });

    expect(conflicts).toHaveLength(2);
  });
});
