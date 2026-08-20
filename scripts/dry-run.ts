import { readFileSync } from "node:fs";
import { asc, eq, inArray, sql } from "drizzle-orm";

import { createUser, setPicksPurchased, type AdminActor } from "@/lib/admin";
import { createAuditRecorder } from "@/lib/audit/writer";
import { verifyAuditChain } from "@/lib/audit/verify";
import { createDatabase, type Database } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import {
  games,
  leagues,
  pickSlots,
  selections,
  teams,
  users,
  weekStates,
  type TeamRow,
  type WeekStateRow,
} from "@/lib/db/schema";
import { DEFAULT_LEAGUE_CONFIG } from "@/lib/config";
import { runGradeWeek } from "@/lib/jobs/grade-week";
import { lockWeek } from "@/lib/jobs/lock-week";
import { syncResults } from "@/lib/jobs/sync-results";
import { syncSchedule } from "@/lib/jobs/sync-schedule";
import type { JobContext } from "@/lib/jobs/types";
import { submitAllocations } from "@/lib/picks/submit";
import { createEspnProvider } from "@/lib/providers/espn";
import type { ScheduleProvider } from "@/lib/providers/types";

import { dropEverything } from "./reset";
import { argInt, loadEnv, parseArgs } from "./env";

/**
 * SS14 Phase 7 -- "dry run against a full completed prior season including its
 * playoffs."
 *
 * Replays the real 2024 NFL season through the whole pipeline, week by week:
 * sync the schedule, open the week, let entrants pick, lock it, sync the
 * results, grade it, and let SS6 decide what happens next. Nothing is
 * simulated except the entrants.
 *
 * Runs against recorded responses rather than the live API. That is not only
 * for speed: ESPN blocks bursts with a 403 that lasts minutes, and a replay is
 * 23 requests.
 *
 *   npm run dry-run
 *   npm run dry-run -- --entrants 6 --picks 5
 */

const SEASON = 2024;
const FIXTURES = "fixtures/espn/season-2024";

const POSTSEASON_FILES: Record<number, string> = {
  1: "post-wildcard",
  2: "post-divisional",
  3: "post-conference",
  4: "post-probowl",
  5: "post-superbowl",
};

/** Serves the recorded season. */
function recordedSeasonProvider(): ScheduleProvider {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());

    if (url.pathname.endsWith("/teams")) {
      return new Response(readFileSync("fixtures/espn/teams.json", "utf8"), { status: 200 });
    }

    const seasonType = url.searchParams.get("seasontype");
    const week = Number(url.searchParams.get("week"));
    const name = seasonType === "3" ? POSTSEASON_FILES[week] : `reg-week${week}`;

    try {
      return new Response(readFileSync(`${FIXTURES}/${name}.json`, "utf8"), { status: 200 });
    } catch {
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }
  }) as typeof fetch;

  return createEspnProvider({ fetchImpl, cacheTtlMs: 0, minRequestIntervalMs: 0 });
}

const systemActor: AdminActor = {
  actorUserId: null,
  actorRole: "system",
  reason: "Dry run setup",
  override: true,
};

async function setUp(db: Database, entrantCount: number, picksEach: number) {
  const teamRows = JSON.parse(readFileSync("fixtures/teams.json", "utf8")) as Array<Omit<TeamRow, "id">>;
  await db.insert(teams).values(teamRows);

  await db.insert(leagues).values({
    name: "Dry Run League",
    seasonYear: SEASON,
    joinCode: "DRYRUN",
    config: { ...DEFAULT_LEAGUE_CONFIG },
  });

  const recorder = createAuditRecorder(db);
  const entrants = [];
  for (let i = 0; i < entrantCount; i += 1) {
    const created = await createUser(
      db,
      { email: `player${i + 1}@example.com`, displayName: `Player ${i + 1}` },
      systemActor,
      recorder,
    );
    if (!created.ok) throw new Error(created.error.message);
    const provisioned = await setPicksPurchased(
      db,
      { userId: created.value.id, picksPurchased: picksEach },
      systemActor,
      recorder,
    );
    if (!provisioned.ok) throw new Error(provisioned.error.message);
    entrants.push(provisioned.value.user);
  }
  return entrants;
}

/** Wins so far, used to guess who is likely to lose next. */
async function standings(db: Database): Promise<Map<string, number>> {
  const rows = await db
    .select({ winner: games.winnerTeamId })
    .from(games)
    .where(eq(games.status, "final"));

  const wins = new Map<string, number>();
  for (const row of rows) {
    if (row.winner) wins.set(row.winner, (wins.get(row.winner) ?? 0) + 1);
  }
  return wins;
}

/**
 * A plausible entrant: backs the worst teams playing, offset per person so the
 * league does not move as one, and never both sides of the same game.
 */
async function pickFor(
  db: Database,
  week: WeekStateRow,
  aliveCount: number,
  offset: number,
): Promise<Array<{ teamId: string; count: number }>> {
  const weekGames = await db.select().from(games).where(eq(games.weekStateId, week.id));
  const wins = await standings(db);

  const candidates = weekGames
    .flatMap((game) => [
      { teamId: game.homeTeamId, opponent: game.awayTeamId },
      { teamId: game.awayTeamId, opponent: game.homeTeamId },
    ])
    .sort((a, b) => (wins.get(a.teamId) ?? 0) - (wins.get(b.teamId) ?? 0) || a.teamId.localeCompare(b.teamId));

  if (candidates.length === 0) return [];

  const chosen: string[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < candidates.length && chosen.length < aliveCount; i += 1) {
    const candidate = candidates[(i + offset) % candidates.length]!;
    if (taken.has(candidate.teamId) || taken.has(candidate.opponent)) continue;
    chosen.push(candidate.teamId);
    taken.add(candidate.teamId);
    taken.add(candidate.opponent);
  }

  return chosen.map((teamId) => ({ teamId, count: 1 }));
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const entrantCount = argInt(args, "entrants", 6);
  const picksEach = argInt(args, "picks", 5);
  /**
   * Which week to start from. A league playing well can still be wiped out in
   * November, and SS14 wants the playoffs exercised specifically -- starting at
   * Week 18 replays the regular/postseason boundary, the skipped Pro Bowl and
   * the Super Bowl against real recorded data.
   */
  const from = argInt(args, "from", 1);

  const url = process.env.DRY_RUN_DATABASE_URL ?? process.env.DATABASE_URL;
  const handle = await createDatabase(url);
  const db = handle.db;

  try {
    console.log(
      `Dry run: replaying the ${SEASON} season from ordinal ${from} ` +
        `with ${entrantCount} entrants × ${picksEach} picks\n`,
    );

    await dropEverything(db);
    await runMigrations(handle);
    const entrants = await setUp(db, entrantCount, picksEach);

    const provider = recordedSeasonProvider();
    const ctx = (now: Date): JobContext => ({
      db,
      provider,
      recorder: createAuditRecorder(db),
      now,
    });

    // Import every week up front; the real syncSchedule only ever pulls two.
    const clock = new Date(`${SEASON}-09-01T00:00:00Z`);
    await syncSchedule(ctx(clock), { ordinals: Array.from({ length: 23 }, (_, i) => i + 1) });

    const allWeeks = await db.select().from(weekStates).orderBy(asc(weekStates.displayOrdinal));
    let opened = allWeeks.find((week) => week.displayOrdinal === from)!;
    await db.update(weekStates).set({ status: "open" }).where(eq(weekStates.id, opened.id));

    let weeksPlayed = 0;

    for (let guard = 0; guard < 30; guard += 1) {
      const [week] = await db.select().from(weekStates).where(eq(weekStates.status, "open"));
      if (!week) break;

      const lockAt = week.lockAt ?? new Date(clock);
      const beforeLock = new Date(lockAt.getTime() - 3600_000);
      const afterAll = new Date(lockAt.getTime() + 5 * 24 * 3600_000);

      // One entrant plays the opening week and then goes quiet -- on holiday,
      // bored, whatever. That is what actually exercises SS5.2's
      // repeat-last-week: an entrant who never submits at all just gets
      // eliminated in Week 1 and stops being interesting.
      for (const [index, entrant] of entrants.entries()) {
        const goesQuiet = index === entrants.length - 1 && week.displayOrdinal > from;
        if (goesQuiet) continue;

        const alive = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(pickSlots)
          .where(sql`${pickSlots.userId} = ${entrant.id} and ${pickSlots.status} = 'alive'`);
        const aliveCount = alive[0]?.n ?? 0;
        if (aliveCount === 0) continue;

        const allocations = await pickFor(db, week, aliveCount, index * 3);
        if (allocations.length === 0) continue;

        const result = await submitAllocations(
          db,
          { user: entrant, allocations, now: beforeLock, weekStateId: week.id },
          createAuditRecorder(db),
        );
        if (!result.ok) {
          console.log(`  ! ${entrant.displayName}: ${result.errors[0]?.reason}`);
        }
      }

      await lockWeek(ctx(lockAt), { ordinal: week.displayOrdinal });
      await syncResults(ctx(afterAll), { ordinal: week.displayOrdinal });
      const graded = await runGradeWeek(ctx(afterAll), { ordinal: week.displayOrdinal });

      const aliveByUser = await db
        .select({ userId: pickSlots.userId })
        .from(pickSlots)
        .where(eq(pickSlots.status, "alive"));
      const entrantsAlive = new Set(aliveByUser.map((row) => row.userId)).size;

      console.log(
        `${week.displayLabel.padEnd(12)} ${graded.ok ? "graded" : "BLOCKED"} — ` +
          `${aliveByUser.length} picks / ${entrantsAlive} entrants alive` +
          (graded.ok ? "" : `  (${graded.summary})`),
      );

      weeksPlayed += 1;
      opened = week;
      if (!graded.ok) break;
    }

    // ---- what happened -------------------------------------------------
    const [league] = await db.select().from(leagues);
    const skipped = await db
      .select()
      .from(weekStates)
      .where(eq(weekStates.status, "skipped"));
    const [gameCount] = await db.select({ n: sql<number>`count(*)::int` }).from(games);
    const [selCount] = await db.select({ n: sql<number>`count(*)::int` }).from(selections);
    const [autoCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(selections)
      .where(eq(selections.wasAutoAssigned, true));
    const ties = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(games)
      .where(sql`${games.status} = 'final' and ${games.winnerTeamId} is null`);
    const chain = await verifyAuditChain(db);

    console.log(`\n${"—".repeat(60)}`);
    console.log(`weeks played:      ${weeksPlayed}`);
    console.log(`games imported:    ${gameCount?.n}`);
    console.log(`ties in season:    ${ties[0]?.n}`);
    console.log(`selections:        ${selCount?.n} (${autoCount?.n} auto-assigned)`);
    console.log(`skipped weeks:     ${skipped.map((week) => week.displayLabel).join(", ") || "none"}`);
    console.log(`season status:     ${league?.seasonStatus}`);
    console.log(`outcome:           ${league?.seasonOutcome?.reason ?? "(season did not close)"}`);

    if (league?.seasonOutcome?.userIds?.length) {
      const winners = await db
        .select({ name: users.displayName })
        .from(users)
        .where(inArray(users.id, league.seasonOutcome.userIds));
      console.log(`winner(s):         ${winners.map((row) => row.name).join(", ")}`);
    }

    console.log(
      `audit chain:       ${chain.valid ? `VALID, ${chain.entries} entries, head #${chain.head?.seq}` : `INVALID at #${chain.failure.seq}`}`,
    );
  } finally {
    await handle.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`\nDry run failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
}
