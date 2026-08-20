import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { Database, DatabaseHandle } from "@/lib/db/client";
import { getMakePicksData } from "@/lib/picks/queries";
import { pickSlots, weekStates, type GameRow, type TeamRow, type WeekStateRow } from "@/lib/db/schema";

import { createTestDatabase, seedTeams, setupLeague } from "../helpers/db";
import { addEntrant, addSelection, openWeekWithGames } from "./helpers";

/**
 * SS9 -- the Make Picks payload.
 */

let handle: DatabaseHandle;
let db: Database;
let teamRows: TeamRow[];
let week: WeekStateRow;
let weekGames: GameRow[];

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  await setupLeague(db);
  teamRows = await seedTeams(db);
  ({ week, weekGames } = await openWeekWithGames(db, teamRows));
});

afterEach(async () => {
  await handle.close();
});

describe("what the screen loads", () => {
  it("never loads another entrant's selections", async () => {
    // Groundwork for acceptance test 22: other entrants' picks must be ABSENT
    // from the payload, not merely undrawn. The way to guarantee that is to
    // never fetch them, so this asserts on the whole serialised response.
    const dana = await addEntrant(db, "dana", 1);
    const marcus = await addEntrant(db, "marcus", 1);

    await addSelection(db, {
      slotId: dana.slots[0]!.id,
      week,
      teamId: teamRows[0]!.id,
      gameId: weekGames[0]!.id,
      userId: dana.user.id,
    });
    await addSelection(db, {
      slotId: marcus.slots[0]!.id,
      week,
      teamId: teamRows[2]!.id,
      gameId: weekGames[1]!.id,
      userId: marcus.user.id,
    });

    const data = await getMakePicksData(db, dana.user);
    const serialised = JSON.stringify(data);

    expect(Object.keys(data.selectionBySlotId)).toEqual([dana.slots[0]!.id]);
    expect(serialised).not.toContain(marcus.slots[0]!.id);
    expect(serialised).not.toContain(marcus.user.id);
  });

  it("shows only alive slots for picking, and lists eliminated ones separately", async () => {
    const dana = await addEntrant(db, "dana", 3);
    await db
      .update(pickSlots)
      .set({
        status: "eliminated",
        eliminatedSeasonType: 2,
        eliminatedWeek: 3,
        eliminatedReason: "tie",
        eliminatedAt: new Date(),
      })
      .where(eq(pickSlots.id, dana.slots[1]!.id));

    const data = await getMakePicksData(db, dana.user);

    expect(data.slots.map((slot) => slot.label)).toEqual(["Pick 1", "Pick 3"]);
    expect(data.eliminatedSlots.map((slot) => slot.label)).toEqual(["Pick 2"]);
  });

  it("counts how many times each slot has used each team", async () => {
    // SS9's informational badge. Never a block under teamReuse "unlimited".
    const dana = await addEntrant(db, "dana", 1);
    const [weekFour] = await db.select().from(weekStates).where(eq(weekStates.displayOrdinal, 4));
    const [weekThree] = await db.select().from(weekStates).where(eq(weekStates.displayOrdinal, 3));

    await addSelection(db, {
      slotId: dana.slots[0]!.id,
      week: weekFour!,
      teamId: teamRows[0]!.id,
      gameId: weekGames[0]!.id,
      userId: dana.user.id,
    });
    await addSelection(db, {
      slotId: dana.slots[0]!.id,
      week: weekThree!,
      teamId: teamRows[0]!.id,
      gameId: weekGames[0]!.id,
      userId: dana.user.id,
    });

    const data = await getMakePicksData(db, dana.user);
    expect(data.teamUsesBySlot[dana.slots[0]!.id]?.[teamRows[0]!.id]).toBe(2);
  });

  it("offers only teams that are playing this week", async () => {
    const dana = await addEntrant(db, "dana", 1);
    const data = await getMakePicksData(db, dana.user);

    const offered = new Set(data.matchups.flatMap((m) => [m.home.id, m.away.id]));
    expect(offered.size).toBe(6);
    // A team on bye simply is not among the matchups, so it cannot be chosen.
    expect(offered.has(teamRows[20]!.id)).toBe(false);
  });
});

describe("the auto-assignment preview (SS9)", () => {
  it("says which team would be repeated when the entrant submits nothing", async () => {
    const dana = await addEntrant(db, "dana", 1);
    const [weekFour] = await db.select().from(weekStates).where(eq(weekStates.displayOrdinal, 4));
    await db.update(weekStates).set({ status: "graded" }).where(eq(weekStates.id, weekFour!.id));

    await addSelection(db, {
      slotId: dana.slots[0]!.id,
      week: weekFour!,
      teamId: teamRows[0]!.id, // playing again this week
      gameId: weekGames[0]!.id,
      userId: dana.user.id,
    });

    const data = await getMakePicksData(db, dana.user);
    const preview = data.autoAssignPreview[dana.slots[0]!.id];

    expect(preview).toMatchObject({ resolution: "repeat_last_week", teamId: teamRows[0]!.id });
    expect(preview?.explanation).toContain("repeat");
  });

  it("warns that a slot with nothing to repeat would be eliminated", async () => {
    // The default missedPickFallback. This is the warning that matters most on
    // the screen, so the preview must state it plainly.
    const dana = await addEntrant(db, "dana", 1);

    const data = await getMakePicksData(db, dana.user);
    const preview = data.autoAssignPreview[dana.slots[0]!.id];

    expect(preview).toMatchObject({ resolution: "eliminate", teamId: null });
    expect(preview?.explanation).toContain("ELIMINATED");
  });
});

describe("when there is nothing to do", () => {
  it("returns no week when none is open", async () => {
    await db.update(weekStates).set({ status: "upcoming" }).where(eq(weekStates.status, "open"));
    const dana = await addEntrant(db, "dana", 1);

    const data = await getMakePicksData(db, dana.user);
    expect(data.week).toBeNull();
    expect(data.matchups).toEqual([]);
  });

  it("gives a user with no picks no slots at all", async () => {
    const sam = await addEntrant(db, "sam", 0);
    const data = await getMakePicksData(db, sam.user);

    expect(data.slots).toEqual([]);
    expect(data.autoAssignPreview).toEqual({});
  });
});
