import { describe, expect, it } from "vitest";

import { createEspnProvider, mapStatus } from "@/lib/providers/espn";
import { ProviderError } from "@/lib/providers/types";

import { createFixtureFetch, createFixtureProvider } from "../helpers/espn-fixtures";

/**
 * SS3 -- the ESPN provider, against recorded responses in fixtures/espn/.
 * Never a live call (SS13).
 *
 * Every fixture here is a real recorded response except the postponed one,
 * which is hand-modified and says so in its own _note field: a postponed game
 * cannot be recorded from history, because ESPN rewrites the event to
 * STATUS_FINAL once it is replayed.
 */

describe("SS3.1 postseason week numbering -- CONFIRMED against a real season", () => {
  const provider = createFixtureProvider();

  it("numbers the 2024 postseason 1=Wild Card .. 5=Super Bowl", async () => {
    const counts: number[] = [];
    for (const week of [1, 2, 3, 4, 5]) {
      counts.push((await provider.getWeekGames(2024, 3, week)).length);
    }

    // 6 Wild Card, 4 Divisional, 2 Conference, 1 PRO BOWL, 1 Super Bowl.
    expect(counts).toEqual([6, 4, 2, 1, 1]);
  });

  it("confirms postseason week 4 is the Pro Bowl and is not real football", async () => {
    // The spec told us not to trust this from memory. It is correct: week 4 is
    // the all-star game, and its two "teams" are ESPN ids 31 and 32 (AFC and
    // NFC), which are not NFL franchises at all. That is a second, independent
    // reason the week must never be synced or graded -- syncing it would try to
    // insert games for teams that do not exist in our team table.
    const [proBowl] = await provider.getWeekGames(2024, 3, 4);

    expect(proBowl).toBeDefined();
    expect([proBowl!.homeTeamEspnId, proBowl!.awayTeamEspnId].sort()).toEqual(["31", "32"]);
  });

  it("returns the Super Bowl as a single game between real teams", async () => {
    const [superBowl] = await provider.getWeekGames(2024, 3, 5);

    expect(superBowl).toBeDefined();
    expect(Number(superBowl!.homeTeamEspnId)).toBeLessThan(31);
    expect(Number(superBowl!.awayTeamEspnId)).toBeLessThan(31);
    expect(superBowl!.status).toBe("final");
    expect(superBowl!.winnerTeamEspnId).not.toBeNull();
  });
});

describe("parsing a regular-season week", () => {
  const provider = createFixtureProvider();

  it("reads 14 games, with two teams on bye", async () => {
    const games = await provider.getWeekGames(2024, 2, 5);
    expect(games).toHaveLength(14);

    const playing = new Set(games.flatMap((game) => [game.homeTeamEspnId, game.awayTeamEspnId]));
    expect(playing.size).toBe(28); // 32 teams minus 4 on bye
  });

  it("converts ESPN's string scores into numbers", async () => {
    // ESPN sends "36", not 36. A missed conversion would make every score
    // comparison a string comparison.
    const games = await provider.getWeekGames(2024, 2, 5);
    for (const game of games) {
      expect(typeof game.homeScore).toBe("number");
      expect(typeof game.awayScore).toBe("number");
    }
  });

  it("treats an overtime final as an ordinary final", async () => {
    const games = await provider.getWeekGames(2024, 2, 5);
    expect(games.every((game) => game.status === "final")).toBe(true);
    expect(games.every((game) => game.winnerTeamEspnId !== null)).toBe(true);
  });

  it("parses kickoff times as UTC instants", async () => {
    const games = await provider.getWeekGames(2024, 2, 5);
    for (const game of games) {
      expect(game.kickoffAt.getTime()).toBeGreaterThan(0);
      expect(Number.isNaN(game.kickoffAt.getTime())).toBe(false);
    }
  });
});

describe("tie detection (SS3)", () => {
  it("reports a real tie as a final with no winner", async () => {
    // 2022 week 1, IND @ HOU 20-20: completed, nobody flagged winner, scores
    // level. This is the shape SS5.1 turns into an elimination for BOTH teams.
    const provider = createFixtureProvider();
    const games = await provider.getWeekGames(2022, 2, 1);

    const ties = games.filter((game) => game.status === "final" && game.winnerTeamEspnId === null);
    expect(ties).toHaveLength(1);
    expect(ties[0]!.homeScore).toBe(ties[0]!.awayScore);
    expect(ties[0]!.homeScore).toBe(20);
  });
});

describe("canceled and postponed games", () => {
  it("does NOT mark a canceled game final, despite its state being 'post'", async () => {
    // The trap: BUF @ CIN in 2022 week 17 reports state "post" with completed
    // false. Reading state alone would mark it final and grade picks against a
    // game that was never played.
    const provider = createFixtureProvider();
    const games = await provider.getWeekGames(2022, 2, 17);

    const canceled = games.filter((game) => game.status === "canceled");
    expect(canceled).toHaveLength(1);
    expect(canceled[0]!.homeScore).toBeNull();
    expect(canceled[0]!.winnerTeamEspnId).toBeNull();
  });

  it("maps a postponed game to postponed", async () => {
    const provider = createFixtureProvider({ forceScoreboard: "2022-reg-17-postponed" });
    const games = await provider.getWeekGames(2022, 2, 17);

    const postponed = games.filter((game) => game.status === "postponed");
    expect(postponed).toHaveLength(1);
    expect(postponed[0]!.homeScore).toBeNull();
  });

  it("maps statuses from the raw status type", () => {
    expect(mapStatus({ name: "STATUS_CANCELED", state: "post", completed: false })).toBe("canceled");
    expect(mapStatus({ name: "STATUS_POSTPONED", state: "post", completed: false })).toBe("postponed");
    expect(mapStatus({ name: "STATUS_FINAL", state: "post", completed: true })).toBe("final");
    expect(mapStatus({ name: "STATUS_FINAL_OVERTIME", state: "post", completed: true })).toBe("final");
    expect(mapStatus({ name: "STATUS_IN_PROGRESS", state: "in", completed: false })).toBe("in_progress");
    expect(mapStatus({ name: "STATUS_SCHEDULED", state: "pre", completed: false })).toBe("scheduled");
    // Unrecognised: kept out of grading rather than guessed at.
    expect(mapStatus({ name: "STATUS_WHO_KNOWS", state: "post", completed: false })).toBe("scheduled");
  });
});

describe("teams", () => {
  it("reads all 32 teams", async () => {
    const provider = createFixtureProvider();
    const teams = await provider.getTeams();

    expect(teams).toHaveLength(32);
    expect(new Set(teams.map((team) => team.espnTeamId)).size).toBe(32);
    expect(teams.every((team) => team.logoUrl?.startsWith("https://"))).toBe(true);
  });

  it("does not invent a conference or division", async () => {
    // ESPN's /teams response genuinely has no group data, confirmed against the
    // recorded file. A sync must preserve what it already holds.
    const provider = createFixtureProvider();
    const teams = await provider.getTeams();

    expect(teams.every((team) => team.conference === undefined)).toBe(true);
    expect(teams.every((team) => team.division === undefined)).toBe(true);
  });
});

describe("caching (SS3: at least 60 seconds)", () => {
  it("serves a repeat request from cache", async () => {
    const urls: string[] = [];
    let clock = 0;
    const provider = createEspnProvider({
      fetchImpl: createFixtureFetch({ onRequest: (url) => urls.push(url) }),
      cacheTtlMs: 60_000,
      now: () => clock,
    });

    await provider.getWeekGames(2024, 2, 5);
    await provider.getWeekGames(2024, 2, 5);
    expect(urls).toHaveLength(1);

    clock = 59_000;
    await provider.getWeekGames(2024, 2, 5);
    expect(urls).toHaveLength(1);

    clock = 60_001;
    await provider.getWeekGames(2024, 2, 5);
    expect(urls).toHaveLength(2);
  });

  it("caches each week separately", async () => {
    const urls: string[] = [];
    const provider = createEspnProvider({
      fetchImpl: createFixtureFetch({ onRequest: (url) => urls.push(url) }),
      cacheTtlMs: 60_000,
      now: () => 0,
    });

    await provider.getWeekGames(2024, 3, 1);
    await provider.getWeekGames(2024, 3, 2);
    await provider.getWeekGames(2024, 3, 1);

    expect(urls).toHaveLength(2);
  });
});

describe("failure handling", () => {
  it("throws a ProviderError on a non-200", async () => {
    const provider = createEspnProvider({
      fetchImpl: (async () => new Response("nope", { status: 503 })) as typeof fetch,
    });

    await expect(provider.getWeekGames(2024, 2, 5)).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws when an event has the wrong number of competitors", async () => {
    const provider = createEspnProvider({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            events: [
              { id: "1", date: "2024-10-04T00:15Z", status: { type: { name: "STATUS_FINAL", completed: true } }, competitions: [{ competitors: [{ homeAway: "home", team: { id: "1" } }] }] },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    });

    await expect(provider.getWeekGames(2024, 2, 5)).rejects.toThrow(/competitors/);
  });

  it("returns an empty list for a week with no games rather than throwing", async () => {
    // An unscheduled future round is not an error.
    const provider = createFixtureProvider();
    expect(await provider.getWeekGames(2024, 2, 12)).toEqual([]);
  });
});

describe("request headers", () => {
  it("always sends a User-Agent", async () => {
    // ESPN answers 403 to any request without one, and Node's fetch sends none
    // by default. This failed against the live endpoint while passing every
    // fixture test, so the header is asserted explicitly.
    const seen: Array<RequestInit | undefined> = [];
    const provider = createEspnProvider({
      fetchImpl: createFixtureFetch({ onRequest: (_url, init) => seen.push(init) }),
    });

    await provider.getWeekGames(2024, 2, 5);

    const headers = seen[0]?.headers as Record<string, string> | undefined;
    expect(headers?.["user-agent"]).toBeTruthy();
  });
});
