import { z } from "zod";

/**
 * SS0 -- LEAGUE_CONFIG.
 *
 * This file is the single source of truth for every league setting, its type,
 * and its default. Per SS0, none of these values may be hardcoded anywhere else
 * in the codebase: rules-engine functions take a LeagueConfig, they do not
 * import a constant.
 *
 * On the enum domains: the spec names alternatives for some settings and not
 * others. Each union below contains exactly the values SS0-SS6 actually name --
 * `per_game` appears only in SS5.3, `lockPolicy`'s validation clause, and is
 * included for that reason. Single-member unions (teamReuse, tieResult,
 * missedPick, finalTieRule) are deliberate: they get widened when a phase needs
 * a second value, rather than inventing options now that the rules engine would
 * then have to honour forever.
 */
export const leagueConfigObject = z.strictObject({
  /** Suggested value when an admin provisions a new user. */
  defaultPicksPerUser: z.number().int().min(0).default(10),
  /** Hard ceiling. An admin cannot provision above this without raising it here. */
  maxPicksPerUser: z.number().int().min(1).default(10),
  /**
   * After this point picks_purchased cannot change without an explicit admin
   * override plus a logged reason (SS4). Resolved against the week at ordinal 1;
   * if no schedule has been synced yet, nothing is frozen.
   */
  picksFrozenAt: z.enum(["week_1_kickoff", "never"]).default("week_1_kickoff"),
  /** A pick may use the same team any number of times across the season. */
  teamReuse: z.enum(["unlimited"]).default("unlimited"),
  /** A tie eliminates every pick on BOTH teams. */
  tieResult: z.enum(["eliminate"]).default("eliminate"),
  /** SS5.2 step 1. */
  missedPick: z.enum(["repeat_last_week"]).default("repeat_last_week"),
  /** SS5.2 step 2, applied when repeat-last-week is impossible. */
  missedPickFallback: z.enum(["eliminate", "auto_underdog", "survive"]).default("eliminate"),
  /** ALL picks for the week lock at the earliest kickoff that week. */
  lockPolicy: z.enum(["first_kickoff", "per_game"]).default("first_kickoff"),
  /** SS6, consulted once Week 18 has been graded with 2+ entrants alive. */
  playoffMode: z
    .enum(["continue", "stop_at_regular_season", "admin_decides"])
    .default("continue"),
  /** SS6, when every remaining entrant is eliminated in the same week. */
  wipeoutRule: z.enum(["co_champions", "admin_decides"]).default("co_champions"),
  /** SS6, when multiple entrants survive past the Super Bowl. */
  finalTieRule: z.enum(["co_champions"]).default("co_champions"),
  /**
   * SS7.6. Not listed in the SS0 table but specified as a config flag, so it
   * lives here. When true, any self_affecting admin action enters
   * pending_approval until a different admin approves it.
   */
  requireSecondAdminForSelfActions: z.boolean().default(false),
});

export const leagueConfigSchema = leagueConfigObject.refine(
  (config) => config.defaultPicksPerUser <= config.maxPicksPerUser,
  {
    message: "defaultPicksPerUser cannot exceed maxPicksPerUser",
    path: ["defaultPicksPerUser"],
  },
);

export type LeagueConfig = z.infer<typeof leagueConfigObject>;
/** The shape accepted when writing config: every key optional, unknown keys rejected. */
export type LeagueConfigPatch = Partial<LeagueConfig>;

export const DEFAULT_LEAGUE_CONFIG: LeagueConfig = leagueConfigSchema.parse({});

export const LEAGUE_CONFIG_KEYS = Object.keys(leagueConfigObject.shape) as Array<keyof LeagueConfig>;

export class LeagueConfigError extends Error {
  constructor(
    message: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(message);
    this.name = "LeagueConfigError";
  }
}

/**
 * Parses stored config, applying defaults for keys added since the row was
 * written and failing loudly on keys we do not recognise. A silently ignored
 * unknown key is an admin who thinks they changed a rule and did not.
 */
export function parseLeagueConfig(value: unknown): LeagueConfig {
  const result = leagueConfigSchema.safeParse(value ?? {});

  if (!result.success) {
    throw new LeagueConfigError(
      `Invalid LEAGUE_CONFIG: ${result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
      result.error.issues,
    );
  }

  return result.data;
}
