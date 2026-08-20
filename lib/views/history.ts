import { asc, eq } from "drizzle-orm";

import type { Database } from "@/lib/db/client";
import { games, pickSlots, selections, teams, weekStates, type PickSlotRow } from "@/lib/db/schema";

/**
 * SS9 -- My Picks History. Per slot, the full season trail: week, team,
 * outcome, and an auto-assigned marker where it applies.
 *
 * Only ever the requesting entrant's own slots, so nothing here is subject to
 * the reveal rule.
 */

export interface HistoryEntry {
  displayOrdinal: number;
  weekLabel: string;
  teamAbbreviation: string;
  teamName: string;
  opponentAbbreviation: string | null;
  /** e.g. "17-24" from this pick's point of view, or null before kickoff. */
  scoreLine: string | null;
  gameStatus: "scheduled" | "in_progress" | "final" | "canceled" | "postponed";
  result: "pending" | "survived" | "eliminated" | "void";
  wasAutoAssigned: boolean;
}

export interface HistorySlot {
  slot: PickSlotRow;
  entries: HistoryEntry[];
}

export interface HistoryData {
  slots: HistorySlot[];
  aliveCount: number;
  eliminatedCount: number;
}

export async function getMyPicksHistory(db: Database, userId: string): Promise<HistoryData> {
  const slots = await db
    .select()
    .from(pickSlots)
    .where(eq(pickSlots.userId, userId))
    .orderBy(pickSlots.slotNumber);

  if (slots.length === 0) {
    return { slots: [], aliveCount: 0, eliminatedCount: 0 };
  }

  const rows = await db
    .select({
      pickSlotId: selections.pickSlotId,
      displayOrdinal: weekStates.displayOrdinal,
      weekLabel: weekStates.displayLabel,
      teamId: selections.teamId,
      teamAbbreviation: teams.abbreviation,
      teamName: teams.displayName,
      result: selections.result,
      wasAutoAssigned: selections.wasAutoAssigned,
      homeTeamId: games.homeTeamId,
      awayTeamId: games.awayTeamId,
      homeScore: games.homeScore,
      awayScore: games.awayScore,
      gameStatus: games.status,
    })
    .from(selections)
    .innerJoin(pickSlots, eq(pickSlots.id, selections.pickSlotId))
    .innerJoin(weekStates, eq(weekStates.id, selections.weekStateId))
    .innerJoin(teams, eq(teams.id, selections.teamId))
    .innerJoin(games, eq(games.id, selections.gameId))
    .where(eq(pickSlots.userId, userId))
    .orderBy(asc(weekStates.displayOrdinal));

  const teamRows = await db.select().from(teams);
  const abbrById = new Map(teamRows.map((team) => [team.id, team.abbreviation]));

  const bySlot = new Map<string, HistoryEntry[]>();
  for (const row of rows) {
    const pickedHome = row.homeTeamId === row.teamId;
    const opponentId = pickedHome ? row.awayTeamId : row.homeTeamId;
    const own = pickedHome ? row.homeScore : row.awayScore;
    const other = pickedHome ? row.awayScore : row.homeScore;

    const entry: HistoryEntry = {
      displayOrdinal: row.displayOrdinal,
      weekLabel: row.weekLabel,
      teamAbbreviation: row.teamAbbreviation,
      teamName: row.teamName,
      opponentAbbreviation: abbrById.get(opponentId) ?? null,
      // Written from the picked team's side, so "17-24" always means the pick
      // lost by seven -- which, in this league, is the good outcome.
      scoreLine: own !== null && other !== null ? `${own}-${other}` : null,
      gameStatus: row.gameStatus,
      result: row.result,
      wasAutoAssigned: row.wasAutoAssigned,
    };

    const bucket = bySlot.get(row.pickSlotId);
    if (bucket) bucket.push(entry);
    else bySlot.set(row.pickSlotId, [entry]);
  }

  return {
    slots: slots.map((slot) => ({ slot, entries: bySlot.get(slot.id) ?? [] })),
    aliveCount: slots.filter((slot) => slot.status === "alive").length,
    eliminatedCount: slots.filter((slot) => slot.status === "eliminated").length,
  };
}
