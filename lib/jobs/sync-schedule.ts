import { and, eq, sql } from "drizzle-orm";

import { loadLeague } from "@/lib/config";
import { games, teams, weekStates, type WeekStateRow } from "@/lib/db/schema";

import type { JobContext, JobResult } from "./types";
import { ensureWeekStates, nextPlayable, resolveCurrentWeek } from "./weeks";

/**
 * SS8 job 1 -- syncSchedule.
 *
 * Pulls the current and next week's games with the correct season_type, upserts
 * them by espn_event_id, and recomputes each week's lock_at as the earliest
 * kickoff in that week (SS0 lockPolicy "first_kickoff"). Creates and labels the
 * postseason week rows, including the skipped Pro Bowl week.
 *
 * Idempotent: re-running it against unchanged upstream data writes the same
 * values and reports zero changes.
 */
export async function syncSchedule(
  ctx: JobContext,
  options: { ordinals?: number[] } = {},
): Promise<JobResult> {
  const { db, provider } = ctx;
  const { row: league } = await loadLeague(db);
  const allWeeks = await ensureWeekStates(db, league.seasonYear);

  const targets = resolveTargets(allWeeks, options.ordinals);
  const warnings: string[] = [];

  const teamRows = await db.select().from(teams);
  const teamIdByEspnId = new Map(teamRows.map((team) => [team.espnTeamId, team.id]));

  let upserted = 0;
  const perWeek: Record<string, number> = {};

  for (const week of targets) {
    const providerGames = await provider.getWeekGames(
      league.seasonYear,
      week.seasonType,
      week.weekNumber,
    );

    let countForWeek = 0;
    for (const game of providerGames) {
      const homeTeamId = teamIdByEspnId.get(game.homeTeamEspnId);
      const awayTeamId = teamIdByEspnId.get(game.awayTeamEspnId);

      if (!homeTeamId || !awayTeamId) {
        // The Pro Bowl fields two invented "teams" (ESPN ids 31 and 32, AFC and
        // NFC). We never request that week, but an unknown team id is skipped
        // rather than inserted under any circumstances.
        warnings.push(
          `Skipped event ${game.espnEventId}: unknown team id(s) ${game.homeTeamEspnId}/${game.awayTeamEspnId}.`,
        );
        continue;
      }

      const winnerTeamId = game.winnerTeamEspnId
        ? (teamIdByEspnId.get(game.winnerTeamEspnId) ?? null)
        : null;

      await db
        .insert(games)
        .values({
          espnEventId: game.espnEventId,
          seasonYear: game.seasonYear,
          seasonType: game.seasonType,
          weekNumber: game.weekNumber,
          weekStateId: week.id,
          kickoffAt: game.kickoffAt,
          homeTeamId,
          awayTeamId,
          homeScore: game.homeScore,
          awayScore: game.awayScore,
          status: game.status,
          winnerTeamId,
        })
        .onConflictDoUpdate({
          target: games.espnEventId,
          set: {
            weekStateId: week.id,
            kickoffAt: game.kickoffAt,
            homeTeamId,
            awayTeamId,
            homeScore: game.homeScore,
            awayScore: game.awayScore,
            status: game.status,
            winnerTeamId,
            updatedAt: ctx.now,
          },
        });

      countForWeek += 1;
      upserted += 1;
    }

    perWeek[week.displayLabel] = countForWeek;
    await recomputeLockAt(db, week, ctx.now);
  }

  const summary = `Synced ${upserted} game(s) across ${targets.length} week(s): ${targets
    .map((week) => week.displayLabel)
    .join(", ")}.`;

  await ctx.recorder.record({
    actorUserId: null,
    actorRole: "system",
    action: "job.sync_schedule",
    targetType: "job",
    targetId: "syncSchedule",
    targetLabel: "syncSchedule",
    beforeJson: {},
    afterJson: { perWeek, upserted, warnings },
    reason: summary,
    selfAffecting: false,
  });

  return { job: "syncSchedule", ok: true, summary, detail: { perWeek, upserted }, warnings };
}

function resolveTargets(
  weeks: readonly WeekStateRow[],
  ordinals: number[] | undefined,
): WeekStateRow[] {
  if (ordinals) {
    return weeks
      .filter((week) => ordinals.includes(week.displayOrdinal) && week.status !== "skipped")
      .sort((a, b) => a.displayOrdinal - b.displayOrdinal);
  }

  const current = resolveCurrentWeek(weeks);
  if (!current) return [];

  const next = nextPlayable(weeks, current.displayOrdinal);
  return next ? [current, next] : [current];
}

/**
 * SS8: lock_at is the earliest kickoff in the week. Recomputed from what is in
 * the database rather than from the response just parsed, so a week whose games
 * arrived across several syncs still locks at the true first kickoff.
 */
async function recomputeLockAt(
  db: JobContext["db"],
  week: WeekStateRow,
  now: Date,
): Promise<void> {
  const [row] = await db
    .select({ earliest: sql<Date | null>`min(${games.kickoffAt})` })
    .from(games)
    .where(and(eq(games.weekStateId, week.id), sql`${games.status} <> 'canceled'`));

  await db
    .update(weekStates)
    .set({
      lockAt: row?.earliest ? new Date(row.earliest) : null,
      lastSyncedAt: now,
    })
    .where(eq(weekStates.id, week.id));
}
