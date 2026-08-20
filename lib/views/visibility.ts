import type { RuleWeek } from "@/lib/rules/types";

/**
 * SS9: "Selections hidden until lock, then fully visible."
 *
 * Acceptance test 22 makes the standard explicit -- other entrants' picks must
 * be ABSENT FROM THE API RESPONSE before lock, not merely undrawn by the UI.
 * So this predicate governs what the queries fetch, not what the components
 * render. A screen cannot leak what was never loaded.
 *
 * Pure, and used identically by every screen.
 */
export type WeekLike = Pick<RuleWeek, "status" | "lockAt">;

export function isWeekRevealed(week: WeekLike, now: Date): boolean {
  // Normally lockWeek (SS8) flips the status and that IS the reveal.
  if (week.status === "locked" || week.status === "grading" || week.status === "graded") {
    return true;
  }

  // But the reveal belongs to the deadline, not to a job. If lock_at has passed
  // and the job is late, picks are already final -- validateSelection has been
  // refusing submissions since that moment -- so keeping them hidden would only
  // punish everyone for a cron hiccup.
  return week.lockAt !== null && now.getTime() >= week.lockAt.getTime();
}

/**
 * Whose selections a viewer may see for a given week. Your own are always
 * yours to look at; everyone else's wait for the lock.
 */
export function canSeeSelection(input: {
  week: WeekLike;
  viewerUserId: string;
  ownerUserId: string;
  now: Date;
}): boolean {
  if (input.viewerUserId === input.ownerUserId) return true;
  return isWeekRevealed(input.week, input.now);
}
