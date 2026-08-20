import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";

import { createCollectingAuditRecorder } from "@/lib/audit/port";
import type { Database, DatabaseHandle } from "@/lib/db/client";
import { games, weekStates } from "@/lib/db/schema";
import { syncResults } from "@/lib/jobs/sync-results";
import { syncSchedule } from "@/lib/jobs/sync-schedule";
import type { JobContext } from "@/lib/jobs/types";

import { createTestDatabase, seedTeams, setupLeague } from "../helpers/db";
import { createFixtureProvider } from "../helpers/espn-fixtures";

/**
 * SS8 jobs 1 and 2, driven by recorded ESPN responses (SS13: never live).
 * The league year is 2024 so the recorded postseason fixtures apply.
 */

let handle: DatabaseHandle;
let db: Database;
let recorder: ReturnType<typeof createCollectingAuditRecorder>;

const NOW = new Date("2025-01-08T12:00:00Z");

function context(overrides: Partial<JobContext> = {}): JobContext {
  return {
    db,
    provider: createFixtureProvider(),
    recorder,
    now: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  recorder = createCollectingAuditRecorder();
});

afterEach(async () => {
  await handle.close();
});

describe("syncSchedule (SS8)", () => {
  it("creates all 23 week rows, with the Pro Bowl born skipped", async () => {
    await setupLeague(db, { createWeeks: false });
    await seedTeams(db);

    await syncSchedule(context(), { ordinals: [19] });

    const weeks = await db.select().from(weekStates).orderBy(weekStates.displayOrdinal);
    expect(weeks).toHaveLength(23);
    expect(weeks.map((week) => week.displayLabel).slice(18)).toEqual([
      "Wild Card",
      "Divisional",
      "Conference",
      "Pro Bowl",
      "Super Bowl",
    ]);

    const proBowl = weeks.find((week) => week.displayOrdinal === 22);
    expect(proBowl?.status).toBe("skipped");
  });

  it("imports a real Wild Card round and locks it at the earliest kickoff", async () => {
    await setupLeague(db, { createWeeks: false });
    await seedTeams(db);

    const result = await syncSchedule(context(), { ordinals: [19] });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);

    const [week] = await db
      .select()
      .from(weekStates)
      .where(eq(weekStates.displayOrdinal, 19));
    const wildCardGames = await db.select().from(games).where(eq(games.weekStateId, week!.id));

    expect(wildCardGames).toHaveLength(6);

    // SS0 lockPolicy "first_kickoff".
    const earliest = Math.min(...wildCardGames.map((game) => game.kickoffAt.getTime()));
    expect(week!.lockAt?.getTime()).toBe(earliest);
    expect(week!.lastSyncedAt?.getTime()).toBe(NOW.getTime());
  });

  it("never opens or imports the Pro Bowl week", async () => {
    // SS3.1. Its two "teams" are ESPN ids 31/32, which are not franchises, so
    // even if it were requested nothing could be inserted.
    const requested: string[] = [];
    await setupLeague(db, { createWeeks: false });
    await seedTeams(db);

    await syncSchedule(
      context({ provider: createFixtureProvider({ onRequest: (url) => requested.push(url) }) }),
      { ordinals: [21, 22, 23] },
    );

    expect(requested.some((url) => url.includes("seasontype=3&week=4"))).toBe(false);

    const [proBowl] = await db.select().from(weekStates).where(eq(weekStates.displayOrdinal, 22));
    expect(proBowl?.status).toBe("skipped");
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(games)
      .where(eq(games.weekStateId, proBowl!.id));
    expect(count?.n).toBe(0);
  });

  it("is idempotent: a second run changes nothing", async () => {
    await setupLeague(db, { createWeeks: false });
    await seedTeams(db);

    await syncSchedule(context(), { ordinals: [19, 20] });
    const first = await db.select().from(games).orderBy(games.espnEventId);

    await syncSchedule(context(), { ordinals: [19, 20] });
    const second = await db.select().from(games).orderBy(games.espnEventId);

    expect(second).toHaveLength(10); // 6 Wild Card + 4 Divisional
    expect(second.map((g) => ({ ...g, updatedAt: null }))).toEqual(
      first.map((g) => ({ ...g, updatedAt: null })),
    );
  });

  it("records the winner of a completed game", async () => {
    await setupLeague(db, { createWeeks: false });
    await seedTeams(db);

    await syncSchedule(context(), { ordinals: [23] });
    const [superBowl] = await db.select().from(games);

    expect(superBowl?.status).toBe("final");
    expect(superBowl?.winnerTeamId).not.toBeNull();
    expect(superBowl?.homeScore).toBeGreaterThan(0);
  });
});

describe("syncResults (SS8)", () => {
  it("sets winner_team_id to null on a tie", async () => {
    // SS3: on a final, a null winner IS the tie. 2022 week 1, IND @ HOU 20-20.
    await setupLeague(db, { createWeeks: false });
    await seedTeams(db);

    const tieProvider = createFixtureProvider({ forceScoreboard: "2022-reg-1-tie" });
    await syncSchedule(context({ provider: tieProvider }), { ordinals: [1] });

    const ties = await db
      .select()
      .from(games)
      .where(and(eq(games.status, "final"), isNull(games.winnerTeamId)));

    expect(ties).toHaveLength(1);
    expect(ties[0]?.homeScore).toBe(ties[0]?.awayScore);
  });

  it("updates scores on an existing game without creating rows", async () => {
    await setupLeague(db, { createWeeks: false });
    await seedTeams(db);
    await syncSchedule(context(), { ordinals: [19] });

    // Wind the scores back so the results sync has something to correct.
    await db.update(games).set({ homeScore: 0, awayScore: 0, status: "in_progress", winnerTeamId: null });

    const before = await db.select({ n: sql<number>`count(*)::int` }).from(games);
    const result = await syncResults(context(), { ordinal: 19 });
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(games);

    expect(result.ok).toBe(true);
    expect(result.detail.updated).toBe(6);
    expect(after[0]?.n).toBe(before[0]?.n);
    expect(recorder.events.some((event) => event.action === "job.sync_results")).toBe(true);
  });

  it("reports nothing to do on a second run", async () => {
    await setupLeague(db, { createWeeks: false });
    await seedTeams(db);
    await syncSchedule(context(), { ordinals: [19] });

    const result = await syncResults(context(), { ordinal: 19 });
    expect(result.detail.updated).toBe(0);
  });

  it("refuses to sync the Pro Bowl week", async () => {
    await setupLeague(db, { createWeeks: false });
    await seedTeams(db);
    await syncSchedule(context(), { ordinals: [21] });

    const result = await syncResults(context(), { ordinal: 22 });
    expect(result.summary).toContain("skipped");
  });

  it("warns about a scoreboard event the schedule has never seen", async () => {
    await setupLeague(db, { createWeeks: false });
    await seedTeams(db);
    await syncSchedule(context(), { ordinals: [19] });
    await db.delete(games);

    const result = await syncResults(context(), { ordinal: 19 });
    expect(result.warnings).toHaveLength(6);
    expect(result.warnings[0]).toContain("run syncSchedule");
  });
});
