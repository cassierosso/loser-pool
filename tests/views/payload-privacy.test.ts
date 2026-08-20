import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { Database, DatabaseHandle } from "@/lib/db/client";
import { weekStates, type GameRow, type TeamRow, type UserRow, type WeekStateRow } from "@/lib/db/schema";
import { getLeagueBoard } from "@/lib/views/board";
import { getWeekResults } from "@/lib/views/week-results";

import { createTestDatabase, seedTeams, setupLeague } from "../helpers/db";
import { addEntrant, addSelection, openWeekWithGames } from "../picks/helpers";

/**
 * ACCEPTANCE TEST 22.
 *
 * "Other users' selections are absent from the API response before lock -- not
 * merely hidden in the UI. Verify by inspecting the network payload."
 *
 * These assertions are made against the fully serialised response, hunting for
 * any trace of the other entrant: their team, their slot ids, their user id.
 * A UI that declined to render them would still fail this.
 */

let handle: DatabaseHandle;
let db: Database;
let teamRows: TeamRow[];
let week: WeekStateRow;
let weekGames: GameRow[];
let dana: { user: UserRow; slots: Array<{ id: string; label: string }> };
let marcus: { user: UserRow; slots: Array<{ id: string; label: string }> };

const BEFORE_LOCK = new Date("2024-10-06T16:00:00Z");
const AFTER_LOCK = new Date("2024-10-06T17:00:01Z");

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  await setupLeague(db);
  teamRows = await seedTeams(db);
  ({ week, weekGames } = await openWeekWithGames(db, teamRows));

  dana = await addEntrant(db, "dana", 2);
  marcus = await addEntrant(db, "marcus", 2);

  // Dana picks team 0; Marcus picks team 2. Neither should see the other yet.
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
});

afterEach(async () => {
  await handle.close();
});

/**
 * What would give Marcus's PICK away.
 *
 * Deliberately not his team's id: every team playing this week appears in the
 * schedule, which is not secret. What must be absent is the link between a
 * person and a team -- his slot, and on screens that do not otherwise list
 * entrants, his user id.
 */
function marcusPickFingerprints(): string[] {
  return [marcus.slots[0]!.id, marcus.slots[1]!.id];
}

describe("the League Board payload", () => {
  it("contains no trace of another entrant's pick before lock", async () => {
    const payload = JSON.stringify(await getLeagueBoard(db, dana.user, BEFORE_LOCK));

    expect(payload).toContain(teamRows[0]!.abbreviation); // Dana's own pick is there
    for (const fingerprint of marcusPickFingerprints()) {
      expect(payload).not.toContain(fingerprint);
    }
    // The board lists no games, so his team should not appear at all either.
    expect(payload).not.toContain(teamRows[2]!.abbreviation);
  });

  it("still lists every entrant and their counts before lock", async () => {
    // Hiding picks must not hide the standings: SS9 wants alive/eliminated
    // counts and picks_purchased on the board at all times.
    const board = await getLeagueBoard(db, dana.user, BEFORE_LOCK);

    expect(board.entrants.map((entrant) => entrant.displayName).sort()).toEqual(["dana", "marcus"]);
    expect(board.entrants.every((entrant) => entrant.aliveCount === 2)).toBe(true);
    expect(board.revealed).toBe(false);
    expect(board.picks.map((pick) => pick.displayName)).toEqual(["dana"]);
  });

  it("reveals everyone's picks once the week has locked", async () => {
    await db.update(weekStates).set({ status: "locked" }).where(eq(weekStates.id, week.id));

    const board = await getLeagueBoard(db, dana.user, BEFORE_LOCK);
    const payload = JSON.stringify(board);

    expect(board.revealed).toBe(true);
    expect(board.picks.map((pick) => pick.displayName).sort()).toEqual(["dana", "marcus"]);
    expect(payload).toContain(teamRows[2]!.abbreviation);
  });

  it("reveals once lock_at has passed even if the lock job never ran", async () => {
    const board = await getLeagueBoard(db, dana.user, AFTER_LOCK);

    expect(board.week?.status).toBe("open");
    expect(board.revealed).toBe(true);
    expect(board.picks).toHaveLength(2);
  });
});

describe("the Week Results payload", () => {
  it("contains no trace of another entrant's pick before lock", async () => {
    const results = await getWeekResults(db, dana.user, { now: BEFORE_LOCK });
    const payload = JSON.stringify(results);

    expect(results?.revealed).toBe(false);
    for (const fingerprint of [...marcusPickFingerprints(), marcus.user.id]) {
      expect(payload).not.toContain(fingerprint);
    }

    const shown = results!.gamesInWeek.flatMap((game) => game.selections);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.isViewer).toBe(true);
  });

  it("shows both entrants' picks after lock", async () => {
    await db.update(weekStates).set({ status: "locked" }).where(eq(weekStates.id, week.id));

    const results = await getWeekResults(db, dana.user, { now: BEFORE_LOCK });
    const shown = results!.gamesInWeek.flatMap((game) => game.selections);

    expect(shown).toHaveLength(2);
    expect(shown.map((selection) => selection.displayName).sort()).toEqual(["dana", "marcus"]);
  });

  it("gives an entrant with no picks nothing at all before lock", async () => {
    const sam = await addEntrant(db, "sam", 0);
    const results = await getWeekResults(db, sam.user, { now: BEFORE_LOCK });
    const payload = JSON.stringify(results);

    expect(results!.gamesInWeek.flatMap((game) => game.selections)).toHaveLength(0);
    for (const fingerprint of [
      ...marcusPickFingerprints(),
      marcus.user.id,
      dana.slots[0]!.id,
      dana.user.id,
    ]) {
      expect(payload).not.toContain(fingerprint);
    }
  });
});
