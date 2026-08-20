import { and, eq, inArray, sql } from "drizzle-orm";

import type { AuditRecorder } from "@/lib/audit/port";
import { loadLeague, type LeagueConfig } from "@/lib/config";
import { withTransaction, type Database } from "@/lib/db/client";
import {
  pickSlots,
  selections,
  users,
  weekStates,
  type PickSlotRow,
  type UserRow,
} from "@/lib/db/schema";

import {
  fail,
  ok,
  type BlockingSlot,
  type ProvisionOutcome,
  type ProvisionWarning,
  type Result,
  type RosterEntry,
} from "./types";

/**
 * SS4 -- provisioning picks.
 *
 * Payment happens offsite, so pick slots are created by an admin action rather
 * than at signup. This module is the ONLY thing that writes pick_slot rows for
 * provisioning purposes, and every mutation here emits an audit event through
 * the SS7 port (a no-op until Phase 6 implements the chained writer).
 *
 * The invariant it maintains, for the whole season:
 *
 *     count(pick_slot WHERE user_id = U) == U.picks_purchased
 *
 * counting eliminated slots. Alive and eliminated counts are always derived.
 */

export interface AdminActor {
  actorUserId: string | null;
  actorRole: "admin" | "system";
  /** SS7.6: required, non-empty after trimming, rejected server-side. */
  reason: string;
  /**
   * SS4: required to change picks_purchased after picksFrozenAt. Carries no
   * meaning before the freeze.
   */
  override?: boolean;
}

export interface PicksFreezeState {
  frozen: boolean;
  frozenAt: Date | null;
}

/**
 * SS0 `picksFrozenAt`. "week_1_kickoff" resolves against the week sitting at
 * display_ordinal 1; if no schedule has been synced yet there is no kickoff to
 * be past, so nothing is frozen.
 */
export async function resolvePicksFreeze(
  db: Database,
  config: LeagueConfig,
  seasonYear: number,
  now: Date = new Date(),
): Promise<PicksFreezeState> {
  if (config.picksFrozenAt === "never") {
    return { frozen: false, frozenAt: null };
  }

  const [firstWeek] = await db
    .select({ lockAt: weekStates.lockAt })
    .from(weekStates)
    .where(and(eq(weekStates.seasonYear, seasonYear), eq(weekStates.displayOrdinal, 1)))
    .limit(1);

  if (!firstWeek?.lockAt) {
    return { frozen: false, frozenAt: null };
  }

  return { frozen: now.getTime() >= firstWeek.lockAt.getTime(), frozenAt: firstWeek.lockAt };
}

async function selectionCountsBySlot(
  db: Database,
  slotIds: string[],
): Promise<Map<string, number>> {
  if (slotIds.length === 0) return new Map();

  const rows = await db
    .select({
      pickSlotId: selections.pickSlotId,
      count: sql<number>`count(*)::int`,
    })
    .from(selections)
    .where(inArray(selections.pickSlotId, slotIds))
    .groupBy(selections.pickSlotId);

  return new Map(rows.map((row) => [row.pickSlotId, row.count]));
}

export function slotLabelFor(slotNumber: number): string {
  return `Pick ${slotNumber}`;
}

export interface SetPicksPurchasedInput {
  userId: string;
  picksPurchased: number;
  /** Injectable for tests and for reasoning about the freeze boundary. */
  now?: Date;
}

/**
 * Sets a user's pick count and reconciles their pick_slot rows to match.
 *
 * Idempotent: calling it with the value already in effect changes nothing and
 * emits no audit entry.
 */
export async function setPicksPurchased(
  db: Database,
  input: SetPicksPurchasedInput,
  actor: AdminActor,
  recorder: AuditRecorder,
): Promise<Result<ProvisionOutcome>> {
  const reason = actor.reason.trim();
  if (reason === "") {
    return fail("reason_required", "A non-empty reason is required for every admin action.");
  }

  const now = input.now ?? new Date();

  return withTransaction(db, async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, input.userId)).limit(1);

    if (!user) {
      return fail<ProvisionOutcome>("user_not_found", `No user with id ${input.userId}.`);
    }
    if (user.deactivatedAt) {
      return fail<ProvisionOutcome>(
        "user_deactivated",
        `${user.displayName} is deactivated and cannot be provisioned picks.`,
      );
    }

    const { row: league, config } = await loadLeague(tx);
    const target = input.picksPurchased;

    if (!Number.isInteger(target) || target < 0) {
      return fail<ProvisionOutcome>(
        "picks_negative",
        `picks_purchased must be a non-negative integer, got ${target}.`,
      );
    }
    if (target > config.maxPicksPerUser) {
      return fail<ProvisionOutcome>(
        "exceeds_max",
        `picks_purchased of ${target} exceeds maxPicksPerUser (${config.maxPicksPerUser}). ` +
          `Raise maxPicksPerUser in LEAGUE_CONFIG first.`,
      );
    }

    const existingSlots = await tx
      .select()
      .from(pickSlots)
      .where(eq(pickSlots.userId, user.id))
      .orderBy(pickSlots.slotNumber);

    const current = existingSlots.length;

    // Genuine no-op: nothing to reconcile and nothing to record.
    if (target === current && target === user.picksPurchased) {
      return ok<ProvisionOutcome>({ user, created: [], removed: [], warnings: [] });
    }

    const freeze = await resolvePicksFreeze(tx, config, league.seasonYear, now);
    const warnings: ProvisionWarning[] = [];

    if (freeze.frozen && actor.override !== true) {
      return fail<ProvisionOutcome>(
        "picks_frozen",
        `picks_purchased is frozen as of ${freeze.frozenAt?.toISOString()} ` +
          `(picksFrozenAt: ${config.picksFrozenAt}). An explicit admin override with a typed ` +
          `reason is required, and the change is announced on the League Board.`,
      );
    }

    if (freeze.frozen) {
      warnings.push({
        code: "frozen_override_used",
        message:
          "This change was made after picks were frozen. It is recorded in the public league " +
          "log and raises a persistent banner on the League Board.",
      });
    }

    let created: PickSlotRow[] = [];
    let removed: PickSlotRow[] = [];

    if (target > current) {
      // Never reuse a slot number, even one freed by an earlier reduction: a
      // slot number is an identity, and reusing it would let a removed slot's
      // label collide with a new one in the audit log.
      const highest = existingSlots.reduce((max, slot) => Math.max(max, slot.slotNumber), 0);
      const toCreate = Array.from({ length: target - current }, (_, index) => {
        const slotNumber = highest + index + 1;
        return { userId: user.id, slotNumber, label: slotLabelFor(slotNumber) };
      });

      created = await tx.insert(pickSlots).values(toCreate).returning();

      if (freeze.frozen) {
        warnings.push({
          code: "mid_season_addition",
          message:
            "COMPETITIVE INTEGRITY: these slots are being added mid-season and start alive at " +
            "the current week, having survived no eliminations.",
          slotLabels: created.map((slot) => slot.label),
        });
      }
    } else if (target < current) {
      const counts = await selectionCountsBySlot(
        tx,
        existingSlots.map((slot) => slot.id),
      );

      // SS4: removal may only touch slots that are alive AND have zero
      // selections. Never delete a slot with history.
      const eligible = existingSlots
        .filter((slot) => slot.status === "alive" && (counts.get(slot.id) ?? 0) === 0)
        .sort((a, b) => b.slotNumber - a.slotNumber);

      const needed = current - target;

      if (eligible.length < needed) {
        const blocking: BlockingSlot[] = existingSlots
          .filter((slot) => !eligible.some((e) => e.id === slot.id))
          .sort((a, b) => b.slotNumber - a.slotNumber)
          .map((slot) => ({
            slotId: slot.id,
            label: slot.label,
            reason: slot.status === "eliminated" ? ("eliminated" as const) : ("has_selection_history" as const),
            selectionCount: counts.get(slot.id) ?? 0,
          }));

        return fail<ProvisionOutcome>(
          "reduction_blocked",
          `Cannot reduce ${user.displayName} from ${current} to ${target}: that requires removing ` +
            `${needed} slot(s) but only ${eligible.length} are removable. A slot may only be removed ` +
            `while it is alive and has never been used. Blocked by: ` +
            `${blocking.map((slot) => slot.label).join(", ")}.`,
          blocking,
        );
      }

      const toRemove = eligible.slice(0, needed);
      removed = await tx
        .delete(pickSlots)
        .where(
          inArray(
            pickSlots.id,
            toRemove.map((slot) => slot.id),
          ),
        )
        .returning();
    }

    const [updatedUser] = await tx
      .update(users)
      .set({ picksPurchased: target })
      .where(eq(users.id, user.id))
      .returning();

    await recorder.record(
      {
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
        action: "user.picks_purchased.change",
        targetType: "user",
        targetId: user.id,
        targetLabel: user.displayName,
        beforeJson: {
          picksPurchased: user.picksPurchased,
          slotLabels: existingSlots.map((slot) => slot.label),
        },
        afterJson: {
          picksPurchased: target,
          slotLabels: existingSlots
            .filter((slot) => !removed.some((r) => r.id === slot.id))
            .map((slot) => slot.label)
            .concat(created.map((slot) => slot.label)),
          overrideUsed: freeze.frozen,
        },
        reason,
        selfAffecting: actor.actorRole === "admin" && actor.actorUserId === user.id,
      },
      // Inside the transaction: the entry commits with the change, or not at
      // all. Passing tx also keeps a single-connection pool from deadlocking
      // against itself.
      tx,
    );

    return ok<ProvisionOutcome>({
      user: updatedUser ?? user,
      created,
      removed,
      warnings,
    });
  });
}
