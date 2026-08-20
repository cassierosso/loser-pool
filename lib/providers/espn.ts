import type { GameStatus } from "@/lib/rules/types";

import {
  ProviderError,
  type ProviderGame,
  type ProviderTeam,
  type ScheduleProvider,
} from "./types";

/**
 * SS3 -- the ESPN provider. THE ONLY FILE THAT KNOWS ESPN'S RESPONSE SHAPE.
 *
 * Every mapping below was confirmed against recorded responses in
 * fixtures/espn/, not from documentation, because there isn't any. Three things
 * that reading the endpoint casually would get wrong:
 *
 *   1. Scores are STRINGS ("36"), not numbers.
 *   2. A canceled game reports state "post" with completed false. Mapping
 *      state === "post" to final would mark it finished and grade picks against
 *      a game that never happened, so status.type.name is checked FIRST.
 *   3. Overtime finals come back as STATUS_FINAL with detail "Final/OT" rather
 *      than as a distinct status name. STATUS_FINAL_OVERTIME is still accepted
 *      in case it appears elsewhere; both are ordinary finals.
 */

export const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

/**
 * ESPN returns 403 to any request that sends no User-Agent, and Node's fetch
 * sends none by default -- which is why this works from curl and fails from a
 * server. Found by running the job against the live endpoint; no fixture could
 * have caught it. Do not remove: without it every sync fails in production.
 */
export const USER_AGENT = "loser-survivor/1.0 (private NFL pool; contact league admin)";

/** SS3: cache scoreboard responses for at least 60 seconds. */
export const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * ESPN blocks bursts with a 403 that persists for minutes, not seconds.
 *
 * The sync jobs ask for one or two weeks and never notice. A backfill does --
 * replaying a completed season is 22 requests, and doing that flat out gets the
 * caller blocked partway through and left with a half-imported season. Hence a
 * floor on the gap between requests, and a backoff that treats 403 as
 * "slow down" rather than as "give up".
 */
export const DEFAULT_MIN_REQUEST_INTERVAL_MS = 1_200;
export const DEFAULT_MAX_RETRIES = 4;

export interface EspnProviderOptions {
  /** Injectable so tests read recorded fixtures and never touch the network. */
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
  now?: () => number;
  requestTimeoutMs?: number;
  /** Minimum gap between outbound requests. Zero disables throttling. */
  minRequestIntervalMs?: number;
  maxRetries?: number;
  /** Injectable so tests do not actually sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

interface CacheEntry {
  expiresAt: number;
  payload: unknown;
}

/** Only the fields we actually map. Anything else ESPN sends is ignored. */
interface EspnCompetitor {
  homeAway?: string;
  score?: string | number;
  winner?: boolean;
  team?: { id?: string; abbreviation?: string; displayName?: string };
}

interface EspnEvent {
  id?: string;
  date?: string;
  season?: { year?: number; type?: number };
  week?: { number?: number };
  status?: { type?: { state?: string; completed?: boolean; name?: string } };
  competitions?: Array<{ competitors?: EspnCompetitor[] }>;
}

function parseScore(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * SS3's status mapping. Order matters: the explicit names are checked before
 * anything derived from `state`, because a canceled game claims state "post".
 */
export function mapStatus(type: { state?: string; completed?: boolean; name?: string }): GameStatus {
  const name = type.name ?? "";

  if (name === "STATUS_CANCELED") return "canceled";
  if (name === "STATUS_POSTPONED") return "postponed";
  if (type.completed === true) return "final";
  if (type.state === "in") return "in_progress";
  if (type.state === "pre") return "scheduled";

  // A "post" state that is neither completed nor explicitly canceled/postponed
  // is something we do not understand; treating it as scheduled keeps it out of
  // grading until a human or a later sync resolves it.
  return "scheduled";
}

function parseEvent(event: EspnEvent, requestedYear: number, requestedSeasonType: number, requestedWeek: number): ProviderGame {
  const espnEventId = event.id;
  if (!espnEventId) throw new ProviderError("ESPN event is missing an id");

  const competitors = event.competitions?.[0]?.competitors ?? [];
  if (competitors.length !== 2) {
    throw new ProviderError(
      `ESPN event ${espnEventId} has ${competitors.length} competitors; expected 2`,
    );
  }

  const home = competitors.find((competitor) => competitor.homeAway === "home");
  const away = competitors.find((competitor) => competitor.homeAway === "away");
  if (!home?.team?.id || !away?.team?.id) {
    throw new ProviderError(`ESPN event ${espnEventId} is missing a home or away team id`);
  }

  const kickoffAt = new Date(event.date ?? "");
  if (Number.isNaN(kickoffAt.getTime())) {
    throw new ProviderError(`ESPN event ${espnEventId} has an unparseable date: ${event.date}`);
  }

  const status = mapStatus(event.status?.type ?? {});
  const isFinal = status === "final";
  const homeScore = isFinal ? parseScore(home.score) : null;
  const awayScore = isFinal ? parseScore(away.score) : null;

  let winnerTeamEspnId: string | null = null;
  if (isFinal) {
    const flagged = competitors.find((competitor) => competitor.winner === true);
    if (flagged?.team?.id) {
      winnerTeamEspnId = flagged.team.id;
    } else if (homeScore !== null && awayScore !== null && homeScore !== awayScore) {
      // Completed, nobody flagged as winner, but the scores are not level. That
      // is not a tie -- it is ESPN being inconsistent. Deriving the winner from
      // the scoreboard is far safer than recording a tie, which would eliminate
      // every pick on both teams.
      winnerTeamEspnId = homeScore > awayScore ? home.team.id : away.team.id;
    }
    // Otherwise the winner stays null, which IS the tie (SS3).
  }

  return {
    espnEventId,
    seasonYear: event.season?.year ?? requestedYear,
    seasonType: event.season?.type ?? requestedSeasonType,
    weekNumber: event.week?.number ?? requestedWeek,
    kickoffAt,
    homeTeamEspnId: home.team.id,
    awayTeamEspnId: away.team.id,
    homeScore,
    awayScore,
    status,
    winnerTeamEspnId,
  };
}

export function createEspnProvider(options: EspnProviderOptions = {}): ScheduleProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.requestTimeoutMs ?? 15_000;
  const minInterval = options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep =
    options.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cache = new Map<string, CacheEntry>();

  /** Serialises outbound requests and keeps them a minimum interval apart. */
  let queue: Promise<unknown> = Promise.resolve();
  // Negative infinity so the FIRST request goes out immediately; the interval
  // is a gap between requests, not a delay before starting.
  let lastRequestAt = Number.NEGATIVE_INFINITY;

  async function throttled<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
      const wait = minInterval - (now() - lastRequestAt);
      if (wait > 0) await sleep(wait);
      lastRequestAt = now();
      return work();
    });
    // Keep the chain alive even when a request rejects.
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function fetchOnce(url: string): Promise<Response> {
    try {
      return await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json", "user-agent": USER_AGENT },
      });
    } catch (error) {
      throw new ProviderError(`ESPN request failed: ${url}`, error);
    }
  }

  async function getJson(url: string): Promise<unknown> {
    const cached = cache.get(url);
    if (cached && cached.expiresAt > now()) return cached.payload;

    let lastStatus = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await throttled(() => fetchOnce(url));

      if (response.ok) {
        const payload = (await response.json()) as unknown;
        cache.set(url, { expiresAt: now() + ttl, payload });
        return payload;
      }

      lastStatus = response.status;

      // 403 is ESPN's rate limit as well as its refusal, and 429 is explicit.
      // Anything else is a real failure and retrying only wastes time.
      const retryable = response.status === 403 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxRetries) break;

      await sleep(minInterval * 2 ** (attempt + 1));
    }

    throw new ProviderError(
      `ESPN returned ${lastStatus} for ${url}` +
        (lastStatus === 403 ? " (rate limited; slow the request rate down)" : ""),
    );
  }

  return {
    name: "espn",

    async getTeams(): Promise<ProviderTeam[]> {
      const payload = (await getJson(`${ESPN_BASE}/teams?limit=50`)) as {
        sports?: Array<{ leagues?: Array<{ teams?: Array<{ team?: Record<string, unknown> }> }> }>;
      };

      const entries = payload.sports?.[0]?.leagues?.[0]?.teams ?? [];
      if (entries.length === 0) throw new ProviderError("ESPN /teams returned no teams");

      return entries.map((entry) => {
        const team = entry.team ?? {};
        const id = team["id"];
        const abbreviation = team["abbreviation"];
        const displayName = team["displayName"];
        if (typeof id !== "string" || typeof abbreviation !== "string" || typeof displayName !== "string") {
          throw new ProviderError(`ESPN team entry is missing id/abbreviation/displayName`);
        }
        const logos = team["logos"];
        const href = Array.isArray(logos) ? (logos[0] as { href?: string } | undefined)?.href : undefined;

        // conference/division are deliberately absent: SS3's /teams response
        // does not carry them, so the sync preserves what it already holds.
        return { espnTeamId: id, abbreviation, displayName, logoUrl: href ?? null };
      });
    },

    async getWeekGames(year: number, seasonType: number, week: number): Promise<ProviderGame[]> {
      const url = `${ESPN_BASE}/scoreboard?dates=${year}&seasontype=${seasonType}&week=${week}`;
      const payload = (await getJson(url)) as { events?: EspnEvent[] };
      const events = payload.events ?? [];

      // SS3: teams absent from a week's scoreboard are on bye. An empty week is
      // not automatically an error -- it is what an unscheduled future round
      // looks like -- so it is returned as an empty list, not thrown.
      return events.map((event) => parseEvent(event, year, seasonType, week));
    },
  };
}
