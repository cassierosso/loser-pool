import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createEspnProvider } from "@/lib/providers/espn";
import type { ScheduleProvider } from "@/lib/providers/types";

/**
 * SS13: tests run against recorded fixtures, NEVER live ESPN calls.
 *
 * These build the real provider with a fetch that serves recorded responses, so
 * the actual parsing code is what gets exercised -- a hand-written stub would
 * test nothing about whether we read ESPN correctly.
 */

const DIR = fileURLToPath(new URL("../../fixtures/espn/", import.meta.url));

export type FixtureKey =
  | "teams"
  | "2024-post-1"
  | "2024-post-2"
  | "2024-post-3"
  | "2024-post-4"
  | "2024-post-5"
  | "2024-reg-5"
  | "2022-reg-1-tie"
  | "2022-reg-17-canceled"
  | "2022-reg-17-postponed";

const FILES: Record<FixtureKey, string> = {
  teams: "teams.json",
  "2024-post-1": "scoreboard-2024-post-week1.json",
  "2024-post-2": "scoreboard-2024-post-week2.json",
  "2024-post-3": "scoreboard-2024-post-week3.json",
  "2024-post-4": "scoreboard-2024-post-week4.json",
  "2024-post-5": "scoreboard-2024-post-week5.json",
  "2024-reg-5": "scoreboard-2024-reg-week5.json",
  "2022-reg-1-tie": "scoreboard-2022-reg-week1-tie.json",
  "2022-reg-17-canceled": "scoreboard-2022-reg-week17-canceled.json",
  "2022-reg-17-postponed": "scoreboard-2022-reg-week17-postponed-SYNTHETIC.json",
};

export function readFixture(key: FixtureKey): unknown {
  return JSON.parse(readFileSync(DIR + FILES[key], "utf8"));
}

/** Which recorded file answers a given (year, seasonType, week) request. */
function keyForRequest(year: string, seasonType: string, week: string): FixtureKey | null {
  if (year === "2024" && seasonType === "3") {
    const key = `2024-post-${week}` as FixtureKey;
    return key in FILES ? key : null;
  }
  if (year === "2024" && seasonType === "2" && week === "5") return "2024-reg-5";
  if (year === "2022" && seasonType === "2" && week === "1") return "2022-reg-1-tie";
  if (year === "2022" && seasonType === "2" && week === "17") return "2022-reg-17-canceled";
  return null;
}

export interface FixtureFetchOptions {
  /** Serve this file for every scoreboard request, whatever the week. */
  forceScoreboard?: FixtureKey;
  /** Weeks with no recorded fixture answer with an empty event list. */
  emptyForUnknown?: boolean;
  onRequest?: (url: string, init?: RequestInit) => void;
}

export function createFixtureFetch(options: FixtureFetchOptions = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    options.onRequest?.(url, init);

    const parsed = new URL(url);
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (parsed.pathname.endsWith("/teams")) return json(readFixture("teams"));

    const year = parsed.searchParams.get("dates") ?? "";
    const seasonType = parsed.searchParams.get("seasontype") ?? "";
    const week = parsed.searchParams.get("week") ?? "";

    const key = options.forceScoreboard ?? keyForRequest(year, seasonType, week);
    if (key) return json(readFixture(key));

    if (options.emptyForUnknown !== false) return json({ events: [] });

    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

export function createFixtureProvider(options: FixtureFetchOptions = {}): ScheduleProvider {
  return createEspnProvider({
    fetchImpl: createFixtureFetch(options),
    cacheTtlMs: 0,
    // Fixtures are local files; throttling them only slows the suite down.
    minRequestIntervalMs: 0,
  });
}
