import { describe, expect, it } from "vitest";

import { canSeeSelection, isWeekRevealed, type WeekLike } from "@/lib/views/visibility";

/**
 * SS9 / acceptance test 22 -- who may see whose picks, and when.
 */

const NOW = new Date("2024-10-06T12:00:00Z");
const LOCK = new Date("2024-10-06T17:00:00Z");
const AFTER_LOCK = new Date("2024-10-06T17:00:01Z");

const week = (overrides: Partial<WeekLike> = {}): WeekLike => ({
  status: "open",
  lockAt: LOCK,
  ...overrides,
});

describe("isWeekRevealed", () => {
  it("hides an open week before its lock time", () => {
    expect(isWeekRevealed(week(), NOW)).toBe(false);
  });

  it("reveals a week once it has been locked", () => {
    expect(isWeekRevealed(week({ status: "locked" }), NOW)).toBe(true);
  });

  it("reveals a graded week", () => {
    expect(isWeekRevealed(week({ status: "graded" }), NOW)).toBe(true);
    expect(isWeekRevealed(week({ status: "grading" }), NOW)).toBe(true);
  });

  it("reveals once lock_at has passed even if the lock job has not run", () => {
    // Submissions have been refused since that instant, so continuing to hide
    // picks would punish the league for a late cron run.
    expect(isWeekRevealed(week({ status: "open" }), AFTER_LOCK)).toBe(true);
  });

  it("keeps an unscheduled week hidden", () => {
    expect(isWeekRevealed(week({ status: "upcoming", lockAt: null }), AFTER_LOCK)).toBe(false);
  });
});

describe("canSeeSelection", () => {
  it("always lets an entrant see their own pick", () => {
    expect(
      canSeeSelection({ week: week(), viewerUserId: "dana", ownerUserId: "dana", now: NOW }),
    ).toBe(true);
  });

  it("hides another entrant's pick before lock", () => {
    expect(
      canSeeSelection({ week: week(), viewerUserId: "dana", ownerUserId: "marcus", now: NOW }),
    ).toBe(false);
  });

  it("shows another entrant's pick after lock", () => {
    expect(
      canSeeSelection({
        week: week({ status: "locked" }),
        viewerUserId: "dana",
        ownerUserId: "marcus",
        now: NOW,
      }),
    ).toBe(true);
  });
});
