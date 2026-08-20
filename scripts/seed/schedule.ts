import { SEASON_TYPE } from "@/lib/db/schema/enums";
import { REGULAR_SEASON_WEEKS } from "@/lib/week/ordinal";

import type { Rng } from "./rng";

/**
 * Generates a structurally valid fake NFL season: 272 regular-season games with
 * every team taking exactly one bye between weeks 6 and 14, then a 13-game
 * postseason bracket seeded off the simulated standings.
 *
 * "Structurally valid" is the goal, not schedule-accurate. Matchups are random
 * pairings, so a fixture season may repeat a matchup or skip a divisional one.
 * What it does guarantee -- and what every later phase depends on -- is that
 * each week has a legal set of games, byes make teams unselectable, and the
 * postseason pool shrinks 6 -> 4 -> 2 -> 1 with the Pro Bowl week absent.
 */

export interface FixtureTeam {
  id: string;
  abbreviation: string;
  conference: string;
}

export interface FixtureGame {
  espnEventId: string;
  seasonType: number;
  weekNumber: number;
  displayOrdinal: number;
  kickoffAt: Date;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  /** null means a tie once the game is final -- see SS3 and the game schema. */
  winnerTeamId: string | null;
}

/**
 * Byes are spread across weeks 6-14 and every count is even, so the teams left
 * over always pair up exactly: 4*7 + 2*2 = 32 teams, one bye each.
 */
const BYE_WEEK_COUNTS: ReadonlyArray<{ week: number; teams: number }> = [
  { week: 6, teams: 4 },
  { week: 7, teams: 4 },
  { week: 8, teams: 4 },
  { week: 9, teams: 4 },
  { week: 10, teams: 4 },
  { week: 11, teams: 4 },
  { week: 12, teams: 4 },
  { week: 13, teams: 2 },
  { week: 14, teams: 2 },
];

/**
 * Kickoff slots as UTC instants. These line up with the familiar CT windows
 * (Thu 6:15pm, Sun noon / 3:25 / 7:20pm, Mon 6:15pm) while the league is on
 * daylight time; the fixture does not model the November DST change, because
 * nothing in the rules engine depends on the wall-clock hour -- only on
 * ordering and on which kickoff is earliest in the week.
 */
const SLOTS = {
  thursday: { dayOffset: 0, hour: 23, minute: 15 },
  sundayEarly: { dayOffset: 3, hour: 17, minute: 0 },
  sundayLate: { dayOffset: 3, hour: 20, minute: 25 },
  sundayNight: { dayOffset: 3, hour: 23, minute: 20 },
  monday: { dayOffset: 4, hour: 23, minute: 15 },
} as const;

/** First Thursday of September, which is where an NFL season actually starts. */
export function seasonOpeningThursday(seasonYear: number): Date {
  const september = new Date(Date.UTC(seasonYear, 8, 1));
  const daysUntilThursday = (4 - september.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(seasonYear, 8, 1 + daysUntilThursday));
}

function kickoff(
  openingThursday: Date,
  weekIndex: number,
  slot: { dayOffset: number; hour: number; minute: number },
): Date {
  const base = new Date(openingThursday);
  base.setUTCDate(base.getUTCDate() + weekIndex * 7 + slot.dayOffset);
  base.setUTCHours(slot.hour, slot.minute, 0, 0);
  return base;
}

function slotForGameIndex(index: number, total: number) {
  if (index === 0) return SLOTS.thursday;
  if (index === total - 1) return SLOTS.monday;
  if (index === total - 2) return SLOTS.sundayNight;
  return index % 2 === 0 ? SLOTS.sundayEarly : SLOTS.sundayLate;
}

/** Plausible-looking football scores: a handful of field goals and touchdowns. */
function generateScore(rng: Rng): number {
  const drives = 2 + rng.int(6);
  let points = 0;
  for (let i = 0; i < drives; i += 1) {
    points += rng.next() < 0.45 ? 3 : 7;
  }
  return points;
}

/**
 * Scores never come out tied by accident.
 *
 * Because generated scores are sums of 3s and 7s they collide often -- an
 * earlier version of this produced 15 ties in a season, against a real NFL
 * average of well under one, and since a tie eliminates every pick on both
 * teams (SS5.1) it wiped out half the league in week 1. Ties are a rule that
 * needs testing, not background noise: the season gets exactly one, placed
 * deliberately by generateRegularSeason.
 */
function playScores(rng: Rng): { home: number; away: number } {
  const home = generateScore(rng);
  let away = generateScore(rng);
  // Nudge rather than reroll so the PRNG stream stays aligned between runs.
  while (away === home) away += 3;
  return { home, away };
}

export interface RegularSeasonResult {
  games: FixtureGame[];
  byeTeamsByWeek: Map<number, string[]>;
  winsByTeamId: Map<string, number>;
}

export function generateRegularSeason(
  teams: FixtureTeam[],
  seasonYear: number,
  rng: Rng,
  options: { tieInWeek: number },
): RegularSeasonResult {
  const opening = seasonOpeningThursday(seasonYear);
  const shuffled = rng.shuffle(teams);

  const byeTeamsByWeek = new Map<number, string[]>();
  let cursor = 0;
  for (const { week, teams: count } of BYE_WEEK_COUNTS) {
    byeTeamsByWeek.set(
      week,
      shuffled.slice(cursor, cursor + count).map((team) => team.id),
    );
    cursor += count;
  }

  const games: FixtureGame[] = [];
  const winsByTeamId = new Map<string, number>(teams.map((team) => [team.id, 0]));

  for (let week = 1; week <= REGULAR_SEASON_WEEKS; week += 1) {
    const onBye = new Set(byeTeamsByWeek.get(week) ?? []);
    const active = rng.shuffle(teams.filter((team) => !onBye.has(team.id)));
    const gameCount = active.length / 2;

    for (let i = 0; i < gameCount; i += 1) {
      const first = active[i * 2] as FixtureTeam;
      const second = active[i * 2 + 1] as FixtureTeam;
      const homeIsFirst = rng.bool();
      const home = homeIsFirst ? first : second;
      const away = homeIsFirst ? second : first;

      // The season's single deliberate tie: acceptance test 2 lives or dies on
      // ties being representable end to end, so the fixture must contain one.
      const forceTie = week === options.tieInWeek && i === 0;
      const scores = forceTie ? { home: 20, away: 20 } : playScores(rng);

      const winnerTeamId =
        scores.home === scores.away ? null : scores.home > scores.away ? home.id : away.id;

      if (winnerTeamId) {
        winsByTeamId.set(winnerTeamId, (winsByTeamId.get(winnerTeamId) ?? 0) + 1);
      }

      games.push({
        espnEventId: `fixture-${seasonYear}-2-${week}-${i + 1}`,
        seasonType: SEASON_TYPE.REGULAR,
        weekNumber: week,
        displayOrdinal: week,
        kickoffAt: kickoff(opening, week - 1, slotForGameIndex(i, gameCount)),
        homeTeamId: home.id,
        awayTeamId: away.id,
        homeScore: scores.home,
        awayScore: scores.away,
        winnerTeamId,
      });
    }
  }

  return { games, byeTeamsByWeek, winsByTeamId };
}

/**
 * Postseason slots, again as UTC instants that land on the familiar CT windows:
 * Saturday afternoon and night, Sunday midday/afternoon/night, Monday night.
 * Index 0 is always the earliest kickoff of the round, which is what
 * week_state.lock_at resolves to under lockPolicy "first_kickoff".
 */
const POSTSEASON_SLOTS: ReadonlyArray<{ dayOffset: number; hour: number; minute: number }> = [
  { dayOffset: 2, hour: 21, minute: 30 },
  { dayOffset: 3, hour: 0, minute: 15 },
  { dayOffset: 3, hour: 18, minute: 0 },
  { dayOffset: 3, hour: 21, minute: 30 },
  { dayOffset: 4, hour: 1, minute: 15 },
  { dayOffset: 4, hour: 23, minute: 15 },
];

interface Seeded {
  team: FixtureTeam;
  seed: number;
}

function seedConference(
  teams: FixtureTeam[],
  conference: string,
  winsByTeamId: Map<string, number>,
): Seeded[] {
  return teams
    .filter((team) => team.conference === conference)
    .sort((a, b) => {
      const diff = (winsByTeamId.get(b.id) ?? 0) - (winsByTeamId.get(a.id) ?? 0);
      // Abbreviation is the tiebreak purely so seeding is deterministic.
      return diff !== 0 ? diff : a.abbreviation.localeCompare(b.abbreviation);
    })
    .slice(0, 7)
    .map((team, index) => ({ team, seed: index + 1 }));
}

export interface PostseasonResult {
  games: FixtureGame[];
  playoffTeamIds: Set<string>;
  championId: string;
}

/**
 * Builds the bracket round by round, resolving each round's winners from the
 * generated scores before laying out the next -- so the fixture bracket is
 * internally consistent (a team only appears in the Divisional round if it
 * actually won its Wild Card game).
 *
 * Postseason week 4 is the Pro Bowl and produces no games at all. See SS3.1.
 */
export function generatePostseason(
  teams: FixtureTeam[],
  seasonYear: number,
  rng: Rng,
  winsByTeamId: Map<string, number>,
): PostseasonResult {
  const opening = seasonOpeningThursday(seasonYear);
  const games: FixtureGame[] = [];
  const conferences = ["AFC", "NFC"];
  const seedsByConference = new Map(
    conferences.map((conference) => [conference, seedConference(teams, conference, winsByTeamId)]),
  );

  const playoffTeamIds = new Set(
    [...seedsByConference.values()].flat().map((entry) => entry.team.id),
  );

  let gameCounter = 0;

  const playGame = (
    weekNumber: number,
    home: Seeded,
    away: Seeded,
  ): Seeded => {
    const slot = POSTSEASON_SLOTS[gameCounter % POSTSEASON_SLOTS.length] as (typeof POSTSEASON_SLOTS)[number];
    const scores = playScores(rng);
    const winner = scores.home > scores.away ? home : away;

    games.push({
      espnEventId: `fixture-${seasonYear}-3-${weekNumber}-${gameCounter + 1}`,
      seasonType: SEASON_TYPE.POSTSEASON,
      weekNumber,
      displayOrdinal: REGULAR_SEASON_WEEKS + weekNumber,
      kickoffAt: kickoff(opening, REGULAR_SEASON_WEEKS + weekNumber - 1, slot),
      homeTeamId: home.team.id,
      awayTeamId: away.team.id,
      homeScore: scores.home,
      awayScore: scores.away,
      winnerTeamId: winner.team.id,
    });

    gameCounter += 1;
    return winner;
  };

  // Wild Card (postseason week 1): 2v7, 3v6, 4v5 in each conference; 1 seed byes.
  const divisionalField = new Map<string, Seeded[]>();
  for (const conference of conferences) {
    const seeds = seedsByConference.get(conference) as Seeded[];
    const one = seeds[0] as Seeded;
    const winners = [
      playGame(1, seeds[1] as Seeded, seeds[6] as Seeded),
      playGame(1, seeds[2] as Seeded, seeds[5] as Seeded),
      playGame(1, seeds[3] as Seeded, seeds[4] as Seeded),
    ];
    divisionalField.set(conference, [one, ...winners].sort((a, b) => a.seed - b.seed));
  }

  // Divisional (week 2): top seed draws the lowest surviving seed.
  const conferenceField = new Map<string, Seeded[]>();
  for (const conference of conferences) {
    const field = divisionalField.get(conference) as Seeded[];
    const winners = [
      playGame(2, field[0] as Seeded, field[3] as Seeded),
      playGame(2, field[1] as Seeded, field[2] as Seeded),
    ];
    conferenceField.set(conference, winners.sort((a, b) => a.seed - b.seed));
  }

  // Conference Championship (week 3).
  const finalists: Seeded[] = conferences.map((conference) => {
    const field = conferenceField.get(conference) as Seeded[];
    return playGame(3, field[0] as Seeded, field[1] as Seeded);
  });

  // Week 4 is the Pro Bowl: deliberately no games. SS3.1.

  // Super Bowl (week 5), neutral site; the AFC entrant is nominally "home".
  const champion = playGame(5, finalists[0] as Seeded, finalists[1] as Seeded);

  return { games, playoffTeamIds, championId: champion.team.id };
}
