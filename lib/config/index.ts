import { eq } from "drizzle-orm";

import type { AuditRecorder } from "@/lib/audit/port";
import type { Database } from "@/lib/db/client";
import { leagues, type LeagueRow } from "@/lib/db/schema";

import {
  DEFAULT_LEAGUE_CONFIG,
  leagueConfigSchema,
  parseLeagueConfig,
  type LeagueConfig,
  type LeagueConfigPatch,
} from "./schema";

export * from "./schema";

export class LeagueNotFoundError extends Error {
  constructor() {
    super("No league row exists. Run `npm run db:seed` to create one.");
    this.name = "LeagueNotFoundError";
  }
}

export interface LoadedLeague {
  row: LeagueRow;
  config: LeagueConfig;
}

/** SS12: exactly one league per deployment, enforced by the schema. */
export async function loadLeague(db: Database): Promise<LoadedLeague> {
  const [row] = await db.select().from(leagues).limit(1);

  if (!row) throw new LeagueNotFoundError();

  return { row, config: parseLeagueConfig(row.config) };
}

export async function getLeagueConfig(db: Database): Promise<LeagueConfig> {
  return (await loadLeague(db)).config;
}

export interface AdminActionContext {
  actorUserId: string | null;
  actorRole: "admin" | "system";
  /** SS7.6: mandatory, non-empty after trimming, no default text. */
  reason: string;
}

/**
 * SS7.1: an admin editing LEAGUE_CONFIG is a logged action. The whole config
 * object goes into before/after, not just the changed key, so the log reads as
 * a full state transition.
 */
export async function updateLeagueConfig(
  db: Database,
  patch: LeagueConfigPatch,
  context: AdminActionContext,
  recorder: AuditRecorder,
): Promise<LeagueConfig> {
  const reason = context.reason.trim();
  if (reason === "") {
    throw new Error("A non-empty reason is required to change LEAGUE_CONFIG.");
  }

  const { row, config } = await loadLeague(db);
  const next = leagueConfigSchema.parse({ ...config, ...patch });

  await db
    .update(leagues)
    .set({ config: next, updatedAt: new Date() })
    .where(eq(leagues.id, row.id));

  await recorder.record({
    actorUserId: context.actorUserId,
    actorRole: context.actorRole,
    action: "league.config.change",
    targetType: "league",
    targetId: row.id,
    targetLabel: row.name,
    beforeJson: { config },
    afterJson: { config: next },
    reason,
    selfAffecting: false,
  });

  return next;
}

export { DEFAULT_LEAGUE_CONFIG };
