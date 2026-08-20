import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { Database, DatabaseHandle } from "@/lib/db/client";
import { games, pickSlots, type GameRow, type TeamRow, type WeekStateRow } from "@/lib/db/schema";
import { getMyPicksHistory } from "@/lib/views/history";

import { createTestDatabase, seedTeams, setupLeague } from "../helpers/db";
import { addEntrant, addSelection, openWeekWithGames } from "../picks/helpers";

/**
 * SS9 -- My Picks History.
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

describe("the season trail", () => {
  it("writes the score from the picked team's point of view", async () => {
    // In this league losing is the good outcome, so "17-24" has to mean the
    // pick's team scored 17 and survived. Getting this backwards would tell
    // people they had won when they were out.
    const dana = await addEntrant(db, "dana", 1);
    await db
      .update(games)
      .set({ status: "final", homeScore: 17, awayScore: 24, winnerTeamId: teamRows[1]!.id })
      .where(eq(games.id, weekGames[0]!.id));

    await addSelection(db, {
      slotId: dana.slots[0]!.id,
      week,
      teamId: teamRows[0]!.id, // the home team, which scored 17 and lost
      gameId: weekGames[0]!.id,
      userId: dana.user.id,
    });

    const history = await getMyPicksHistory(db, dana.user.id);
    const entry = history.slots[0]!.entries[0]!;

    expect(entry.scoreLine).toBe("17-24");
    expect(entry.teamAbbreviation).toBe(teamRows[0]!.abbreviation);
    expect(entry.opponentAbbreviation).toBe(teamRows[1]!.abbreviation);
  });

  it("flips the score line for a pick on the away team", async () => {
    const dana = await addEntrant(db, "dana", 1);
    await db
      .update(games)
      .set({ status: "final", homeScore: 17, awayScore: 24, winnerTeamId: teamRows[1]!.id })
      .where(eq(games.id, weekGames[0]!.id));

    await addSelection(db, {
      slotId: dana.slots[0]!.id,
      week,
      teamId: teamRows[1]!.id, // the away team, which scored 24 and won
      gameId: weekGames[0]!.id,
      userId: dana.user.id,
    });

    const entry = (await getMyPicksHistory(db, dana.user.id)).slots[0]!.entries[0]!;
    expect(entry.scoreLine).toBe("24-17");
  });

  it("leaves the score line empty before a game is played", async () => {
    const dana = await addEntrant(db, "dana", 1);
    await addSelection(db, {
      slotId: dana.slots[0]!.id,
      week,
      teamId: teamRows[0]!.id,
      gameId: weekGames[0]!.id,
      userId: dana.user.id,
    });

    const entry = (await getMyPicksHistory(db, dana.user.id)).slots[0]!.entries[0]!;
    expect(entry.scoreLine).toBeNull();
    expect(entry.result).toBe("pending");
  });

  it("keeps every slot, including ones that never picked", async () => {
    const dana = await addEntrant(db, "dana", 3);
    await addSelection(db, {
      slotId: dana.slots[0]!.id,
      week,
      teamId: teamRows[0]!.id,
      gameId: weekGames[0]!.id,
      userId: dana.user.id,
    });

    const history = await getMyPicksHistory(db, dana.user.id);

    expect(history.slots.map((entry) => entry.slot.label)).toEqual(["Pick 1", "Pick 2", "Pick 3"]);
    expect(history.slots[1]!.entries).toEqual([]);
    expect(history.aliveCount).toBe(3);
  });

  it("reports an eliminated slot with its reason", async () => {
    const dana = await addEntrant(db, "dana", 1);
    await db
      .update(pickSlots)
      .set({
        status: "eliminated",
        eliminatedSeasonType: 2,
        eliminatedWeek: 3,
        eliminatedReason: "tie",
        eliminatedAt: new Date(),
      })
      .where(eq(pickSlots.id, dana.slots[0]!.id));

    const history = await getMyPicksHistory(db, dana.user.id);

    expect(history.slots[0]!.slot.eliminatedReason).toBe("tie");
    expect(history.aliveCount).toBe(0);
    expect(history.eliminatedCount).toBe(1);
  });

  it("shows nothing for an entrant with no picks", async () => {
    const sam = await addEntrant(db, "sam", 0);
    expect(await getMyPicksHistory(db, sam.user.id)).toEqual({
      slots: [],
      aliveCount: 0,
      eliminatedCount: 0,
    });
  });
});
