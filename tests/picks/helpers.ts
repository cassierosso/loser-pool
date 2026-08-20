import { eq } from "drizzle-orm";

import type { Database } from "@/lib/db/client";
import {
  games,
  pickSlots,
  selections,
  users,
  weekStates,
  type GameRow,
  type TeamRow,
  type UserRow,
  type WeekStateRow,
} from "@/lib/db/schema";

import { TEST_SEASON_YEAR } from "../helpers/db";

export const KICKOFF = new Date("2024-10-06T17:00:00Z");
export const BEFORE_LOCK = new Date("2024-10-06T16:00:00Z");
export const AFTER_LOCK = new Date("2024-10-06T17:00:01Z");

export async function openWeekWithGames(
  db: Database,
  teamRows: TeamRow[],
  ordinal = 5,
): Promise<{ week: WeekStateRow; weekGames: GameRow[] }> {
  await db
    .update(weekStates)
    .set({ status: "open", lockAt: KICKOFF })
    .where(eq(weekStates.displayOrdinal, ordinal));

  const [week] = await db.select().from(weekStates).where(eq(weekStates.displayOrdinal, ordinal));

  const weekGames = await db
    .insert(games)
    .values(
      [
        [0, 1],
        [2, 3],
        [4, 5],
      ].map(([home, away], index) => ({
        espnEventId: `evt-${ordinal}-${index}`,
        seasonYear: TEST_SEASON_YEAR,
        seasonType: week!.seasonType,
        weekNumber: week!.weekNumber,
        weekStateId: week!.id,
        kickoffAt: new Date(KICKOFF.getTime() + index * 3600_000),
        homeTeamId: teamRows[home!]!.id,
        awayTeamId: teamRows[away!]!.id,
      })),
    )
    .returning();

  return { week: week!, weekGames };
}

export async function addEntrant(
  db: Database,
  name: string,
  slotCount: number,
  overrides: Partial<UserRow> = {},
) {
  const [user] = await db
    .insert(users)
    .values({
      email: `${name}@example.com`,
      displayName: name,
      picksPurchased: slotCount,
      ...overrides,
    })
    .returning();

  const slots =
    slotCount === 0
      ? []
      : await db
          .insert(pickSlots)
          .values(
            Array.from({ length: slotCount }, (_, index) => ({
              userId: user!.id,
              slotNumber: index + 1,
              label: `Pick ${index + 1}`,
            })),
          )
          .returning();

  return { user: user!, slots };
}

export async function addSelection(
  db: Database,
  input: {
    slotId: string;
    week: WeekStateRow;
    teamId: string;
    gameId: string;
    userId: string;
    wasAutoAssigned?: boolean;
  },
) {
  const [row] = await db
    .insert(selections)
    .values({
      pickSlotId: input.slotId,
      weekStateId: input.week.id,
      seasonType: input.week.seasonType,
      weekNumber: input.week.weekNumber,
      teamId: input.teamId,
      gameId: input.gameId,
      submittedByUserId: input.userId,
      wasAutoAssigned: input.wasAutoAssigned ?? false,
    })
    .returning();
  return row!;
}
