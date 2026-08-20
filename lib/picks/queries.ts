import { and, eq, inArray, lt, sql } from "drizzle-orm";

import { getLeagueConfig, loadLeague, type LeagueConfig } from "@/lib/config";
import type { Database } from "@/lib/db/client";
import {
  games,
  pickSlots,
  selections,
  teams,
  weekStates,
  type GameRow,
  type PickSlotRow,
  type SelectionRow,
  type TeamRow,
  type UserRow,
  type WeekStateRow,
} from "@/lib/db/schema";
import { autoAssignWeek, type AutoAssignResolution } from "@/lib/rules/auto-assign";
import type { RulePriorSelection } from "@/lib/rules/types";

/**
 * Everything the Make Picks screen needs.
 *
 * IMPORTANT: this loads only the requesting user's selections. Other entrants'
 * picks are not fetched, not serialised, and not sent -- SS9 hides them until
 * lock, and acceptance test 22 requires their absence from the payload rather
 * than a UI that merely declines to draw them. The way to keep that true is to
 * never load them in the first place.
 */

export interface Matchup {
  game: GameRow;
  home: TeamRow;
  away: TeamRow;
}

export interface AutoAssignPreviewEntry {
  resolution: AutoAssignResolution;
  teamId: string | null;
  explanation: string;
}

export interface MakePicksData {
  week: WeekStateRow | null;
  config: LeagueConfig;
  slots: PickSlotRow[];
  matchups: Matchup[];
  teamsById: Record<string, TeamRow>;
  selectionBySlotId: Record<string, SelectionRow>;
  /** slotId -> teamId -> how many times this slot has already used that team. */
  teamUsesBySlot: Record<string, Record<string, number>>;
  /** SS9: what happens to each slot if the user submits nothing. */
  autoAssignPreview: Record<string, AutoAssignPreviewEntry>;
  eliminatedSlots: PickSlotRow[];
}

/** The week currently accepting picks, if any. */
export async function getOpenWeek(db: Database): Promise<WeekStateRow | null> {
  const { row: league } = await loadLeague(db);
  const [week] = await db
    .select()
    .from(weekStates)
    .where(and(eq(weekStates.seasonYear, league.seasonYear), eq(weekStates.status, "open")))
    .orderBy(weekStates.displayOrdinal)
    .limit(1);
  return week ?? null;
}

export async function getMakePicksData(db: Database, user: UserRow): Promise<MakePicksData> {
  const config = await getLeagueConfig(db);
  const week = await getOpenWeek(db);

  const allSlots = await db
    .select()
    .from(pickSlots)
    .where(eq(pickSlots.userId, user.id))
    .orderBy(pickSlots.slotNumber);

  const slots = allSlots.filter((slot) => slot.status === "alive");
  const eliminatedSlots = allSlots.filter((slot) => slot.status === "eliminated");

  const teamRows = await db.select().from(teams);
  const teamsById = Object.fromEntries(teamRows.map((team) => [team.id, team]));

  if (!week) {
    return {
      week: null,
      config,
      slots,
      matchups: [],
      teamsById,
      selectionBySlotId: {},
      teamUsesBySlot: {},
      autoAssignPreview: {},
      eliminatedSlots,
    };
  }

  const weekGames = await db
    .select()
    .from(games)
    .where(eq(games.weekStateId, week.id))
    .orderBy(games.kickoffAt);

  const matchups: Matchup[] = weekGames.flatMap((game) => {
    const home = teamsById[game.homeTeamId];
    const away = teamsById[game.awayTeamId];
    return home && away ? [{ game, home, away }] : [];
  });

  const slotIds = slots.map((slot) => slot.id);

  const mine =
    slotIds.length === 0
      ? []
      : await db
          .select()
          .from(selections)
          .where(
            and(inArray(selections.pickSlotId, slotIds), eq(selections.weekStateId, week.id)),
          );

  const selectionBySlotId = Object.fromEntries(mine.map((row) => [row.pickSlotId, row]));

  return {
    week,
    config,
    slots,
    matchups,
    teamsById,
    selectionBySlotId,
    teamUsesBySlot: await loadTeamUses(db, slotIds),
    autoAssignPreview: await buildAutoAssignPreview(db, { week, config, slots, weekGames }),
    eliminatedSlots,
  };
}

/**
 * SS9: "A small badge shows how many times this slot has already used each
 * team." Informational only -- under teamReuse "unlimited" nothing is blocked.
 */
async function loadTeamUses(
  db: Database,
  slotIds: string[],
): Promise<Record<string, Record<string, number>>> {
  if (slotIds.length === 0) return {};

  const rows = await db
    .select({
      pickSlotId: selections.pickSlotId,
      teamId: selections.teamId,
      n: sql<number>`count(*)::int`,
    })
    .from(selections)
    .where(inArray(selections.pickSlotId, slotIds))
    .groupBy(selections.pickSlotId, selections.teamId);

  const result: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    (result[row.pickSlotId] ??= {})[row.teamId] = row.n;
  }
  return result;
}

/**
 * SS9: "If the user submits nothing, show what will be auto-assigned and why."
 *
 * Runs the real SS5.2 engine over this user's slots, so the preview cannot
 * drift from what lockWeek will actually do.
 */
async function buildAutoAssignPreview(
  db: Database,
  input: { week: WeekStateRow; config: LeagueConfig; slots: PickSlotRow[]; weekGames: GameRow[] },
): Promise<Record<string, AutoAssignPreviewEntry>> {
  const { week, config, slots, weekGames } = input;
  if (slots.length === 0) return {};

  const allWeeks = await db.select().from(weekStates).orderBy(weekStates.displayOrdinal);

  const priorRows = await db
    .select({
      id: selections.id,
      pickSlotId: selections.pickSlotId,
      teamId: selections.teamId,
      gameId: selections.gameId,
      result: selections.result,
      wasAutoAssigned: selections.wasAutoAssigned,
      weekDisplayOrdinal: weekStates.displayOrdinal,
    })
    .from(selections)
    .innerJoin(weekStates, eq(weekStates.id, selections.weekStateId))
    .where(
      and(
        inArray(
          selections.pickSlotId,
          slots.map((slot) => slot.id),
        ),
        lt(weekStates.displayOrdinal, week.displayOrdinal),
      ),
    );

  const result = autoAssignWeek({
    config,
    week,
    weeks: allWeeks,
    games: weekGames,
    aliveSlots: slots,
    // The preview is deliberately computed as if nothing had been submitted.
    selectionsThisWeek: [],
    priorSelections: priorRows as RulePriorSelection[],
  });

  const preview: Record<string, AutoAssignPreviewEntry> = {};

  for (const assignment of result.assignments) {
    preview[assignment.slotId] = {
      resolution: assignment.resolution,
      teamId: assignment.teamId,
      explanation:
        assignment.resolution === "repeat_last_week"
          ? "would repeat your last pick"
          : "would be assigned the biggest underdog",
    };
  }
  for (const elimination of result.eliminations) {
    preview[elimination.slotId] = {
      resolution: "eliminate",
      teamId: null,
      explanation: "would be ELIMINATED — there is no previous pick to repeat",
    };
  }
  for (const slotId of result.survivedWithoutSelection) {
    preview[slotId] = {
      resolution: "survive",
      teamId: null,
      explanation: "would survive with no pick recorded",
    };
  }

  return preview;
}
