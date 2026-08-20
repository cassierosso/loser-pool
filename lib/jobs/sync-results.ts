import { eq } from "drizzle-orm";

import { loadLeague } from "@/lib/config";
import { games, teams } from "@/lib/db/schema";

import type { JobContext, JobResult } from "./types";
import { loadWeeks, resolveCurrentWeek } from "./weeks";

/**
 * SS8 job 2 -- syncResults.
 *
 * Pulls the current week's scoreboard and updates scores, status, and
 * winner_team_id. A null winner on a final row IS the tie (SS3), and that is
 * what SS5.1 turns into an elimination for every pick on both teams.
 *
 * Only updates games that already exist: creating them is syncSchedule's job,
 * and an event appearing here that the schedule has never seen is reported as a
 * warning rather than quietly inserted.
 */
export async function syncResults(
  ctx: JobContext,
  options: { ordinal?: number } = {},
): Promise<JobResult> {
  const { db, provider } = ctx;
  const { row: league } = await loadLeague(db);
  const weeks = await loadWeeks(db, league.seasonYear);

  const week =
    options.ordinal !== undefined
      ? weeks.find((candidate) => candidate.displayOrdinal === options.ordinal)
      : resolveCurrentWeek(weeks);

  if (!week) {
    return {
      job: "syncResults",
      ok: true,
      summary: "No week to sync; the season is finished or not yet scheduled.",
      detail: {},
      warnings: [],
    };
  }

  if (week.status === "skipped") {
    // SS3.1: never sync the Pro Bowl.
    return {
      job: "syncResults",
      ok: true,
      summary: `${week.displayLabel} is skipped and is never synced.`,
      detail: { ordinal: week.displayOrdinal },
      warnings: [],
    };
  }

  const teamRows = await db.select().from(teams);
  const teamIdByEspnId = new Map(teamRows.map((team) => [team.espnTeamId, team.id]));

  const existing = await db.select().from(games).where(eq(games.weekStateId, week.id));
  const existingByEventId = new Map(existing.map((game) => [game.espnEventId, game]));

  const providerGames = await provider.getWeekGames(
    league.seasonYear,
    week.seasonType,
    week.weekNumber,
  );

  const warnings: string[] = [];
  let updated = 0;
  let ties = 0;

  for (const game of providerGames) {
    const current = existingByEventId.get(game.espnEventId);
    if (!current) {
      warnings.push(
        `Event ${game.espnEventId} is on the scoreboard but not in the schedule; run syncSchedule.`,
      );
      continue;
    }

    const winnerTeamId = game.winnerTeamEspnId
      ? (teamIdByEspnId.get(game.winnerTeamEspnId) ?? null)
      : null;

    if (game.status === "final" && winnerTeamId === null) ties += 1;

    const unchanged =
      current.status === game.status &&
      current.homeScore === game.homeScore &&
      current.awayScore === game.awayScore &&
      current.winnerTeamId === winnerTeamId;

    if (unchanged) continue;

    await db
      .update(games)
      .set({
        homeScore: game.homeScore,
        awayScore: game.awayScore,
        status: game.status,
        winnerTeamId,
        updatedAt: ctx.now,
      })
      .where(eq(games.id, current.id));

    updated += 1;
  }

  const summary =
    updated === 0
      ? `No changes for ${week.displayLabel}.`
      : `Updated ${updated} game(s) in ${week.displayLabel}${ties > 0 ? ` (${ties} tie(s))` : ""}.`;

  if (updated > 0) {
    await ctx.recorder.record({
      actorUserId: null,
      actorRole: "system",
      action: "job.sync_results",
      targetType: "job",
      targetId: "syncResults",
      targetLabel: `syncResults -- ${week.displayLabel}`,
      beforeJson: {},
      afterJson: { updated, ties, ordinal: week.displayOrdinal },
      reason: summary,
      selfAffecting: false,
    });
  }

  return {
    job: "syncResults",
    ok: true,
    summary,
    detail: { updated, ties, ordinal: week.displayOrdinal },
    warnings,
  };
}
