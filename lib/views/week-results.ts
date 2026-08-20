import { and, eq, inArray, sql } from "drizzle-orm";

import { loadLeague } from "@/lib/config";
import type { Database } from "@/lib/db/client";
import {
  games,
  pickSlots,
  selections,
  teams,
  users,
  weekStates,
  type WeekStateRow,
} from "@/lib/db/schema";

import { isWeekRevealed } from "./visibility";

/**
 * SS9 -- Week Results. The week's games with scores, ties flagged, and every
 * selection colour-coded survived / eliminated / void / auto-assigned.
 *
 * Same rule as the League Board: before the week is revealed, other entrants'
 * selections are not fetched at all (acceptance test 22).
 */

export interface ResultSelection {
  userId: string;
  displayName: string;
  slotLabel: string;
  teamId: string;
  result: "pending" | "survived" | "eliminated" | "void";
  wasAutoAssigned: boolean;
  isViewer: boolean;
}

export interface ResultGame {
  gameId: string;
  kickoffAt: Date;
  status: "scheduled" | "in_progress" | "final" | "canceled" | "postponed";
  home: { id: string; abbreviation: string; name: string; score: number | null };
  away: { id: string; abbreviation: string; name: string; score: number | null };
  winnerTeamId: string | null;
  /** SS3: a final with no winner IS a tie, and it eliminates both sides. */
  isTie: boolean;
  selections: ResultSelection[];
}

export interface WeekResultsData {
  week: WeekStateRow;
  weeks: Array<Pick<WeekStateRow, "displayOrdinal" | "displayLabel" | "status">>;
  revealed: boolean;
  gamesInWeek: ResultGame[];
  previousOrdinal: number | null;
  nextOrdinal: number | null;
}

export async function getWeekResults(
  db: Database,
  viewer: { id: string },
  options: { ordinal?: number; now?: Date } = {},
): Promise<WeekResultsData | null> {
  const now = options.now ?? new Date();
  const { row: league } = await loadLeague(db);

  const allWeeks = await db
    .select()
    .from(weekStates)
    .where(eq(weekStates.seasonYear, league.seasonYear))
    .orderBy(weekStates.displayOrdinal);

  // Weeks that have at least started; the Pro Bowl is never among them (SS3.1).
  const playable = allWeeks.filter((week) => week.status !== "skipped");
  const started = playable.filter((week) => week.status !== "upcoming");

  const week =
    options.ordinal !== undefined
      ? playable.find((candidate) => candidate.displayOrdinal === options.ordinal)
      : started.at(-1);

  if (!week) return null;

  const revealed = isWeekRevealed(week, now);

  const gameRows = await db
    .select()
    .from(games)
    .where(eq(games.weekStateId, week.id))
    .orderBy(games.kickoffAt);

  const teamRows = await db.select().from(teams);
  const teamById = new Map(teamRows.map((team) => [team.id, team]));

  const selectionRows = await loadSelections(db, week, viewer.id, revealed);
  const byGame = new Map<string, ResultSelection[]>();
  for (const row of selectionRows) {
    const bucket = byGame.get(row.gameId);
    if (bucket) bucket.push(row.selection);
    else byGame.set(row.gameId, [row.selection]);
  }

  const gamesInWeek: ResultGame[] = gameRows.flatMap((game) => {
    const home = teamById.get(game.homeTeamId);
    const away = teamById.get(game.awayTeamId);
    if (!home || !away) return [];

    return [
      {
        gameId: game.id,
        kickoffAt: game.kickoffAt,
        status: game.status,
        home: { id: home.id, abbreviation: home.abbreviation, name: home.displayName, score: game.homeScore },
        away: { id: away.id, abbreviation: away.abbreviation, name: away.displayName, score: game.awayScore },
        winnerTeamId: game.winnerTeamId,
        isTie: game.status === "final" && game.winnerTeamId === null,
        selections: byGame.get(game.id) ?? [],
      },
    ];
  });

  const index = playable.findIndex((candidate) => candidate.displayOrdinal === week.displayOrdinal);

  return {
    week,
    weeks: playable.map((candidate) => ({
      displayOrdinal: candidate.displayOrdinal,
      displayLabel: candidate.displayLabel,
      status: candidate.status,
    })),
    revealed,
    gamesInWeek,
    previousOrdinal: playable[index - 1]?.displayOrdinal ?? null,
    nextOrdinal:
      playable[index + 1] && playable[index + 1]!.status !== "upcoming"
        ? playable[index + 1]!.displayOrdinal
        : null,
  };
}

async function loadSelections(
  db: Database,
  week: WeekStateRow,
  viewerId: string,
  revealed: boolean,
): Promise<Array<{ gameId: string; selection: ResultSelection }>> {
  const ownSlots = await db
    .select({ id: pickSlots.id })
    .from(pickSlots)
    .where(eq(pickSlots.userId, viewerId));

  if (!revealed && ownSlots.length === 0) return [];

  const rows = await db
    .select({
      gameId: selections.gameId,
      userId: users.id,
      displayName: users.displayName,
      slotLabel: pickSlots.label,
      slotNumber: pickSlots.slotNumber,
      teamId: selections.teamId,
      result: selections.result,
      wasAutoAssigned: selections.wasAutoAssigned,
    })
    .from(selections)
    .innerJoin(pickSlots, eq(pickSlots.id, selections.pickSlotId))
    .innerJoin(users, eq(users.id, pickSlots.userId))
    .where(
      revealed
        ? eq(selections.weekStateId, week.id)
        : and(
            eq(selections.weekStateId, week.id),
            inArray(
              selections.pickSlotId,
              ownSlots.map((slot) => slot.id),
            ),
          ),
    )
    .orderBy(users.displayName, pickSlots.slotNumber);

  return rows.map((row) => ({
    gameId: row.gameId,
    selection: {
      userId: row.userId,
      displayName: row.displayName,
      slotLabel: row.slotLabel,
      teamId: row.teamId,
      result: row.result,
      wasAutoAssigned: row.wasAutoAssigned,
      isViewer: row.userId === viewerId,
    },
  }));
}
