import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createCollectingAuditRecorder } from "@/lib/audit/port";
import { DEFAULT_LEAGUE_CONFIG } from "@/lib/config";
import type { Database, DatabaseHandle } from "@/lib/db/client";
import { leagues, pickSlots, selections, weekStates, type GameRow, type TeamRow, type WeekStateRow } from "@/lib/db/schema";
import { submitAllocations, submitSelections } from "@/lib/picks/submit";

import { createTestDatabase, seedTeams, setupLeague } from "../helpers/db";
import { addEntrant, addSelection, AFTER_LOCK, BEFORE_LOCK, openWeekWithGames } from "./helpers";

/**
 * SS5.3 / SS9 -- submitting picks. NEVER TRUST THE CLIENT: everything here goes
 * through the same server-side validation regardless of what the UI allowed.
 */

let handle: DatabaseHandle;
let db: Database;
let recorder: ReturnType<typeof createCollectingAuditRecorder>;
let teamRows: TeamRow[];
let week: WeekStateRow;
let weekGames: GameRow[];

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  recorder = createCollectingAuditRecorder();
  await setupLeague(db);
  teamRows = await seedTeams(db);
  ({ week, weekGames } = await openWeekWithGames(db, teamRows));
});

afterEach(async () => {
  await handle.close();
});

describe("submitting picks", () => {
  it("saves a pick for each alive slot", async () => {
    const dana = await addEntrant(db, "dana", 2);

    const result = await submitSelections(
      db,
      {
        user: dana.user,
        now: BEFORE_LOCK,
        picks: [
          { slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id },
          { slotId: dana.slots[1]!.id, teamId: teamRows[2]!.id },
        ],
      },
      recorder,
    );

    expect(result).toMatchObject({ ok: true, saved: 2 });
    const rows = await db.select().from(selections);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.wasAutoAssigned === false)).toBe(true);
    expect(rows.every((row) => row.result === "pending")).toBe(true);
  });

  it("rejects a submission after lock, even though the client sent it", async () => {
    // Acceptance test 5.
    const dana = await addEntrant(db, "dana", 1);

    const result = await submitSelections(
      db,
      { user: dana.user, now: AFTER_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("week_locked");
    expect(await db.select().from(selections)).toHaveLength(0);
  });

  it("rejects a pick from an eliminated slot", async () => {
    // Acceptance test 6.
    const dana = await addEntrant(db, "dana", 1);
    await db
      .update(pickSlots)
      .set({
        status: "eliminated",
        eliminatedSeasonType: 2,
        eliminatedWeek: 3,
        eliminatedReason: "team_won",
        eliminatedAt: BEFORE_LOCK,
      })
      .where(eq(pickSlots.id, dana.slots[0]!.id));

    const result = await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("slot_eliminated");
  });

  it("rejects a user who has bought no picks", async () => {
    // Acceptance test 7's submit half.
    const sam = await addEntrant(db, "sam", 0);
    const dana = await addEntrant(db, "dana", 1);

    const result = await submitSelections(
      db,
      { user: sam.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Someone else's slot is refused as such, without confirming it exists.
    expect(result.errors[0]?.code).toBe("not_your_slot");
  });

  it("refuses to let one entrant submit for another's slot", async () => {
    const dana = await addEntrant(db, "dana", 1);
    const marcus = await addEntrant(db, "marcus", 1);

    const result = await submitSelections(
      db,
      { user: marcus.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("not_your_slot");
    expect(await db.select().from(selections)).toHaveLength(0);
  });

  it("rejects a team that is not playing this week", async () => {
    const dana = await addEntrant(db, "dana", 1);

    const result = await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[20]!.id }] },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("team_not_playing");
  });

  it("saves nothing at all when any pick in the form is invalid", async () => {
    // SS9 says save all slots in one submit; a partial save would leave the
    // entrant believing they had picked when they had not.
    const dana = await addEntrant(db, "dana", 2);

    const result = await submitSelections(
      db,
      {
        user: dana.user,
        now: BEFORE_LOCK,
        picks: [
          { slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }, // fine
          { slotId: dana.slots[1]!.id, teamId: teamRows[20]!.id }, // not playing
        ],
      },
      recorder,
    );

    expect(result.ok).toBe(false);
    expect(await db.select().from(selections)).toHaveLength(0);
    expect(recorder.events).toHaveLength(0);
  });
});

describe("what submitting must NOT block (SS5.3)", () => {
  it("allows two of a user's own slots on the same team", async () => {
    // Acceptance test 4.
    const dana = await addEntrant(db, "dana", 2);

    const result = await submitSelections(
      db,
      {
        user: dana.user,
        now: BEFORE_LOCK,
        picks: [
          { slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id },
          { slotId: dana.slots[1]!.id, teamId: teamRows[0]!.id },
        ],
      },
      recorder,
    );

    expect(result).toMatchObject({ ok: true, saved: 2 });
  });

  it("allows the same team again in a later week", async () => {
    // Acceptance test 3.
    const dana = await addEntrant(db, "dana", 1);
    const [previousWeek] = await db
      .select()
      .from(weekStates)
      .where(eq(weekStates.displayOrdinal, 4));
    await addSelection(db, {
      slotId: dana.slots[0]!.id,
      week: previousWeek!,
      teamId: teamRows[0]!.id,
      gameId: weekGames[0]!.id,
      userId: dana.user.id,
    });

    const result = await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );

    expect(result.ok).toBe(true);
  });
});

describe("editing a pick", () => {
  it("replaces the existing selection rather than adding one", async () => {
    const dana = await addEntrant(db, "dana", 1);
    await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );

    await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[2]!.id }] },
      recorder,
    );

    const rows = await db.select().from(selections);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.teamId).toBe(teamRows[2]!.id);
  });

  it("clears the auto-assigned flag when the entrant picks for themselves", async () => {
    const dana = await addEntrant(db, "dana", 1);
    await addSelection(db, {
      slotId: dana.slots[0]!.id,
      week,
      teamId: teamRows[0]!.id,
      gameId: weekGames[0]!.id,
      userId: dana.user.id,
      wasAutoAssigned: true,
    });

    await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[2]!.id }] },
      recorder,
    );

    const [row] = await db.select().from(selections);
    expect(row?.wasAutoAssigned).toBe(false);
  });
});

describe("the audit trail (SS7.1)", () => {
  it("records a submission with the team that was picked", async () => {
    const dana = await addEntrant(db, "dana", 1);

    await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );

    expect(recorder.events).toHaveLength(1);
    expect(recorder.events[0]).toMatchObject({
      action: "selection.submit",
      actorUserId: dana.user.id,
      actorRole: "player",
      targetType: "selection",
    });
    expect(recorder.events[0]?.afterJson).toMatchObject({ team: teamRows[0]!.abbreviation });
  });

  it("records an edit with the previous team in before_json", async () => {
    const dana = await addEntrant(db, "dana", 1);
    await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );
    recorder.events.length = 0;

    await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[2]!.id }] },
      recorder,
    );

    expect(recorder.events[0]).toMatchObject({ action: "selection.edit" });
    expect(recorder.events[0]?.beforeJson).toMatchObject({ team: teamRows[0]!.abbreviation });
    expect(recorder.events[0]?.afterJson).toMatchObject({ team: teamRows[2]!.abbreviation });
  });
});

describe("submitting an aggregate allocation (SS9)", () => {
  it("places several picks across several teams", async () => {
    // Five picks: 2 on team A, 1 on team C, 2 on team E.
    const dana = await addEntrant(db, "dana", 5);

    const result = await submitAllocations(
      db,
      {
        user: dana.user,
        now: BEFORE_LOCK,
        allocations: [
          { teamId: teamRows[0]!.id, count: 2 },
          { teamId: teamRows[2]!.id, count: 1 },
          { teamId: teamRows[4]!.id, count: 2 },
        ],
      },
      recorder,
    );

    expect(result).toMatchObject({ ok: true, saved: 5 });

    const rows = await db.select().from(selections);
    const counts = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.teamId] = (acc[row.teamId] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({
      [teamRows[0]!.id]: 2,
      [teamRows[2]!.id]: 1,
      [teamRows[4]!.id]: 2,
    });
    // Each pick landed on a distinct slot.
    expect(new Set(rows.map((row) => row.pickSlotId)).size).toBe(5);
  });

  it("refuses an allocation larger than the entrant's alive picks", async () => {
    const dana = await addEntrant(db, "dana", 2);

    const result = await submitAllocations(
      db,
      { user: dana.user, now: BEFORE_LOCK, allocations: [{ teamId: teamRows[0]!.id, count: 3 }] },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("too_many_picks");
    expect(await db.select().from(selections)).toHaveLength(0);
  });

  it("counts eliminated slots as unavailable", async () => {
    const dana = await addEntrant(db, "dana", 3);
    await db
      .update(pickSlots)
      .set({
        status: "eliminated",
        eliminatedSeasonType: 2,
        eliminatedWeek: 3,
        eliminatedReason: "team_won",
        eliminatedAt: BEFORE_LOCK,
      })
      .where(eq(pickSlots.id, dana.slots[2]!.id));

    const result = await submitAllocations(
      db,
      { user: dana.user, now: BEFORE_LOCK, allocations: [{ teamId: teamRows[0]!.id, count: 3 }] },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.reason).toContain("only have 2");
  });

  it("removes the surplus pick when a count is reduced", async () => {
    const dana = await addEntrant(db, "dana", 3);
    await submitAllocations(
      db,
      { user: dana.user, now: BEFORE_LOCK, allocations: [{ teamId: teamRows[0]!.id, count: 3 }] },
      recorder,
    );
    recorder.events.length = 0;

    await submitAllocations(
      db,
      { user: dana.user, now: BEFORE_LOCK, allocations: [{ teamId: teamRows[0]!.id, count: 1 }] },
      recorder,
    );

    const rows = await db.select().from(selections);
    expect(rows).toHaveLength(1);
    expect(recorder.events.filter((event) => event.action === "selection.clear")).toHaveLength(2);
  });

  it("leaves slot histories alone when the same allocation is resubmitted", async () => {
    // SS5.2 repeats the team on a given SLOT, so shuffling which slot holds
    // which team would quietly change what happens next week.
    const dana = await addEntrant(db, "dana", 3);
    const allocations = [
      { teamId: teamRows[0]!.id, count: 2 },
      { teamId: teamRows[2]!.id, count: 1 },
    ];

    await submitAllocations(db, { user: dana.user, now: BEFORE_LOCK, allocations }, recorder);
    const first = await db.select().from(selections).orderBy(selections.pickSlotId);
    recorder.events.length = 0;

    await submitAllocations(db, { user: dana.user, now: BEFORE_LOCK, allocations }, recorder);
    const second = await db.select().from(selections).orderBy(selections.pickSlotId);

    expect(second.map((row) => [row.pickSlotId, row.teamId])).toEqual(
      first.map((row) => [row.pickSlotId, row.teamId]),
    );
    // Nothing actually changed, so nothing is logged as changed.
    expect(recorder.events).toHaveLength(0);
  });

  it("still refuses a late allocation", async () => {
    // Acceptance test 5 holds for the aggregate path too.
    const dana = await addEntrant(db, "dana", 2);

    const result = await submitAllocations(
      db,
      { user: dana.user, now: AFTER_LOCK, allocations: [{ teamId: teamRows[0]!.id, count: 1 }] },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("week_locked");
  });

  it("still refuses a team that is not playing", async () => {
    const dana = await addEntrant(db, "dana", 2);

    const result = await submitAllocations(
      db,
      { user: dana.user, now: BEFORE_LOCK, allocations: [{ teamId: teamRows[20]!.id, count: 1 }] },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("team_not_playing");
  });

  it("cannot be aimed at another entrant's slots", async () => {
    // The request carries no slot id at all, so there is nothing to tamper
    // with: marcus's allocation can only ever land on marcus's own slots.
    const dana = await addEntrant(db, "dana", 2);
    const marcus = await addEntrant(db, "marcus", 1);

    await submitAllocations(
      db,
      { user: marcus.user, now: BEFORE_LOCK, allocations: [{ teamId: teamRows[0]!.id, count: 1 }] },
      recorder,
    );

    const rows = await db.select().from(selections);
    expect(rows).toHaveLength(1);
    expect(marcus.slots.map((slot) => slot.id)).toContain(rows[0]!.pickSlotId);
    expect(dana.slots.map((slot) => slot.id)).not.toContain(rows[0]!.pickSlotId);
  });
});

describe("backing both sides of one game, end to end", () => {
  it("refuses the allocation and names both teams", async () => {
    const dana = await addEntrant(db, "dana", 4);
    // weekGames[0] is teamRows[0] (home) vs teamRows[1] (away).
    const result = await submitAllocations(
      db,
      {
        user: dana.user,
        now: BEFORE_LOCK,
        allocations: [
          { teamId: teamRows[0]!.id, count: 2 },
          { teamId: teamRows[1]!.id, count: 1 },
        ],
      },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("both_sides_of_game");
    expect(result.errors[0]?.reason).toContain(teamRows[0]!.displayName);
    expect(result.errors[0]?.reason).toContain(teamRows[1]!.displayName);
    // Nothing partially applied.
    expect(await db.select().from(selections)).toHaveLength(0);
  });

  it("still allows stacking several picks on one team", async () => {
    const dana = await addEntrant(db, "dana", 4);

    const result = await submitAllocations(
      db,
      { user: dana.user, now: BEFORE_LOCK, allocations: [{ teamId: teamRows[0]!.id, count: 3 }] },
      recorder,
    );

    expect(result).toMatchObject({ ok: true, saved: 3 });
  });

  it("allows the hedge when the league config permits it", async () => {
    await db
      .update(leagues)
      .set({ config: { ...DEFAULT_LEAGUE_CONFIG, bothSidesOfGame: "allow" } });
    const dana = await addEntrant(db, "dana", 4);

    const result = await submitAllocations(
      db,
      {
        user: dana.user,
        now: BEFORE_LOCK,
        allocations: [
          { teamId: teamRows[0]!.id, count: 1 },
          { teamId: teamRows[1]!.id, count: 1 },
        ],
      },
      recorder,
    );

    expect(result).toMatchObject({ ok: true, saved: 2 });
  });
});
