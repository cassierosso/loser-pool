import { describe, expect, it } from "vitest";

import {
  allWeekDescriptors,
  describeWeekByOrdinal,
  displayOrdinalFor,
  isSkippedWeek,
  previousPlayedWeek,
  REGULAR_SEASON_WEEKS,
  TOTAL_WEEK_COUNT,
} from "@/lib/week/ordinal";

const alwaysPlayable = () => true;

describe("week identity (SS2.1) and postseason numbering (SS3.1)", () => {
  it("lays 23 weeks on a contiguous, unique ordinal axis", () => {
    const weeks = allWeekDescriptors();
    expect(weeks).toHaveLength(TOTAL_WEEK_COUNT);
    expect(weeks.map((week) => week.displayOrdinal)).toEqual(
      Array.from({ length: TOTAL_WEEK_COUNT }, (_, i) => i + 1),
    );
  });

  it("does not let postseason week numbers collide with regular season ones", () => {
    // Both are "week 1". Only the ordinal tells them apart.
    expect(displayOrdinalFor(2, 1)).toBe(1);
    expect(displayOrdinalFor(3, 1)).toBe(19);
  });

  it("labels the postseason rounds", () => {
    expect(describeWeekByOrdinal(19).displayLabel).toBe("Wild Card");
    expect(describeWeekByOrdinal(20).displayLabel).toBe("Divisional");
    expect(describeWeekByOrdinal(21).displayLabel).toBe("Conference");
    expect(describeWeekByOrdinal(23).displayLabel).toBe("Super Bowl");
  });

  it("marks postseason week 4 (the Pro Bowl) skipped", () => {
    // SS3.1 -- acceptance test 20.
    expect(isSkippedWeek(3, 4)).toBe(true);
    expect(describeWeekByOrdinal(22).displayLabel).toBe("Pro Bowl");
    expect(allWeekDescriptors().filter((week) => week.skipped)).toHaveLength(1);
  });

  it("steps over the Pro Bowl when looking up the previous played week", () => {
    // Acceptance test 20: the Super Bowl's previous week is the Conference
    // Championship, not the all-star game.
    expect(previousPlayedWeek(23, alwaysPlayable)?.displayLabel).toBe("Conference");
  });

  it("resolves the previous week across the season-type boundary to Week 18", () => {
    // Acceptance test 21: NOT postseason week 0.
    const previous = previousPlayedWeek(19, alwaysPlayable);
    expect(previous?.seasonType).toBe(2);
    expect(previous?.weekNumber).toBe(REGULAR_SEASON_WEEKS);
    expect(previous?.displayLabel).toBe("Week 18");
  });

  it("skips weeks the caller reports as unplayable", () => {
    const previous = previousPlayedWeek(19, (week) => week.displayOrdinal < 17);
    expect(previous?.displayOrdinal).toBe(16);
  });

  it("returns null when nothing precedes the week", () => {
    // Week 1 has no prior selection to repeat -- SS5.2 falls back.
    expect(previousPlayedWeek(1, alwaysPlayable)).toBeNull();
  });

  it("refuses to describe a week that does not exist", () => {
    expect(() => displayOrdinalFor(3, 6)).toThrow();
    expect(() => displayOrdinalFor(2, 19)).toThrow();
  });
});
