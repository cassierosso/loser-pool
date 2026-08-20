import type { GameStatus } from "@/lib/rules/types";

/**
 * SS3 -- the provider interface.
 *
 * Nothing outside lib/providers/ may know the shape of an upstream response.
 * The API is undocumented and may change mid-season, and the league needs to be
 * able to swap in a replacement (nflverse games.csv) by writing one new file
 * against this interface and changing which one is constructed.
 *
 * Providers deal in UPSTREAM team ids, never in our internal uuids: mapping
 * those is the sync job's business, not the provider's.
 */

export interface ProviderTeam {
  espnTeamId: string;
  abbreviation: string;
  displayName: string;
  logoUrl: string | null;
  /**
   * ESPN's /teams endpoint does not carry conference or division, so these are
   * optional and a sync must preserve whatever it already holds rather than
   * overwriting with null. Confirmed against a recorded response, not assumed.
   */
  conference?: string;
  division?: string;
}

export interface ProviderGame {
  espnEventId: string;
  seasonYear: number;
  seasonType: number;
  weekNumber: number;
  kickoffAt: Date;
  homeTeamEspnId: string;
  awayTeamEspnId: string;
  homeScore: number | null;
  awayScore: number | null;
  status: GameStatus;
  /** null on a final IS a tie -- see SS3 and the game schema. */
  winnerTeamEspnId: string | null;
}

export interface ScheduleProvider {
  readonly name: string;
  getTeams(): Promise<ProviderTeam[]>;
  getWeekGames(year: number, seasonType: number, week: number): Promise<ProviderGame[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
