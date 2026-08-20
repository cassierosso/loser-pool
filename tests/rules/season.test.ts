import { describe, expect, it } from "vitest";

import { evaluateSeasonEnd, nextPlayableWeek, type EntrantState } from "@/lib/rules/season";

import { config, week, weeks } from "../helpers/fixtures";

/**
 * SS6 -- how the season ends. Acceptance tests 17, 18 and 19.
 */

const entrant = (userId: string, aliveSlotCount: number): EntrantState => ({
  userId,
  aliveSlotCount,
});

const gradedThrough = (ordinal: number) =>
  Object.fromEntries(Array.from({ length: ordinal }, (_, i) => [i + 1, "graded" as const]));

describe("evaluateSeasonEnd (SS6)", () => {
  it("closes the season on a single survivor and opens no postseason week", () => {
    // Acceptance test 17: grading Week 18 with exactly one surviving entrant.
    const result = evaluateSeasonEnd({
      config: config({ playoffMode: "continue" }),
      gradedWeek: week(18, { status: "graded" }),
      weeks: weeks(gradedThrough(18)),
      entrantsAfter: [entrant("dana", 2), entrant("marcus", 0), entrant("priya", 0)],
      entrantsEnteringWeek: [entrant("dana", 3), entrant("marcus", 1), entrant("priya", 2)],
    });

    expect(result.outcome).toMatchObject({ kind: "champion", userIds: ["dana"] });
  });

  it("closes the season mid-postseason as soon as one entrant is left", () => {
    const result = evaluateSeasonEnd({
      config: config(),
      gradedWeek: week(19, { status: "graded" }),
      weeks: weeks(gradedThrough(19)),
      entrantsAfter: [entrant("dana", 1), entrant("marcus", 0)],
      entrantsEnteringWeek: [entrant("dana", 1), entrant("marcus", 2)],
    });

    expect(result.outcome.kind).toBe("champion");
  });

  it("opens the Wild Card round when several survive Week 18 under playoffMode: continue", () => {
    // Acceptance test 18.
    const result = evaluateSeasonEnd({
      config: config({ playoffMode: "continue" }),
      gradedWeek: week(18, { status: "graded" }),
      weeks: weeks(gradedThrough(18)),
      entrantsAfter: [entrant("dana", 2), entrant("marcus", 1), entrant("priya", 3)],
      entrantsEnteringWeek: [entrant("dana", 3), entrant("marcus", 2), entrant("priya", 4)],
    });

    expect(result.outcome).toMatchObject({ kind: "open_week" });
    if (result.outcome.kind !== "open_week") return;
    expect(result.outcome.week.displayLabel).toBe("Wild Card");
    expect(result.outcome.week.displayOrdinal).toBe(19);
  });

  it("applies the wipeout rule when everyone dies in the same week", () => {
    // Acceptance test 19: co-champions are whoever entered the week alive.
    const result = evaluateSeasonEnd({
      config: config({ wipeoutRule: "co_champions" }),
      gradedWeek: week(18, { status: "graded" }),
      weeks: weeks(gradedThrough(18)),
      entrantsAfter: [entrant("dana", 0), entrant("marcus", 0), entrant("priya", 0)],
      entrantsEnteringWeek: [entrant("dana", 1), entrant("marcus", 2), entrant("priya", 0)],
    });

    expect(result.outcome).toMatchObject({
      kind: "co_champions",
      cause: "wipeout",
      // priya was already out before the week began, so shares nothing.
      userIds: ["dana", "marcus"],
    });
  });

  it("freezes for the admin when wipeoutRule is admin_decides", () => {
    const result = evaluateSeasonEnd({
      config: config({ wipeoutRule: "admin_decides" }),
      gradedWeek: week(12, { status: "graded" }),
      weeks: weeks(gradedThrough(12)),
      entrantsAfter: [entrant("dana", 0), entrant("marcus", 0)],
      entrantsEnteringWeek: [entrant("dana", 1), entrant("marcus", 1)],
    });

    expect(result.outcome).toMatchObject({ kind: "pending_admin", question: "wipeout" });
  });

  it("opens the next regular-season week in the ordinary case", () => {
    const result = evaluateSeasonEnd({
      config: config(),
      gradedWeek: week(9, { status: "graded" }),
      weeks: weeks(gradedThrough(9)),
      entrantsAfter: [entrant("dana", 4), entrant("marcus", 2)],
      entrantsEnteringWeek: [entrant("dana", 5), entrant("marcus", 3)],
    });

    expect(result.outcome).toMatchObject({ kind: "open_week" });
    if (result.outcome.kind !== "open_week") return;
    expect(result.outcome.week.displayOrdinal).toBe(10);
  });

  it("steps over the Pro Bowl when opening the round after the Conference Championship", () => {
    // SS3.1 -- the all-star game is never opened for picks.
    const result = evaluateSeasonEnd({
      config: config(),
      gradedWeek: week(21, { status: "graded" }),
      weeks: weeks(gradedThrough(21)),
      entrantsAfter: [entrant("dana", 1), entrant("marcus", 1)],
      entrantsEnteringWeek: [entrant("dana", 2), entrant("marcus", 1)],
    });

    expect(result.outcome).toMatchObject({ kind: "open_week" });
    if (result.outcome.kind !== "open_week") return;
    expect(result.outcome.week.displayLabel).toBe("Super Bowl");
  });

  it("stops at the regular season and ranks by surviving picks when told to", () => {
    const result = evaluateSeasonEnd({
      config: config({ playoffMode: "stop_at_regular_season" }),
      gradedWeek: week(18, { status: "graded" }),
      weeks: weeks(gradedThrough(18)),
      entrantsAfter: [entrant("dana", 2), entrant("marcus", 5), entrant("priya", 5)],
      entrantsEnteringWeek: [entrant("dana", 3), entrant("marcus", 6), entrant("priya", 6)],
    });

    expect(result.outcome).toMatchObject({
      kind: "co_champions",
      cause: "regular_season_stop",
      userIds: ["marcus", "priya"],
    });
  });

  it("freezes for the admin when playoffMode is admin_decides, opening nothing", () => {
    const result = evaluateSeasonEnd({
      config: config({ playoffMode: "admin_decides" }),
      gradedWeek: week(18, { status: "graded" }),
      weeks: weeks(gradedThrough(18)),
      entrantsAfter: [entrant("dana", 2), entrant("marcus", 1)],
      entrantsEnteringWeek: [entrant("dana", 3), entrant("marcus", 2)],
    });

    expect(result.outcome).toMatchObject({ kind: "pending_admin", question: "playoff_mode" });
  });

  it("declares co-champions when several survive the Super Bowl", () => {
    const result = evaluateSeasonEnd({
      config: config(),
      gradedWeek: week(23, { status: "graded" }),
      weeks: weeks(gradedThrough(23)),
      entrantsAfter: [entrant("dana", 1), entrant("marcus", 3), entrant("priya", 3)],
      entrantsEnteringWeek: [entrant("dana", 2), entrant("marcus", 4), entrant("priya", 4)],
    });

    expect(result.outcome).toMatchObject({
      kind: "co_champions",
      cause: "final_tie",
      userIds: ["marcus", "priya"],
    });
  });

  it("records an audit entry for every outcome", () => {
    // SS7.1: no silent paths.
    const result = evaluateSeasonEnd({
      config: config(),
      gradedWeek: week(9, { status: "graded" }),
      weeks: weeks(gradedThrough(9)),
      entrantsAfter: [entrant("dana", 4), entrant("marcus", 2)],
      entrantsEnteringWeek: [entrant("dana", 5), entrant("marcus", 3)],
    });

    expect(result.auditEntries).toHaveLength(1);
    expect(result.auditEntries[0]).toMatchObject({ actorRole: "system", targetType: "league" });
  });
});

describe("nextPlayableWeek", () => {
  it("never returns the Pro Bowl", () => {
    expect(nextPlayableWeek(weeks(), 21)?.displayOrdinal).toBe(23);
  });

  it("returns null after the Super Bowl", () => {
    expect(nextPlayableWeek(weeks(), 23)).toBeNull();
  });
});
