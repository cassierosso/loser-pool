/**
 * SS11: all times are stored UTC and displayed in America/Chicago.
 *
 * The zone lives here and nowhere else. It is not a LEAGUE_CONFIG setting
 * because SS0 does not list it; if the league ever moves, this is the one line
 * to change.
 */
export const DISPLAY_TIME_ZONE = "America/Chicago";

const kickoffFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIME_ZONE,
  weekday: "long",
  month: "long",
  day: "numeric",
});

/** e.g. "Sun, Oct 6, 12:00 PM CDT" */
export function formatKickoff(date: Date): string {
  return kickoffFormatter.format(date);
}

export function formatDay(date: Date): string {
  return dayFormatter.format(date);
}

/** e.g. "2d 4h 11m" -- for the SS9 countdown to lock. */
export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return "locked";

  const totalMinutes = Math.floor(msRemaining / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
