import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { Database, DatabaseHandle } from "@/lib/db/client";
import { leagues, pickSlots, type TeamRow } from "@/lib/db/schema";
import { getLeagueBoard } from "@/lib/views/board";

import { createTestDatabase, seedTeams, setupLeague } from "../helpers/db";
import { addEntrant, openWeekWithGames } from "../picks/helpers";

/**
 * SS9 -- League Board standings.
 */

let handle: DatabaseHandle;
let db: Database;
let teamRows: TeamRow[];

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  await setupLeague(db);
  teamRows = await seedTeams(db);
  await openWeekWithGames(db, teamRows);
});

afterEach(async () => {
  await handle.close();
});

async function kill(slotId: string) {
  await db
    .update(pickSlots)
    .set({
      status: "eliminated",
      eliminatedSeasonType: 2,
      eliminatedWeek: 3,
      eliminatedReason: "team_won",
      eliminatedAt: new Date(),
    })
    .where(eq(pickSlots.id, slotId));
}

describe("standings", () => {
  it("ranks entrants by surviving picks, then by name", async () => {
    const dana = await addEntrant(db, "dana", 3);
    const marcus = await addEntrant(db, "marcus", 3);
    await addEntrant(db, "priya", 1);
    await kill(dana.slots[0]!.id);
    await kill(dana.slots[1]!.id); // dana down to 1

    const board = await getLeagueBoard(db, dana.user);

    expect(board.entrants.map((entrant) => [entrant.displayName, entrant.aliveCount])).toEqual([
      ["marcus", 3],
      ["dana", 1],
      ["priya", 1],
    ]);
    expect(marcus.user.id).toBeTruthy();
  });

  it("keeps eliminated slots in the purchased count", async () => {
    // The season-long invariant: buying 3 and losing 2 still means you bought 3.
    const dana = await addEntrant(db, "dana", 3);
    await kill(dana.slots[0]!.id);
    await kill(dana.slots[1]!.id);

    const [entrant] = (await getLeagueBoard(db, dana.user)).entrants;

    expect(entrant).toMatchObject({ picksPurchased: 3, aliveCount: 1, eliminatedCount: 2 });
  });

  it("includes an entrant who bought nothing", async () => {
    // SS2: they can log in and watch, so they belong on the board at zero.
    const dana = await addEntrant(db, "dana", 1);
    await addEntrant(db, "sam", 0);

    const board = await getLeagueBoard(db, dana.user);
    const sam = board.entrants.find((entrant) => entrant.displayName === "sam");

    expect(sam).toMatchObject({ picksPurchased: 0, aliveCount: 0, eliminatedCount: 0 });
  });

  it("marks the viewer and the admin", async () => {
    const dana = await addEntrant(db, "dana", 1, { role: "admin" });
    await addEntrant(db, "marcus", 1);

    const board = await getLeagueBoard(db, dana.user);
    const viewer = board.entrants.find((entrant) => entrant.isViewer);

    expect(viewer?.displayName).toBe("dana");
    expect(viewer?.isAdmin).toBe(true);
    expect(board.entrants.filter((entrant) => entrant.isViewer)).toHaveLength(1);
  });

  it("surfaces the champion once the season has closed", async () => {
    const dana = await addEntrant(db, "dana", 1);
    await db.update(leagues).set({
      seasonStatus: "closed",
      seasonOutcome: {
        kind: "champion",
        userIds: [dana.user.id],
        reason: "One entrant remains after Week 18.",
        decidedAt: new Date().toISOString(),
      },
    });

    const board = await getLeagueBoard(db, dana.user);

    expect(board.league.seasonStatus).toBe("closed");
    expect(board.championUserIds).toEqual([dana.user.id]);
  });
});
