import { SEASON_TYPE, type SeasonType } from "@/lib/db/schema/enums";

/**
 * SS2.1 + SS3.1 -- week identity and ordering. Pure, no I/O.
 *
 * week_number resets to 1 in the postseason, so arithmetic on it is always a
 * bug ("the week before postseason week 1" is not week 0, it is Week 18).
 * display_ordinal is the single continuous axis everything sorts and steps
 * along.
 *
 * SS3.1: under seasontype=3 ESPN has historically numbered postseason weeks
 * 1=Wild Card, 2=Divisional, 3=Conference, 4=PRO BOWL, 5=Super Bowl. Week 4 is
 * the all-star game: it gets a real row holding a real ordinal so the axis stays
 * contiguous, is marked 'skipped', and is never opened or graded.
 *
 * This numbering is NOT yet verified. Phase 3 must record a real postseason
 * scoreboard fixture from a completed season and confirm it, per SS3.1.
 */

export const REGULAR_SEASON_WEEKS = 18;

export interface WeekDescriptor {
  seasonType: SeasonType;
  weekNumber: number;
  displayOrdinal: number;
  displayLabel: string;
  /** True only for the Pro Bowl week. Never opens for picks, never graded. */
  skipped: boolean;
}

const POSTSEASON_WEEKS: ReadonlyArray<{ weekNumber: number; label: string; skipped: boolean }> = [
  { weekNumber: 1, label: "Wild Card", skipped: false },
  { weekNumber: 2, label: "Divisional", skipped: false },
  { weekNumber: 3, label: "Conference", skipped: false },
  { weekNumber: 4, label: "Pro Bowl", skipped: true },
  { weekNumber: 5, label: "Super Bowl", skipped: false },
];

export const TOTAL_WEEK_COUNT = REGULAR_SEASON_WEEKS + POSTSEASON_WEEKS.length;

/**
 * Every week of a season in display order: regular 1-18 at ordinals 1-18, then
 * the postseason at 19-23.
 */
export function allWeekDescriptors(): WeekDescriptor[] {
  const regular: WeekDescriptor[] = Array.from({ length: REGULAR_SEASON_WEEKS }, (_, index) => {
    const weekNumber = index + 1;
    return {
      seasonType: SEASON_TYPE.REGULAR,
      weekNumber,
      displayOrdinal: weekNumber,
      displayLabel: `Week ${weekNumber}`,
      skipped: false,
    };
  });

  const postseason: WeekDescriptor[] = POSTSEASON_WEEKS.map((week) => ({
    seasonType: SEASON_TYPE.POSTSEASON,
    weekNumber: week.weekNumber,
    displayOrdinal: REGULAR_SEASON_WEEKS + week.weekNumber,
    displayLabel: week.label,
    skipped: week.skipped,
  }));

  return [...regular, ...postseason];
}

export function describeWeek(seasonType: number, weekNumber: number): WeekDescriptor {
  const found = allWeekDescriptors().find(
    (week) => week.seasonType === seasonType && week.weekNumber === weekNumber,
  );

  if (!found) {
    throw new Error(
      `Unknown week: season_type=${seasonType}, week_number=${weekNumber}. ` +
        `Expected season_type 2 weeks 1-${REGULAR_SEASON_WEEKS} or season_type 3 weeks 1-${POSTSEASON_WEEKS.length}.`,
    );
  }

  return found;
}

export function displayOrdinalFor(seasonType: number, weekNumber: number): number {
  return describeWeek(seasonType, weekNumber).displayOrdinal;
}

export function displayLabelFor(seasonType: number, weekNumber: number): string {
  return describeWeek(seasonType, weekNumber).displayLabel;
}

export function isSkippedWeek(seasonType: number, weekNumber: number): boolean {
  return describeWeek(seasonType, weekNumber).skipped;
}

export function describeWeekByOrdinal(displayOrdinal: number): WeekDescriptor {
  const found = allWeekDescriptors().find((week) => week.displayOrdinal === displayOrdinal);

  if (!found) {
    throw new Error(`Unknown display_ordinal: ${displayOrdinal}. Expected 1-${TOTAL_WEEK_COUNT}.`);
  }

  return found;
}

/**
 * SS5.2's "immediately preceding *played* week", as a pure function over a set
 * of weeks that are playable. Steps down the ordinal axis and skips anything
 * not playable -- the Pro Bowl, and any week voided or skipped for other
 * reasons -- which is what makes the regular/postseason boundary resolve to
 * Week 18 rather than to postseason week 0.
 *
 * Phase 2 supplies the real playability predicate from week_state.status.
 */
export function previousPlayedWeek(
  displayOrdinal: number,
  isPlayable: (week: WeekDescriptor) => boolean,
): WeekDescriptor | null {
  for (let ordinal = displayOrdinal - 1; ordinal >= 1; ordinal -= 1) {
    const candidate = describeWeekByOrdinal(ordinal);
    if (candidate.skipped) continue;
    if (isPlayable(candidate)) return candidate;
  }

  return null;
}
