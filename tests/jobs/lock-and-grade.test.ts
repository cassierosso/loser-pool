import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createCollectingAuditRecorder } from "@/lib/audit/port";
import type { Database, DatabaseHandle } from "@/lib/db/client";
import {
  games,
  leagues,
  pickSlots,
  selections,
  users,
  weekStates,
  type GameRow,
  type TeamRow,
  type WeekStateRow,
} from "@/lib/db/schema";
import { runGradeWeek } from "@/lib/jobs/grade-week";
import { lockWeek } from "@/lib/jobs/lock-week";
import type { JobContext } from "@/lib/jobs/types";
import type { ScheduleProvider } from "@/lib/providers/types";

import { createTestDatabase, seedTeams, setupLeague, TEST_SEASON_YEAR } from "../helpers/db";

/**
 * SS8's lockWeek and gradeWeek, against hand-built database state.
 *
 * Neither job calls a provider -- they read what the sync jobs have already
 * stored -- so the provider here throws if anything touches it.
 */

const NOW = new Date("2024-10-10T12:00:00Z");

const noProvider: ScheduleProvider = {
  name: "none",
  getTeams: () => Promise.reject(new Error("lock/grade must not call a provider")),
  getWeekGames: () => Promise.reject(new Error("lock/grade must not call a provider")),
};

let handle: DatabaseHandle;
let db: Database;
let recorder: ReturnType<typeof createCollectingAuditRecorder>;
let teamRows: TeamRow[];

function context(now: Date = NOW): JobContext {
  return { db, provider: noProvider, recorder, now };
}

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  recorder = createCollectingAuditRecorder();
  await setupLeague(db);
  teamRows = await seedTeams(db);
});

afterEach(async () => {
  await handle.close();
});

async function weekAt(ordinal: number): Promise<WeekStateRow> {
  const [week] = await db.select().from(weekStates).where(eq(weekStates.displayOrdinal, ordinal));
  return week!;
}

async function openWeek(ordinal: number, lockAt: Date): Promise<WeekStateRow> {
  await db
    .update(weekStates)
    .set({ status: "open", lockAt })
    .where(eq(weekStates.displayOrdinal, ordinal));
  return weekAt(ordinal);
}

async function addGame(
  week: WeekStateRow,
  homeIndex: number,
  awayIndex: number,
  options: Partial<GameRow> = {},
): Promise<GameRow> {
  const home = teamRows[homeIndex]!;
  const away = teamRows[awayIndex]!;
  const [game] = await db
    .insert(games)
    .values({
      espnEventId: `evt-${week.displayOrdinal}-${homeIndex}-${awayIndex}`,
      seasonYear: TEST_SEASON_YEAR,
      seasonType: week.seasonType,
      weekNumber: week.weekNumber,
      weekStateId: week.id,
      kickoffAt: new Date("2024-10-10T17:00:00Z"),
      homeTeamId: home.id,
      awayTeamId: away.id,
      status: "scheduled",
      ...options,
    })
    .returning();
  return game!;
}

async function addEntrant(name: string, slotCount: number) {
  const [user] = await db
    .insert(users)
    .values({ email: `${name}@example.com`, displayName: name, picksPurchased: slotCount })
    .returning();
  const slots = await db
    .insert(pickSlots)
    .values(
      Array.from({ length: slotCount }, (_, index) => ({
        userId: user!.id,
        slotNumber: index + 1,
        label: `Pick ${index + 1}`,
      })),
    )
    .returning();
  return { user: user!, slots };
}

async function pick(slotId: string, week: WeekStateRow, teamId: string, game: GameRow, userId: string) {
  const [row] = await db
    .insert(selections)
    .values({
      pickSlotId: slotId,
      weekStateId: week.id,
      seasonType: week.seasonType,
      weekNumber: week.weekNumber,
      teamId,
      gameId: game.id,
      submittedByUserId: userId,
    })
    .returning();
  return row!;
}

describe("lockWeek (SS8)", () => {
  it("locks the week and auto-assigns a slot that never submitted", async () => {
    const previous = await openWeek(4, new Date("2024-10-03T17:00:00Z"));
    const previousGame = await addGame(previous, 0, 1, { status: "final", winnerTeamId: teamRows[0]!.id });
    const week = await openWeek(5, new Date("2024-10-10T17:00:00Z"));
    const currentGame = await addGame(week, 0, 1);

    const dana = await addEntrant("dana", 1);
    // Picked team 1 (the loser) last week and survived; never submitted this week.
    await pick(dana.slots[0]!.id, previous, teamRows[1]!.id, previousGame, dana.user.id);
    await db.update(weekStates).set({ status: "graded" }).where(eq(weekStates.id, previous.id));
    await db.update(selections).set({ result: "survived" });

    // The week is due to lock only once its first kickoff has passed.
    const result = await lockWeek(context(new Date("2024-10-10T17:00:01Z")));

    expect(result.ok).toBe(true);
    expect(result.detail.autoAssigned).toBe(1);
    expect((await weekAt(5)).status).toBe("locked");

    const assigned = await db
      .select()
      .from(selections)
      .where(eq(selections.weekStateId, week.id));
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.wasAutoAssigned).toBe(true);
    expect(assigned[0]?.teamId).toBe(teamRows[1]!.id);
    expect(assigned[0]?.gameId).toBe(currentGame.id);
  });

  it("eliminates a slot with nothing to repeat, under the default fallback", async () => {
    const week = await openWeek(1, new Date("2024-09-05T17:00:00Z"));
    await addGame(week, 0, 1);
    const dana = await addEntrant("dana", 1);

    const result = await lockWeek(context(new Date("2024-09-05T18:00:00Z")));

    expect(result.detail.eliminated).toBe(1);
    const [slot] = await db.select().from(pickSlots).where(eq(pickSlots.id, dana.slots[0]!.id));
    expect(slot?.status).toBe("eliminated");
    expect(slot?.eliminatedReason).toBe("no_submission");
    expect(slot?.eliminatedWeek).toBe(1);
  });

  it("leaves a slot that did submit completely alone", async () => {
    const week = await openWeek(5, new Date("2024-10-10T17:00:00Z"));
    const game = await addGame(week, 0, 1);
    const dana = await addEntrant("dana", 1);
    const submitted = await pick(dana.slots[0]!.id, week, teamRows[1]!.id, game, dana.user.id);

    await lockWeek(context());

    const rows = await db.select().from(selections).where(eq(selections.weekStateId, week.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(submitted.id);
    expect(rows[0]?.wasAutoAssigned).toBe(false);
  });

  it("does nothing to a week that is not open", async () => {
    await openWeek(5, new Date("2024-10-10T17:00:00Z"));
    await db.update(weekStates).set({ status: "locked" }).where(eq(weekStates.displayOrdinal, 5));

    const result = await lockWeek(context(), { ordinal: 5 });
    expect(result.summary).toContain("nothing to lock");
  });
});

describe("gradeWeek (SS8)", () => {
  async function gradableWeek() {
    const week = await openWeek(5, new Date("2024-10-10T17:00:00Z"));
    // team 0 beat team 1; team 2 v team 3 was canceled.
    const played = await addGame(week, 0, 1, {
      status: "final",
      winnerTeamId: teamRows[0]!.id,
      homeScore: 24,
      awayScore: 17,
    });
    const canceled = await addGame(week, 2, 3, { status: "canceled" });
    await db.update(weekStates).set({ status: "locked" }).where(eq(weekStates.id, week.id));
    return { week, played, canceled };
  }

  it("grades a week, closes it, and opens the next one", async () => {
    const { week, played, canceled } = await gradableWeek();

    const dana = await addEntrant("dana", 2);
    const marcus = await addEntrant("marcus", 1);
    // A third entrant who also survives: with only two, killing one would leave
    // a single survivor and SS6 would rightly close the season instead of
    // opening week 6.
    const priya = await addEntrant("priya", 1);
    await pick(dana.slots[0]!.id, week, teamRows[1]!.id, played, dana.user.id); // lost -> survives
    await pick(dana.slots[1]!.id, week, teamRows[2]!.id, canceled, dana.user.id); // void
    await pick(marcus.slots[0]!.id, week, teamRows[0]!.id, played, marcus.user.id); // won -> out
    await pick(priya.slots[0]!.id, week, teamRows[1]!.id, played, priya.user.id); // survives

    const result = await runGradeWeek(context());

    expect(result.ok).toBe(true);
    expect((await weekAt(5)).status).toBe("graded");
    expect((await weekAt(6)).status).toBe("open");

    const rows = await db.select().from(selections).where(eq(selections.weekStateId, week.id));
    const byResult = Object.fromEntries(rows.map((row) => [row.pickSlotId, row.result]));
    expect(byResult[dana.slots[0]!.id]).toBe("survived");
    expect(byResult[dana.slots[1]!.id]).toBe("void");
    expect(byResult[marcus.slots[0]!.id]).toBe("eliminated");

    const [deadSlot] = await db.select().from(pickSlots).where(eq(pickSlots.id, marcus.slots[0]!.id));
    expect(deadSlot?.status).toBe("eliminated");
    expect(deadSlot?.eliminatedReason).toBe("team_won");

    // A canceled game voids the pick without killing the slot (test 16).
    const [voidedSlot] = await db.select().from(pickSlots).where(eq(pickSlots.id, dana.slots[1]!.id));
    expect(voidedSlot?.status).toBe("alive");
  });

  it("is safe to run twice", async () => {
    // SS8 / acceptance test 14.
    const { week, played } = await gradableWeek();
    const dana = await addEntrant("dana", 1);
    const marcus = await addEntrant("marcus", 1);
    await pick(dana.slots[0]!.id, week, teamRows[1]!.id, played, dana.user.id);
    await pick(marcus.slots[0]!.id, week, teamRows[0]!.id, played, marcus.user.id);

    await runGradeWeek(context());
    const firstSelections = await db.select().from(selections).orderBy(selections.id);
    const firstSlots = await db.select().from(pickSlots).orderBy(pickSlots.id);
    const firstWeeks = await db.select().from(weekStates).orderBy(weekStates.displayOrdinal);

    const second = await runGradeWeek(context(), { ordinal: 5 });

    expect(second.detail.changed).toBe(false);
    expect(await db.select().from(selections).orderBy(selections.id)).toEqual(firstSelections);
    expect(await db.select().from(pickSlots).orderBy(pickSlots.id)).toEqual(firstSlots);
    expect(await db.select().from(weekStates).orderBy(weekStates.displayOrdinal)).toEqual(firstWeeks);
  });

  it("refuses to grade a week containing a postponed game, loudly", async () => {
    // Acceptance test 15.
    const { week, played } = await gradableWeek();
    await addGame(week, 4, 5, { status: "postponed" });
    const dana = await addEntrant("dana", 1);
    await pick(dana.slots[0]!.id, week, teamRows[1]!.id, played, dana.user.id);

    const result = await runGradeWeek(context());

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("cannot be graded yet");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect((await weekAt(5)).status).toBe("locked");

    const rows = await db.select().from(selections);
    expect(rows.every((row) => row.result === "pending")).toBe(true);
  });

  it("closes the season when one entrant is left", async () => {
    // SS6 / acceptance test 17.
    const { week, played } = await gradableWeek();
    const dana = await addEntrant("dana", 1);
    const marcus = await addEntrant("marcus", 1);
    await pick(dana.slots[0]!.id, week, teamRows[1]!.id, played, dana.user.id); // survives
    await pick(marcus.slots[0]!.id, week, teamRows[0]!.id, played, marcus.user.id); // out

    const result = await runGradeWeek(context());

    expect(result.detail.outcome).toBe("champion");
    const [league] = await db.select().from(leagues);
    expect(league?.seasonStatus).toBe("closed");
    expect(league?.seasonOutcome?.kind).toBe("champion");
    expect(league?.seasonOutcome?.userIds).toEqual([dana.user.id]);

    // No further week opens, even though weeks 6-23 exist.
    expect((await weekAt(6)).status).toBe("upcoming");
  });

  it("applies the wipeout rule when everyone dies at once", async () => {
    // SS6 / acceptance test 19.
    const { week, played } = await gradableWeek();
    const dana = await addEntrant("dana", 1);
    const marcus = await addEntrant("marcus", 1);
    await pick(dana.slots[0]!.id, week, teamRows[0]!.id, played, dana.user.id);
    await pick(marcus.slots[0]!.id, week, teamRows[0]!.id, played, marcus.user.id);

    await runGradeWeek(context());

    const [league] = await db.select().from(leagues);
    expect(league?.seasonStatus).toBe("closed");
    expect(league?.seasonOutcome).toMatchObject({ kind: "co_champions", cause: "wipeout" });
    expect(league?.seasonOutcome?.userIds?.sort()).toEqual([dana.user.id, marcus.user.id].sort());
  });

  it("steps over the Pro Bowl when opening the round after the Conference Championship", async () => {
    // SS3.1 / acceptance test 20.
    await db
      .update(weekStates)
      .set({ status: "locked", lockAt: new Date("2024-10-10T17:00:00Z") })
      .where(eq(weekStates.displayOrdinal, 21));
    const conference = await weekAt(21);
    const played = await addGame(conference, 0, 1, {
      status: "final",
      winnerTeamId: teamRows[0]!.id,
      homeScore: 30,
      awayScore: 27,
    });

    const dana = await addEntrant("dana", 1);
    const marcus = await addEntrant("marcus", 1);
    await pick(dana.slots[0]!.id, conference, teamRows[1]!.id, played, dana.user.id);
    await pick(marcus.slots[0]!.id, conference, teamRows[1]!.id, played, marcus.user.id);

    await runGradeWeek(context());

    expect((await weekAt(22)).status).toBe("skipped");
    expect((await weekAt(23)).status).toBe("open");
  });

  it("will not grade a week with no games", async () => {
    await db.update(weekStates).set({ status: "locked" }).where(eq(weekStates.displayOrdinal, 5));

    const result = await runGradeWeek(context(), { ordinal: 5 });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("syncSchedule");
  });
});
