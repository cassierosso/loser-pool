import { describe, expect, it } from "vitest";

import {
  DEFAULT_LEAGUE_CONFIG,
  LEAGUE_CONFIG_KEYS,
  LeagueConfigError,
  parseLeagueConfig,
} from "@/lib/config/schema";

describe("LEAGUE_CONFIG (SS0)", () => {
  it("defaults match the spec table", () => {
    expect(DEFAULT_LEAGUE_CONFIG).toEqual({
      defaultPicksPerUser: 10,
      maxPicksPerUser: 10,
      picksFrozenAt: "week_1_kickoff",
      teamReuse: "unlimited",
      tieResult: "eliminate",
      missedPick: "repeat_last_week",
      missedPickFallback: "eliminate",
      lockPolicy: "first_kickoff",
      playoffMode: "continue",
      wipeoutRule: "co_champions",
      finalTieRule: "co_champions",
      requireSecondAdminForSelfActions: false,
    });
  });

  it("fills defaults for keys missing from a stored config", () => {
    const parsed = parseLeagueConfig({ maxPicksPerUser: 4, defaultPicksPerUser: 4 });
    expect(parsed.maxPicksPerUser).toBe(4);
    expect(parsed.playoffMode).toBe("continue");
    expect(Object.keys(parsed).sort()).toEqual([...LEAGUE_CONFIG_KEYS].sort());
  });

  it("rejects an unknown key rather than silently ignoring it", () => {
    // An ignored key is an admin who believes they changed a rule and did not.
    expect(() => parseLeagueConfig({ tieRseult: "survive" })).toThrow(LeagueConfigError);
  });

  it("rejects a value outside a setting's domain", () => {
    expect(() => parseLeagueConfig({ playoffMode: "whatever" })).toThrow(LeagueConfigError);
  });

  it("rejects a default pick count above the ceiling", () => {
    expect(() => parseLeagueConfig({ defaultPicksPerUser: 12, maxPicksPerUser: 10 })).toThrow(
      LeagueConfigError,
    );
  });
});
