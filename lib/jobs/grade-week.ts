import { and, eq, inArray } from "drizzle-orm";

import { getLeagueConfig, loadLeague } from "@/lib/config";
import { withTransaction } from "@/lib/db/client";
import { leagues, pickSlots, selections, weekStates } from "@/lib/db/schema";
import { autoAssignWeek } from "@/lib/rules/auto-assign";
import { gradeWeek as gradeWeekRules } from "@/lib/rules/grade";
import { evaluateSeasonEnd, type SeasonEndOutcome } from "@/lib/rules/season";

import {
  loadAliveSlots,
  loadEntrantStates,
  loadEntrantStatesEnteringWeek,
  loadGamesForWeek,
  loadPriorSelections,
  loadSelectionsForWeek,
} from "./load";
import type { JobContext, JobResult } from "./types";
import { loadWeeks } from "./weeks";

/**
 * SS8 job 3 -- gradeWeek.
 *
 * Runs only when every non-canceled game in the week is final. Applies SS5.2
 * auto-assignment, then SS5.1 grading, then the SS6 end-of-season evaluation,
 * then flips the week to graded and opens the next one.
 *
 * MUST BE SAFE TO RUN TWICE. It is, at two levels: a week that is already
 * graded returns immediately, and the rules engine emits updates only where the
 * computed outcome differs from what is stored, so even a forced re-run writes
 * nothing.
 */
export async function runGradeWeek(
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
      : weeks.find((candidate) => candidate.status === "locked" || candidate.status === "grading");

  if (!week) {
    return { job: "gradeWeek", ok: true, summary: "No week is ready to grade.", detail: {}, warnings: [] };
  }

  if (week.status === "graded") {
    return {
      job: "gradeWeek",
      ok: true,
      summary: `${week.displayLabel} is already graded; nothing to do.`,
      detail: { ordinal: week.displayOrdinal, changed: false },
      warnings: [],
    };
  }

  if (week.status === "skipped") {
    // SS3.1: the Pro Bowl is never graded.
    return {
      job: "gradeWeek",
      ok: true,
      summary: `${week.displayLabel} is skipped and is never graded.`,
      detail: { ordinal: week.displayOrdinal },
      warnings: [],
    };
  }

  const weekGames = await loadGamesForWeek(db, week);
  if (weekGames.length === 0) {
    return {
      job: "gradeWeek",
      ok: false,
      summary: `${week.displayLabel} has no games; run syncSchedule first.`,
      detail: { ordinal: week.displayOrdinal },
      warnings: [`${week.displayLabel} has no games in the database.`],
    };
  }

  // SS6's wipeout rule needs this captured before anything in this run kills a
  // slot, so it is read first.
  const entrantsEnteringWeek = await loadEntrantStatesEnteringWeek(db, week);

  const warnings: string[] = [];

  // SS5.2 first: any alive slot that never submitted is resolved before the
  // week is graded. Normally lockWeek has already done this; running it again
  // here is harmless because resolved slots are no longer missing.
  const autoAssigned = await applyAutoAssignment(ctx, week, weeks, config);

  const [aliveSlots, weekSelections] = await Promise.all([
    loadAliveSlots(db),
    loadSelectionsForWeek(db, week),
  ]);

  const graded = gradeWeekRules({
    config,
    seasonType: week.seasonType,
    weekNumber: week.weekNumber,
    games: weekGames,
    selections: weekSelections,
    aliveSlots,
  });

  if (!graded.canGrade) {
    // SS8: loud, never a silent half-apply.
    const blocked = weekGames.filter((game) => graded.blockedBy.includes(game.id));
    const summary =
      `${week.displayLabel} cannot be graded yet: ` +
      `${blocked.length} game(s) are neither final nor canceled.`;
    return {
      job: "gradeWeek",
      ok: false,
      summary,
      detail: { ordinal: week.displayOrdinal, blockedBy: graded.blockedBy },
      warnings: [summary, ...blocked.map((game) => `Game ${game.espnEventId} is ${game.status}.`)],
    };
  }

  await withTransaction(db, async (tx) => {
    for (const update of graded.selectionResults) {
      await tx
        .update(selections)
        .set({ result: update.to, gradedAt: ctx.now })
        .where(eq(selections.id, update.selectionId));
    }

    for (const update of graded.slotUpdates) {
      await tx
        .update(pickSlots)
        .set({
          status: "eliminated",
          eliminatedSeasonType: update.seasonType,
          eliminatedWeek: update.weekNumber,
          eliminatedReason: update.reason,
          eliminatedAt: ctx.now,
        })
        .where(eq(pickSlots.id, update.slotId));
    }

    await tx.update(weekStates).set({ status: "graded" }).where(eq(weekStates.id, week.id));
  });

  for (const entry of [...autoAssigned.auditEntries, ...graded.auditEntries]) {
    await ctx.recorder.record(entry);
  }

  // SS6, evaluated immediately after the week is graded.
  const entrantsAfter = await loadEntrantStates(db);
  const evaluation = evaluateSeasonEnd({
    config,
    gradedWeek: { ...week, status: "graded" },
    weeks: weeks.map((candidate) =>
      candidate.id === week.id ? { ...candidate, status: "graded" as const } : candidate,
    ),
    entrantsAfter,
    entrantsEnteringWeek,
  });

  await applySeasonOutcome(ctx, league, evaluation.outcome);
  for (const entry of evaluation.auditEntries) {
    await ctx.recorder.record(entry);
  }

  const summary =
    `${week.displayLabel} graded: ` +
    `${graded.selectionResults.filter((r) => r.to === "survived").length} survived, ` +
    `${graded.selectionResults.filter((r) => r.to === "eliminated").length} eliminated, ` +
    `${graded.selectionResults.filter((r) => r.to === "void").length} void. ` +
    evaluation.outcome.reason;

  return {
    job: "gradeWeek",
    ok: true,
    summary,
    detail: {
      ordinal: week.displayOrdinal,
      changed: true,
      autoAssigned: autoAssigned.count,
      selectionsUpdated: graded.selectionResults.length,
      slotsEliminated: graded.slotUpdates.length,
      outcome: evaluation.outcome.kind,
    },
    warnings,
  };
}

async function applyAutoAssignment(
  ctx: JobContext,
  week: Awaited<ReturnType<typeof loadWeeks>>[number],
  weeks: Awaited<ReturnType<typeof loadWeeks>>,
  config: Awaited<ReturnType<typeof getLeagueConfig>>,
) {
  const { db } = ctx;
  const [aliveSlots, selectionsThisWeek] = await Promise.all([
    loadAliveSlots(db),
    loadSelectionsForWeek(db, week),
  ]);

  const priorSelections = await loadPriorSelections(
    db,
    aliveSlots.map((slot) => slot.id),
    week.displayOrdinal,
  );

  const weekGames = await loadGamesForWeek(db, week);
  const result = autoAssignWeek({
    config,
    week,
    weeks,
    games: weekGames,
    aliveSlots,
    selectionsThisWeek,
    priorSelections,
  });

  if (result.assignments.length === 0 && result.eliminations.length === 0) {
    return { count: 0, auditEntries: [] };
  }

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
  });

  return {
    count: result.assignments.length + result.eliminations.length,
    auditEntries: result.auditEntries,
  };
}

/**
 * SS6. Opens the next week, or closes/freezes the season. Under admin_decides
 * NOTHING is opened -- the league waits for the admin.
 */
async function applySeasonOutcome(
  ctx: JobContext,
  league: { id: string; seasonYear: number },
  outcome: SeasonEndOutcome,
): Promise<void> {
  const { db } = ctx;

  if (outcome.kind === "open_week") {
    // The engine deals in RuleWeek, which carries no database id on purpose, so
    // the week is addressed by the identity that matters: its ordinal within
    // the season. Only an 'upcoming' week is opened, so a re-run can never
    // reopen one that has already been played.
    await db
      .update(weekStates)
      .set({ status: "open" })
      .where(
        and(
          eq(weekStates.seasonYear, league.seasonYear),
          eq(weekStates.displayOrdinal, outcome.week.displayOrdinal),
          eq(weekStates.status, "upcoming"),
        ),
      );
    return;
  }

  await db
    .update(leagues)
    .set({
      seasonStatus: outcome.kind === "pending_admin" ? "pending_admin" : "closed",
      seasonOutcome: {
        kind: outcome.kind,
        ...("userIds" in outcome ? { userIds: outcome.userIds } : {}),
        ...("cause" in outcome ? { cause: outcome.cause } : {}),
        ...("question" in outcome ? { question: outcome.question } : {}),
        reason: outcome.reason,
        decidedAt: ctx.now.toISOString(),
      },
      updatedAt: ctx.now,
    })
    .where(eq(leagues.id, league.id));
}
