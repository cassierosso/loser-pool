import { and, eq, inArray, sql } from "drizzle-orm";

import type { AuditRecorder } from "@/lib/audit/port";
import { getLeagueConfig } from "@/lib/config";
import { withTransaction, type Database } from "@/lib/db/client";
import { games, pickSlots, selections, teams, weekStates, type UserRow } from "@/lib/db/schema";
import { validateSelection } from "@/lib/rules/validate";

import { allocateSlots, findBothSidesConflicts, type Allocation } from "./allocate";

/**
 * SS5.3 / SS9 -- submitting picks.
 *
 * NEVER TRUST THE CLIENT. Every pick is re-validated here, server-side, against
 * the same rules engine the UI used, however the request arrived. Acceptance
 * test 5 exists because a client that permits a late submission must still be
 * refused.
 *
 * The whole form is one transaction: SS9 says "save all slots in one submit",
 * so if any pick is invalid nothing is written at all. A partial save would
 * leave the entrant believing they had picked when they had not.
 */

export interface SubmittedPick {
  slotId: string;
  teamId: string;
}

export interface SubmitFailure {
  slotId: string;
  slotLabel: string;
  code: string;
  reason: string;
}

export type SubmitResult =
  | { ok: true; saved: number; weekLabel: string }
  | { ok: false; errors: SubmitFailure[] };

export async function submitSelections(
  db: Database,
  input: { user: UserRow; picks: SubmittedPick[]; now?: Date; weekStateId?: string },
  recorder: AuditRecorder,
): Promise<SubmitResult> {
  const now = input.now ?? new Date();
  const config = await getLeagueConfig(db);

  const [week] = input.weekStateId
    ? await db.select().from(weekStates).where(eq(weekStates.id, input.weekStateId)).limit(1)
    : await db.select().from(weekStates).where(eq(weekStates.status, "open")).limit(1);

  if (!week) {
    return {
      ok: false,
      errors: [
        { slotId: "", slotLabel: "", code: "week_not_open", reason: "No week is open for picks." },
      ],
    };
  }

  const userSlots = await db.select().from(pickSlots).where(eq(pickSlots.userId, input.user.id));
  const slotsById = new Map(userSlots.map((slot) => [slot.id, slot]));

  const weekGames = await db.select().from(games).where(eq(games.weekStateId, week.id));

  const existing = await db
    .select()
    .from(selections)
    .where(
      and(
        eq(selections.weekStateId, week.id),
        inArray(
          selections.pickSlotId,
          userSlots.map((slot) => slot.id),
        ),
      ),
    );
  const existingBySlot = new Map(existing.map((row) => [row.pickSlotId, row]));

  const errors: SubmitFailure[] = [];
  const valid: Array<{ pick: SubmittedPick; gameId: string; slotLabel: string }> = [];

  for (const pick of input.picks) {
    const slot = slotsById.get(pick.slotId);

    if (!slot) {
      // Not merely unknown: a slot id that is not this user's must be refused
      // exactly as SS5.3 requires, without revealing whether it exists.
      errors.push({
        slotId: pick.slotId,
        slotLabel: "",
        code: "not_your_slot",
        reason: "That pick slot belongs to another entrant.",
      });
      continue;
    }

    const others = input.picks
      .filter((other) => other.slotId !== pick.slotId)
      .map((other) => ({
        id: "",
        pickSlotId: other.slotId,
        teamId: other.teamId,
        gameId: "",
        result: "pending" as const,
        wasAutoAssigned: false,
      }));

    const check = validateSelection({
      config,
      week,
      pickSlot: slot,
      requestingUserId: input.user.id,
      user: { id: input.user.id, picksPurchased: input.user.picksPurchased },
      teamId: pick.teamId,
      games: weekGames,
      otherSelectionsThisWeekForUser: others,
      now,
    });

    if (!check.ok) {
      errors.push({ slotId: slot.id, slotLabel: slot.label, code: check.code, reason: check.reason });
      continue;
    }

    const game = weekGames.find(
      (candidate) =>
        candidate.homeTeamId === pick.teamId || candidate.awayTeamId === pick.teamId,
    );

    if (!game) {
      errors.push({
        slotId: slot.id,
        slotLabel: slot.label,
        code: "team_not_playing",
        reason: `That team is not playing in ${week.displayLabel}.`,
      });
      continue;
    }

    valid.push({ pick, gameId: game.id, slotLabel: slot.label });
  }

  if (errors.length > 0) return { ok: false, errors };

  await withTransaction(db, async (tx) => {
    for (const entry of valid) {
      await tx
        .insert(selections)
        .values({
          pickSlotId: entry.pick.slotId,
          weekStateId: week.id,
          seasonType: week.seasonType,
          weekNumber: week.weekNumber,
          teamId: entry.pick.teamId,
          gameId: entry.gameId,
          submittedAt: now,
          submittedByUserId: input.user.id,
          wasAutoAssigned: false,
        })
        .onConflictDoUpdate({
          target: [selections.pickSlotId, selections.weekStateId],
          set: {
            teamId: entry.pick.teamId,
            gameId: entry.gameId,
            submittedAt: now,
            submittedByUserId: input.user.id,
            // An edit by the entrant replaces an auto-assignment.
            wasAutoAssigned: false,
          },
        });
    }
  });

  // SS7.1: a player submitting or editing a selection is a logged event.
  const teamRows = await db.select().from(teams);
  const abbrById = new Map(teamRows.map((team) => [team.id, team.abbreviation]));

  for (const entry of valid) {
    const previous = existingBySlot.get(entry.pick.slotId);
    await recorder.record({
      actorUserId: input.user.id,
      actorRole: input.user.role === "admin" ? "admin" : "player",
      action: previous ? "selection.edit" : "selection.submit",
      targetType: "selection",
      targetId: entry.pick.slotId,
      targetLabel: `${input.user.displayName} — ${entry.slotLabel} — ${week.displayLabel}`,
      beforeJson: previous
        ? { teamId: previous.teamId, team: abbrById.get(previous.teamId), wasAutoAssigned: previous.wasAutoAssigned }
        : {},
      afterJson: { teamId: entry.pick.teamId, team: abbrById.get(entry.pick.teamId) },
      reason: previous ? "Player changed their pick" : "Player submitted a pick",
      selfAffecting: false,
    });
  }

  return { ok: true, saved: valid.length, weekLabel: week.displayLabel };
}

/** How many alive slots still have no pick this week -- for the SS9 nudge. */
export async function countMissingPicks(
  db: Database,
  userId: string,
  weekStateId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pickSlots)
    .where(
      and(
        eq(pickSlots.userId, userId),
        eq(pickSlots.status, "alive"),
        sql`not exists (select 1 from selection s where s.pick_slot_id = ${pickSlots.id} and s.week_state_id = ${weekStateId})`,
      ),
    );
  return row?.n ?? 0;
}

/**
 * SS9 -- submitting an aggregate allocation ("2 on Dallas, 1 on Tampa Bay").
 *
 * The client sends counts per team and never names a pick slot; the mapping onto
 * this user's slots happens here, on the server, from rows read out of the
 * database. That removes a whole category of tampering by construction -- there
 * is no slot id in the request to point at somebody else's entry.
 *
 * Every resulting per-slot pick still goes through validateSelection, and the
 * whole allocation is applied in one transaction or not at all.
 */
export async function submitAllocations(
  db: Database,
  input: { user: UserRow; allocations: Allocation[]; now?: Date; weekStateId?: string },
  recorder: AuditRecorder,
): Promise<SubmitResult> {
  const now = input.now ?? new Date();
  const config = await getLeagueConfig(db);

  const [week] = input.weekStateId
    ? await db.select().from(weekStates).where(eq(weekStates.id, input.weekStateId)).limit(1)
    : await db.select().from(weekStates).where(eq(weekStates.status, "open")).limit(1);

  if (!week) {
    return {
      ok: false,
      errors: [
        { slotId: "", slotLabel: "", code: "week_not_open", reason: "No week is open for picks." },
      ],
    };
  }

  const allSlots = await db.select().from(pickSlots).where(eq(pickSlots.userId, input.user.id));
  const aliveSlots = allSlots.filter((slot) => slot.status === "alive");
  const slotsById = new Map(allSlots.map((slot) => [slot.id, slot]));

  const existing = await db
    .select()
    .from(selections)
    .where(
      and(
        eq(selections.weekStateId, week.id),
        inArray(
          selections.pickSlotId,
          allSlots.length > 0 ? allSlots.map((slot) => slot.id) : [""],
        ),
      ),
    );
  const existingBySlot = new Map(existing.map((row) => [row.pickSlotId, row]));

  const outcome = allocateSlots({
    aliveSlots,
    existingBySlotId: Object.fromEntries(existing.map((row) => [row.pickSlotId, row.teamId])),
    allocations: input.allocations,
  });

  if (!outcome.ok) {
    return {
      ok: false,
      errors: [{ slotId: "", slotLabel: "", code: outcome.code, reason: outcome.message }],
    };
  }

  const weekGames = await db.select().from(games).where(eq(games.weekStateId, week.id));

  // LEAGUE_CONFIG bothSidesOfGame: refuse a hedge across a single game, and say
  // which two teams clash rather than blaming an individual slot.
  if (config.bothSidesOfGame === "block") {
    const conflicts = findBothSidesConflicts({ allocations: input.allocations, games: weekGames });

    if (conflicts.length > 0) {
      const teamRows = await db.select().from(teams);
      const nameById = new Map(teamRows.map((team) => [team.id, team.displayName]));

      return {
        ok: false,
        errors: conflicts.map((conflict) => ({
          slotId: "",
          slotLabel: "",
          code: "both_sides_of_game",
          reason:
            `You have picks on both ${nameById.get(conflict.awayTeamId) ?? "one team"} and ` +
            `${nameById.get(conflict.homeTeamId) ?? "the other"} — they play each other. ` +
            `Back one side or the other, not both.`,
        })),
      };
    }
  }

  const errors: SubmitFailure[] = [];
  const valid: Array<{ slotId: string; teamId: string; gameId: string; slotLabel: string }> = [];

  for (const assignment of outcome.result.assignments) {
    const slot = slotsById.get(assignment.slotId);
    if (!slot) continue;

    const check = validateSelection({
      config,
      week,
      pickSlot: slot,
      requestingUserId: input.user.id,
      user: { id: input.user.id, picksPurchased: input.user.picksPurchased },
      teamId: assignment.teamId,
      games: weekGames,
      otherSelectionsThisWeekForUser: outcome.result.assignments
        .filter((other) => other.slotId !== assignment.slotId)
        .map((other) => ({
          id: "",
          pickSlotId: other.slotId,
          teamId: other.teamId,
          gameId: "",
          result: "pending" as const,
          wasAutoAssigned: false,
        })),
      now,
    });

    if (!check.ok) {
      errors.push({ slotId: slot.id, slotLabel: slot.label, code: check.code, reason: check.reason });
      continue;
    }

    const game = weekGames.find(
      (candidate) =>
        candidate.homeTeamId === assignment.teamId || candidate.awayTeamId === assignment.teamId,
    );

    if (!game) {
      errors.push({
        slotId: slot.id,
        slotLabel: slot.label,
        code: "team_not_playing",
        reason: `That team is not playing in ${week.displayLabel}.`,
      });
      continue;
    }

    valid.push({ slotId: slot.id, teamId: assignment.teamId, gameId: game.id, slotLabel: slot.label });
  }

  if (errors.length > 0) return { ok: false, errors };

  await withTransaction(db, async (tx) => {
    for (const entry of valid) {
      await tx
        .insert(selections)
        .values({
          pickSlotId: entry.slotId,
          weekStateId: week.id,
          seasonType: week.seasonType,
          weekNumber: week.weekNumber,
          teamId: entry.teamId,
          gameId: entry.gameId,
          submittedAt: now,
          submittedByUserId: input.user.id,
          wasAutoAssigned: false,
        })
        .onConflictDoUpdate({
          target: [selections.pickSlotId, selections.weekStateId],
          set: {
            teamId: entry.teamId,
            gameId: entry.gameId,
            submittedAt: now,
            submittedByUserId: input.user.id,
            wasAutoAssigned: false,
          },
        });
    }

    // Reducing a count removes the surplus pick. That slot is simply blank
    // again and will be auto-assigned at lock like any other (SS5.2).
    if (outcome.result.cleared.length > 0) {
      await tx
        .delete(selections)
        .where(
          and(
            eq(selections.weekStateId, week.id),
            inArray(selections.pickSlotId, outcome.result.cleared),
          ),
        );
    }
  });

  const teamRows = await db.select().from(teams);
  const abbrById = new Map(teamRows.map((team) => [team.id, team.abbreviation]));

  // SS7.1: submitting, editing, and clearing are all logged.
  for (const entry of valid) {
    const previous = existingBySlot.get(entry.slotId);
    if (previous && previous.teamId === entry.teamId && !previous.wasAutoAssigned) continue;

    await recorder.record({
      actorUserId: input.user.id,
      actorRole: input.user.role === "admin" ? "admin" : "player",
      action: previous ? "selection.edit" : "selection.submit",
      targetType: "selection",
      targetId: entry.slotId,
      targetLabel: `${input.user.displayName} — ${entry.slotLabel} — ${week.displayLabel}`,
      beforeJson: previous ? { team: abbrById.get(previous.teamId) } : {},
      afterJson: { team: abbrById.get(entry.teamId) },
      reason: previous ? "Player changed their pick" : "Player submitted a pick",
      selfAffecting: false,
    });
  }

  for (const slotId of outcome.result.cleared) {
    const previous = existingBySlot.get(slotId);
    await recorder.record({
      actorUserId: input.user.id,
      actorRole: input.user.role === "admin" ? "admin" : "player",
      action: "selection.clear",
      targetType: "selection",
      targetId: slotId,
      targetLabel: `${input.user.displayName} — ${slotsById.get(slotId)?.label} — ${week.displayLabel}`,
      beforeJson: previous ? { team: abbrById.get(previous.teamId) } : {},
      afterJson: {},
      reason: "Player removed a pick",
      selfAffecting: false,
    });
  }

  return { ok: true, saved: valid.length, weekLabel: week.displayLabel };
}
