import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database, DatabaseHandle } from "@/lib/db/client";
import { games, pickSlots, selections, teams, users, weekStates } from "@/lib/db/schema";
import { REGULAR_SEASON_WEEKS, TOTAL_WEEK_COUNT } from "@/lib/week/ordinal";

import { seed } from "@/scripts/seed/index";
import { createTestDatabase } from "./helpers/db";

/**
 * The seeded fixture season is what Phases 2-7 develop and test against, so its
 * structural invariants are worth asserting: a broken fixture would send every
 * later phase chasing ghosts.
 */

const THROUGH = 10;
const REGULAR_SEASON_GAMES = 272;
const POSTSEASON_GAMES = 13;

let handle: DatabaseHandle;
let db: Database;

beforeAll(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  await seed(db, { seasonYear: 2024, through: THROUGH, includeAnomalies: true });
});

afterAll(async () => {
  await handle.close();
});

describe("the seeded season", () => {
  it("has all 32 teams, in eight divisions of four", async () => {
    const rows = await db.select().from(teams);
    expect(rows).toHaveLength(32);

    const divisions = new Map<string, number>();
    for (const team of rows) {
      const key = `${team.conference} ${team.division}`;
      divisions.set(key, (divisions.get(key) ?? 0) + 1);
    }
    expect(divisions.size).toBe(8);
    expect([...divisions.values()]).toEqual(Array.from({ length: 8 }, () => 4));
  });

  it("lays out 23 weeks on a contiguous ordinal axis", async () => {
    const rows = await db.select().from(weekStates).orderBy(weekStates.displayOrdinal);
    expect(rows).toHaveLength(TOTAL_WEEK_COUNT);
    expect(rows.map((week) => week.displayOrdinal)).toEqual(
      Array.from({ length: TOTAL_WEEK_COUNT }, (_, i) => i + 1),
    );
  });

  it("plays a full 272-game regular season and a 13-game bracket", async () => {
    const [regular] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(games)
      .where(eq(games.seasonType, 2));
    const [postseason] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(games)
      .where(eq(games.seasonType, 3));

    expect(regular?.n).toBe(REGULAR_SEASON_GAMES);
    expect(postseason?.n).toBe(POSTSEASON_GAMES);
  });

  it("gives every team exactly one bye, between weeks 6 and 14", async () => {
    const rows = await db
      .select({ weekNumber: games.weekNumber, home: games.homeTeamId, away: games.awayTeamId })
      .from(games)
      .where(eq(games.seasonType, 2));

    const playedWeeks = new Map<string, Set<number>>();
    for (const row of rows) {
      for (const teamId of [row.home, row.away]) {
        const weeks = playedWeeks.get(teamId) ?? new Set<number>();
        weeks.add(row.weekNumber);
        playedWeeks.set(teamId, weeks);
      }
    }

    expect(playedWeeks.size).toBe(32);
    for (const [, weeks] of playedWeeks) {
      const byes: number[] = [];
      for (let week = 1; week <= REGULAR_SEASON_WEEKS; week += 1) {
        if (!weeks.has(week)) byes.push(week);
      }
      expect(byes).toHaveLength(1);
      expect(byes[0]).toBeGreaterThanOrEqual(6);
      expect(byes[0]).toBeLessThanOrEqual(14);
    }
  });

  it("shrinks the postseason pool 6 -> 4 -> 2 -> 1", async () => {
    const rows = await db
      .select({ weekNumber: games.weekNumber, n: sql<number>`count(*)::int` })
      .from(games)
      .where(eq(games.seasonType, 3))
      .groupBy(games.weekNumber)
      .orderBy(games.weekNumber);

    expect(rows).toEqual([
      { weekNumber: 1, n: 6 },
      { weekNumber: 2, n: 4 },
      { weekNumber: 3, n: 2 },
      { weekNumber: 5, n: 1 },
    ]);
  });

  it("marks the Pro Bowl week skipped and gives it no games at all", async () => {
    // SS3.1 -- acceptance test 20.
    const [proBowl] = await db
      .select()
      .from(weekStates)
      .where(and(eq(weekStates.seasonType, 3), eq(weekStates.weekNumber, 4)));

    expect(proBowl?.displayLabel).toBe("Pro Bowl");
    expect(proBowl?.status).toBe("skipped");
    expect(proBowl?.lockAt).toBeNull();

    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(games)
      .where(eq(games.weekStateId, proBowl!.id));
    expect(count?.n).toBe(0);
  });

  it("locks each week at its earliest kickoff", async () => {
    // SS0 lockPolicy "first_kickoff": ALL picks lock at the first kickoff.
    const rows = await db
      .select({
        weekStateId: games.weekStateId,
        earliest: sql<Date>`min(${games.kickoffAt})`,
      })
      .from(games)
      .groupBy(games.weekStateId);

    const weeks = await db.select().from(weekStates);
    const lockByWeek = new Map(weeks.map((week) => [week.id, week.lockAt]));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(new Date(lockByWeek.get(row.weekStateId)!).toISOString()).toBe(
        new Date(row.earliest).toISOString(),
      );
    }
  });

  it("contains exactly one tie, and it is a final game with no winner", async () => {
    // SS3 tie detection: on a final, a null winner IS the tie.
    const ties = await db
      .select()
      .from(games)
      .where(and(eq(games.status, "final"), isNull(games.winnerTeamId)));

    expect(ties).toHaveLength(1);
    expect(ties[0]?.homeScore).toBe(ties[0]?.awayScore);
  });

  it("includes a canceled game and a postponed one", async () => {
    // Fixture material for acceptance tests 15 and 16.
    const [canceled] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(games)
      .where(eq(games.status, "canceled"));
    const [postponed] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(games)
      .where(eq(games.status, "postponed"));

    expect(canceled?.n).toBe(1);
    expect(postponed?.n).toBe(1);
  });

  it("leaves the current week locked and ungraded, with earlier weeks graded", async () => {
    const rows = await db.select().from(weekStates).orderBy(weekStates.displayOrdinal);
    const statusFor = (ordinal: number) =>
      rows.find((week) => week.displayOrdinal === ordinal)?.status;

    expect(statusFor(THROUGH - 1)).toBe("graded");
    expect(statusFor(THROUGH)).toBe("locked");
    expect(statusFor(THROUGH + 1)).toBe("open");
    expect(statusFor(THROUGH + 2)).toBe("upcoming");

    const [pending] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(selections)
      .where(eq(selections.result, "pending"));
    expect(pending?.n).toBeGreaterThan(0);
  });

  it("provisions slots that match what each entrant bought", async () => {
    const rows = await db
      .select({ userId: pickSlots.userId, n: sql<number>`count(*)::int` })
      .from(pickSlots)
      .groupBy(pickSlots.userId);

    // Seven entrants bought picks; the eighth bought none and so has no slots.
    expect(rows).toHaveLength(7);
    expect(rows.reduce((total, row) => total + row.n, 0)).toBe(56);
  });

  it("leaves more than one entrant alive, so the league is still a contest", async () => {
    const alive = await db
      .select({ userId: pickSlots.userId })
      .from(pickSlots)
      .where(eq(pickSlots.status, "alive"))
      .groupBy(pickSlots.userId);

    expect(alive.length).toBeGreaterThan(1);
  });

  it("never records a selection for a slot after it was eliminated", async () => {
    const rows = await db
      .select({
        slotId: pickSlots.id,
        eliminatedWeek: pickSlots.eliminatedWeek,
        eliminatedSeasonType: pickSlots.eliminatedSeasonType,
        selectionSeasonType: selections.seasonType,
        selectionWeek: selections.weekNumber,
      })
      .from(pickSlots)
      .innerJoin(selections, eq(selections.pickSlotId, pickSlots.id))
      .where(eq(pickSlots.status, "eliminated"));

    for (const row of rows) {
      const sameSeasonType = row.selectionSeasonType === row.eliminatedSeasonType;
      if (sameSeasonType) {
        expect(row.selectionWeek).toBeLessThanOrEqual(row.eliminatedWeek!);
      }
    }
  });
});

describe("seed determinism", () => {
  it("produces the same season on a second run", async () => {
    // Row UUIDs are database-generated and will differ; everything that carries
    // meaning is compared on natural keys.
    const project = async (database: Database) => {
      const gameRows = await database
        .select({
          espnEventId: games.espnEventId,
          kickoffAt: games.kickoffAt,
          homeScore: games.homeScore,
          awayScore: games.awayScore,
          status: games.status,
          homeAbbr: sql<string>`(select abbreviation from team where team.id = ${games.homeTeamId})`,
          awayAbbr: sql<string>`(select abbreviation from team where team.id = ${games.awayTeamId})`,
          winnerAbbr: sql<
            string | null
          >`(select abbreviation from team where team.id = ${games.winnerTeamId})`,
        })
        .from(games)
        .orderBy(games.espnEventId);

      const selectionRows = await database
        .select({
          email: users.email,
          label: pickSlots.label,
          seasonType: selections.seasonType,
          weekNumber: selections.weekNumber,
          result: selections.result,
          wasAutoAssigned: selections.wasAutoAssigned,
          teamAbbr: sql<string>`(select abbreviation from team where team.id = ${selections.teamId})`,
        })
        .from(selections)
        .innerJoin(pickSlots, eq(pickSlots.id, selections.pickSlotId))
        .innerJoin(users, eq(users.id, pickSlots.userId))
        .orderBy(users.email, pickSlots.slotNumber, selections.seasonType, selections.weekNumber);

      return JSON.stringify({ gameRows, selectionRows });
    };

    const first = await project(db);

    const second = await createTestDatabase();
    try {
      await seed(second.db, { seasonYear: 2024, through: THROUGH, includeAnomalies: true });
      expect(await project(second.db)).toBe(first);
    } finally {
      await second.close();
    }
  });
});
