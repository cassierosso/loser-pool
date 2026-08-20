import { eq } from "drizzle-orm";

import type { AuditRecorder } from "@/lib/audit/port";
import { getLeagueConfig, loadLeague } from "@/lib/config";
import { withTransaction, type Database } from "@/lib/db/client";
import {
  games,
  leagues,
  pickSlots,
  selections,
  users,
  weekStates,
  type GameRow,
  type PickSlotRow,
  type SelectionRow,
} from "@/lib/db/schema";

import type { AdminActor } from "./provisioning";
import { fail, ok, type Result } from "./types";

/**
 * SS7.1 + SS9 -- the admin overrides.
 *
 * Every function here is a thing the admin can do to somebody else's game, and
 * the admin is also a competitor. So each one: demands a typed reason, computes
 * self_affecting honestly, and writes exactly one audit entry inside the same
 * transaction as the change (SS7.1 -- no silent paths).
 */

/** SS7.6 guard, applied before any admin mutation takes effect. */
async function guard(
  db: Database,
  actor: AdminActor,
  selfAffecting: boolean,
): Promise<{ ok: true; reason: string } | { ok: false; error: ReturnType<typeof fail> }> {
  const reason = actor.reason.trim();
  if (reason === "") {
    return { ok: false, error: fail("reason_required", "A non-empty reason is required for every admin action.") };
  }

  if (selfAffecting) {
    const config = await getLeagueConfig(db);
    if (config.requireSecondAdminForSelfActions) {
      return {
        ok: false,
        error: fail(
          "second_admin_required",
          "This action affects your own entry, and the league requires a second admin to approve " +
            "those. Ask another admin to make the change.",
        ),
      };
    }
  }

  return { ok: true, reason };
}

/** Does this target belong to the acting admin? SS7.2's self_affecting. */
async function slotBelongsToActor(db: Database, slotId: string, actorUserId: string | null) {
  if (!actorUserId) return false;
  const [slot] = await db.select().from(pickSlots).where(eq(pickSlots.id, slotId)).limit(1);
  return slot?.userId === actorUserId;
}

/**
 * SS7.1: "An admin overrides a game's score, winner, or status."
 * The one that most obviously decides who wins the league.
 */
export async function overrideGameResult(
  db: Database,
  input: {
    gameId: string;
    homeScore?: number | null;
    awayScore?: number | null;
    winnerTeamId?: string | null;
    status?: GameRow["status"];
  },
  actor: AdminActor,
  recorder: AuditRecorder,
): Promise<Result<GameRow>> {
  const check = await guard(db, actor, false);
  if (!check.ok) return check.error as Result<GameRow>;

  const [game] = await db.select().from(games).where(eq(games.id, input.gameId)).limit(1);
  if (!game) return fail("user_not_found", `No game with id ${input.gameId}.`);

  const next = {
    homeScore: input.homeScore !== undefined ? input.homeScore : game.homeScore,
    awayScore: input.awayScore !== undefined ? input.awayScore : game.awayScore,
    winnerTeamId: input.winnerTeamId !== undefined ? input.winnerTeamId : game.winnerTeamId,
    status: input.status ?? game.status,
  };

  return withTransaction(db, async (tx) => {
    const [updated] = await tx
      .update(games)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(games.id, game.id))
      .returning();

    await recorder.record(
      {
        actorUserId: actor.actorUserId,
        actorRole: "admin",
        action: "game.override",
        targetType: "game",
        targetId: game.id,
        targetLabel: `Game ${game.espnEventId} — season type ${game.seasonType}, week ${game.weekNumber}`,
        beforeJson: {
          homeScore: game.homeScore,
          awayScore: game.awayScore,
          winnerTeamId: game.winnerTeamId,
          status: game.status,
        },
        afterJson: next,
        reason: check.reason,
        selfAffecting: false,
      },
      tx,
    );

    return ok(updated ?? game);
  });
}

/** SS7.1: "An admin changes a player's selection (team, or its graded result)." */
export async function overrideSelectionResult(
  db: Database,
  input: { selectionId: string; result?: SelectionRow["result"]; teamId?: string },
  actor: AdminActor,
  recorder: AuditRecorder,
): Promise<Result<SelectionRow>> {
  const [selection] = await db
    .select()
    .from(selections)
    .where(eq(selections.id, input.selectionId))
    .limit(1);
  if (!selection) return fail("user_not_found", `No selection with id ${input.selectionId}.`);

  const selfAffecting = await slotBelongsToActor(db, selection.pickSlotId, actor.actorUserId);
  const check = await guard(db, actor, selfAffecting);
  if (!check.ok) return check.error as Result<SelectionRow>;

  const [slot] = await db
    .select({ label: pickSlots.label, userId: pickSlots.userId })
    .from(pickSlots)
    .where(eq(pickSlots.id, selection.pickSlotId))
    .limit(1);
  const [owner] = slot
    ? await db.select({ name: users.displayName }).from(users).where(eq(users.id, slot.userId))
    : [];

  const next = {
    result: input.result ?? selection.result,
    teamId: input.teamId ?? selection.teamId,
  };

  return withTransaction(db, async (tx) => {
    const [updated] = await tx
      .update(selections)
      .set(next)
      .where(eq(selections.id, selection.id))
      .returning();

    await recorder.record(
      {
        actorUserId: actor.actorUserId,
        actorRole: "admin",
        action: "selection.override",
        targetType: "selection",
        targetId: selection.id,
        targetLabel: `${owner?.name ?? "Unknown"} — ${slot?.label ?? "?"} — season type ${selection.seasonType}, week ${selection.weekNumber}`,
        beforeJson: { result: selection.result, teamId: selection.teamId },
        afterJson: next,
        reason: check.reason,
        selfAffecting,
      },
      tx,
    );

    return ok(updated ?? selection);
  });
}

/** SS7.1: "An admin revives an eliminated pick slot, or eliminates a live one." */
export async function setSlotStatus(
  db: Database,
  input: { slotId: string; status: PickSlotRow["status"] },
  actor: AdminActor,
  recorder: AuditRecorder,
): Promise<Result<PickSlotRow>> {
  const [slot] = await db.select().from(pickSlots).where(eq(pickSlots.id, input.slotId)).limit(1);
  if (!slot) return fail("user_not_found", `No pick slot with id ${input.slotId}.`);

  const selfAffecting = slot.userId === actor.actorUserId;
  const check = await guard(db, actor, selfAffecting);
  if (!check.ok) return check.error as Result<PickSlotRow>;

  const [owner] = await db
    .select({ name: users.displayName })
    .from(users)
    .where(eq(users.id, slot.userId));

  const next =
    input.status === "alive"
      ? {
          status: "alive" as const,
          eliminatedSeasonType: null,
          eliminatedWeek: null,
          eliminatedReason: null,
          eliminatedAt: null,
        }
      : {
          status: "eliminated" as const,
          eliminatedSeasonType: slot.eliminatedSeasonType ?? 2,
          eliminatedWeek: slot.eliminatedWeek ?? 1,
          eliminatedReason: "admin" as const,
          eliminatedAt: new Date(),
        };

  return withTransaction(db, async (tx) => {
    const [updated] = await tx
      .update(pickSlots)
      .set(next)
      .where(eq(pickSlots.id, slot.id))
      .returning();

    await recorder.record(
      {
        actorUserId: actor.actorUserId,
        actorRole: "admin",
        action: input.status === "alive" ? "pick_slot.revive" : "pick_slot.eliminate",
        targetType: "pick_slot",
        targetId: slot.id,
        targetLabel: `${owner?.name ?? "Unknown"} — ${slot.label}`,
        beforeJson: { status: slot.status, eliminatedReason: slot.eliminatedReason },
        afterJson: { status: next.status, eliminatedReason: next.eliminatedReason },
        reason: check.reason,
        selfAffecting,
      },
      tx,
    );

    return ok(updated ?? slot);
  });
}

/** SS6 / SS7.1: "An admin resolves a pending_admin playoff decision." */
export async function resolvePlayoffDecision(
  db: Database,
  input: { choice: "continue" | "stop_at_regular_season" },
  actor: AdminActor,
  recorder: AuditRecorder,
): Promise<Result<{ choice: string }>> {
  const check = await guard(db, actor, false);
  if (!check.ok) return check.error as Result<{ choice: string }>;

  const { row: league, config } = await loadLeague(db);
  if (league.seasonStatus !== "pending_admin") {
    return fail("user_not_found", "There is no pending decision to resolve.");
  }

  return withTransaction(db, async (tx) => {
    await tx
      .update(leagues)
      .set({
        config: { ...config, playoffMode: input.choice },
        seasonStatus: "active",
        updatedAt: new Date(),
      })
      .where(eq(leagues.id, league.id));

    // Reopening is left to the next gradeWeek run, which re-evaluates SS6 with
    // the answer now in place rather than second-guessing it here.
    if (input.choice === "continue") {
      const [nextWeek] = await tx
        .select()
        .from(weekStates)
        .where(eq(weekStates.seasonYear, league.seasonYear))
        .orderBy(weekStates.displayOrdinal);
      void nextWeek;
    }

    await recorder.record(
      {
        actorUserId: actor.actorUserId,
        actorRole: "admin",
        action: "season.playoff_decision",
        targetType: "league",
        targetId: league.id,
        targetLabel: league.name,
        beforeJson: { seasonStatus: "pending_admin", playoffMode: config.playoffMode },
        afterJson: { seasonStatus: "active", playoffMode: input.choice },
        reason: check.reason,
        selfAffecting: false,
      },
      tx,
    );

    return ok({ choice: input.choice });
  });
}
