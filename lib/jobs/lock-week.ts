import { eq, inArray } from "drizzle-orm";

import { getLeagueConfig, loadLeague } from "@/lib/config";
import { withTransaction } from "@/lib/db/client";
import { pickSlots, selections, weekStates, type WeekStateRow } from "@/lib/db/schema";
import { autoAssignWeek } from "@/lib/rules/auto-assign";

import { loadAliveSlots, loadGamesForWeek, loadPriorSelections, loadSelectionsForWeek } from "./load";
import type { JobContext, JobResult } from "./types";
import { loadWeeks } from "./weeks";

/**
 * SS8's small job -- lockWeek. Fires at lock_at.
 *
 * Flips the week to locked, runs SS5.2 auto-assignment, and reveals all
 * selections. There is no "hidden" column to flip: selection visibility is
 * derived from the week's status at query time, so locking the week IS the
 * reveal. That is what makes acceptance test 22 achievable -- other entrants'
 * picks are absent from the API response before lock, not merely hidden in the
 * UI.
 *
 * Idempotent: it acts only on a week that is still 'open'.
 */
export async function lockWeek(
  ctx: JobContext,
  options: { ordinal?: number } = {},
): Promise<JobResult> {
  const { db } = ctx;
  const { row: league } = await loadLeague(db);
  const config = await getLeagueConfig(db);
  const weeks = await loadWeeks(db, league.seasonYear);

  const week =
    options.ordinal !== undefined
      ? weeks.find((candidate) => candidate.displayOrdinal === options.ordinal)
      : weeks.find(
          (candidate) =>
            candidate.status === "open" &&
            candidate.lockAt !== null &&
            candidate.lockAt.getTime() <= ctx.now.getTime(),
        );

  if (!week) {
    return { job: "lockWeek", ok: true, summary: "No week is due to lock.", detail: {}, warnings: [] };
  }

  if (week.status !== "open") {
    return {
      job: "lockWeek",
      ok: true,
      summary: `${week.displayLabel} is ${week.status}; nothing to lock.`,
      detail: { ordinal: week.displayOrdinal },
      warnings: [],
    };
  }

  const [weekGames, aliveSlots, selectionsThisWeek] = await Promise.all([
    loadGamesForWeek(db, week),
    loadAliveSlots(db),
    loadSelectionsForWeek(db, week),
  ]);

  const priorSelections = await loadPriorSelections(
    db,
    aliveSlots.map((slot) => slot.id),
    week.displayOrdinal,
  );

  const result = autoAssignWeek({
    config,
    week,
    weeks,
    games: weekGames,
    aliveSlots,
    selectionsThisWeek,
    priorSelections,
  });

  const ownerBySlotId = new Map(aliveSlots.map((slot) => [slot.id, slot.userId]));

  await withTransaction(db, async (tx) => {
    if (result.assignments.length > 0) {
      await tx.insert(selections).values(
        result.assignments.map((assignment) => ({
          pickSlotId: assignment.slotId,
          weekStateId: week.id,
          seasonType: week.seasonType,
          weekNumber: week.weekNumber,
          teamId: assignment.teamId,
          gameId: assignment.gameId,
          submittedAt: ctx.now,
          // No human submitted this. The slot's owner is recorded as the
          // submitter so the row still resolves to a person in history and in
          // the audit log; was_auto_assigned is what marks it as the system's
          // doing, and the UI must label it everywhere it appears (SS5.2).
          submittedByUserId: ownerBySlotId.get(assignment.slotId)!,
          wasAutoAssigned: true,
        })),
      );
    }

    if (result.eliminations.length > 0) {
      await tx
        .update(pickSlots)
        .set({
          status: "eliminated",
          eliminatedSeasonType: week.seasonType,
          eliminatedWeek: week.weekNumber,
          eliminatedReason: "no_submission",
          eliminatedAt: ctx.now,
        })
        .where(
          inArray(
            pickSlots.id,
            result.eliminations.map((elimination) => elimination.slotId),
          ),
        );
    }

    await tx.update(weekStates).set({ status: "locked" }).where(eq(weekStates.id, week.id));
  });

  for (const entry of result.auditEntries) {
    await ctx.recorder.record(entry);
  }

  const summary =
    `${week.displayLabel} locked. ` +
    `${result.assignments.length} auto-assigned, ${result.eliminations.length} eliminated for no submission` +
    (result.survivedWithoutSelection.length > 0
      ? `, ${result.survivedWithoutSelection.length} advanced without a pick`
      : "") +
    ".";

  await ctx.recorder.record({
    actorUserId: null,
    actorRole: "system",
    action: "week.locked",
    targetType: "job",
    targetId: `lockWeek:${week.displayOrdinal}`,
    targetLabel: `${week.displayLabel} locked`,
    beforeJson: { status: "open" },
    afterJson: {
      status: "locked",
      autoAssigned: result.assignments.length,
      eliminated: result.eliminations.length,
    },
    reason: summary,
    selfAffecting: false,
  });

  return {
    job: "lockWeek",
    ok: true,
    summary,
    detail: {
      ordinal: week.displayOrdinal,
      autoAssigned: result.assignments.length,
      eliminated: result.eliminations.length,
      survivedWithoutSelection: result.survivedWithoutSelection.length,
    },
    warnings: [],
  };
}

export function isDueToLock(week: WeekStateRow, now: Date): boolean {
  return week.status === "open" && week.lockAt !== null && week.lockAt.getTime() <= now.getTime();
}
