import { eq, sql } from "drizzle-orm";

import type { AuditRecorder } from "@/lib/audit/port";
import type { Database } from "@/lib/db/client";
import { pickSlots, users, type UserRow } from "@/lib/db/schema";

import { fail, ok, type Result, type RosterEntry } from "./types";
import type { AdminActor } from "./provisioning";

/**
 * SS4 / SS7.1. User records and the admin's reconciliation view.
 *
 * Payment is collected offsite; payment_status and payment_note exist purely so
 * the admin can reconcile this table against however they actually took money.
 * Changing either is a logged admin action.
 */

export interface CreateUserInput {
  email: string;
  displayName: string;
  role?: UserRow["role"];
  paymentStatus?: UserRow["paymentStatus"];
  paymentNote?: string | null;
}

export async function createUser(
  db: Database,
  input: CreateUserInput,
  actor: AdminActor,
  recorder: AuditRecorder,
): Promise<Result<UserRow>> {
  const reason = actor.reason.trim();
  if (reason === "") {
    return fail("reason_required", "A non-empty reason is required for every admin action.");
  }

  const [user] = await db
    .insert(users)
    .values({
      email: input.email.trim().toLowerCase(),
      displayName: input.displayName.trim(),
      role: input.role ?? "player",
      paymentStatus: input.paymentStatus ?? "unpaid",
      paymentNote: input.paymentNote ?? null,
      // Slots are never created here. SS4: they come from provisioning only.
      picksPurchased: 0,
    })
    .returning();

  if (!user) {
    return fail("user_not_found", "Insert returned no row.");
  }

  await recorder.record({
    actorUserId: actor.actorUserId,
    actorRole: actor.actorRole,
    action: "user.create",
    targetType: "user",
    targetId: user.id,
    targetLabel: user.displayName,
    beforeJson: {},
    afterJson: {
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      paymentStatus: user.paymentStatus,
      picksPurchased: user.picksPurchased,
    },
    reason,
    selfAffecting: actor.actorRole === "admin" && actor.actorUserId === user.id,
  });

  return ok(user);
}

export interface SetPaymentInfoInput {
  userId: string;
  paymentStatus?: UserRow["paymentStatus"];
  paymentNote?: string | null;
}

/**
 * SS7.1 lists payment_status and payment_note as separately logged changes, so
 * a call that touches both emits one entry per field rather than a merged one.
 */
export async function setPaymentInfo(
  db: Database,
  input: SetPaymentInfoInput,
  actor: AdminActor,
  recorder: AuditRecorder,
): Promise<Result<UserRow>> {
  const reason = actor.reason.trim();
  if (reason === "") {
    return fail("reason_required", "A non-empty reason is required for every admin action.");
  }

  const [user] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!user) {
    return fail("user_not_found", `No user with id ${input.userId}.`);
  }

  const changes: Array<{ field: "payment_status" | "payment_note"; before: unknown; after: unknown }> = [];

  if (input.paymentStatus !== undefined && input.paymentStatus !== user.paymentStatus) {
    changes.push({ field: "payment_status", before: user.paymentStatus, after: input.paymentStatus });
  }
  if (input.paymentNote !== undefined && input.paymentNote !== user.paymentNote) {
    changes.push({ field: "payment_note", before: user.paymentNote, after: input.paymentNote });
  }

  if (changes.length === 0) return ok(user);

  const [updated] = await db
    .update(users)
    .set({
      ...(input.paymentStatus !== undefined ? { paymentStatus: input.paymentStatus } : {}),
      ...(input.paymentNote !== undefined ? { paymentNote: input.paymentNote } : {}),
    })
    .where(eq(users.id, user.id))
    .returning();

  for (const change of changes) {
    await recorder.record({
      actorUserId: actor.actorUserId,
      actorRole: actor.actorRole,
      action: `user.${change.field}.change`,
      targetType: "user",
      targetId: user.id,
      targetLabel: user.displayName,
      beforeJson: { [change.field]: change.before },
      afterJson: { [change.field]: change.after },
      reason,
      selfAffecting: actor.actorRole === "admin" && actor.actorUserId === user.id,
    });
  }

  return ok(updated ?? user);
}

export async function setUserRole(
  db: Database,
  input: { userId: string; role: UserRow["role"] },
  actor: AdminActor,
  recorder: AuditRecorder,
): Promise<Result<UserRow>> {
  const reason = actor.reason.trim();
  if (reason === "") {
    return fail("reason_required", "A non-empty reason is required for every admin action.");
  }

  const [user] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!user) return fail("user_not_found", `No user with id ${input.userId}.`);
  if (user.role === input.role) return ok(user);

  const [updated] = await db
    .update(users)
    .set({ role: input.role })
    .where(eq(users.id, user.id))
    .returning();

  await recorder.record({
    actorUserId: actor.actorUserId,
    actorRole: actor.actorRole,
    action: "user.role.change",
    targetType: "user",
    targetId: user.id,
    targetLabel: user.displayName,
    beforeJson: { role: user.role },
    afterJson: { role: input.role },
    reason,
    selfAffecting: actor.actorRole === "admin" && actor.actorUserId === user.id,
  });

  return ok(updated ?? user);
}

/**
 * SS4's roster table: the admin's reconciliation view against whatever they are
 * using to collect money. Alive and eliminated counts are derived from slot
 * status every time -- never stored, never cached.
 */
export async function getRoster(db: Database): Promise<RosterEntry[]> {
  const rows = await db
    .select({
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
      role: users.role,
      paymentStatus: users.paymentStatus,
      paymentNote: users.paymentNote,
      picksPurchased: users.picksPurchased,
      slotCount: sql<number>`count(${pickSlots.id})::int`,
      aliveCount: sql<number>`count(*) filter (where ${pickSlots.status} = 'alive')::int`,
      eliminatedCount: sql<number>`count(*) filter (where ${pickSlots.status} = 'eliminated')::int`,
    })
    .from(users)
    .leftJoin(pickSlots, eq(pickSlots.userId, users.id))
    .groupBy(users.id)
    .orderBy(users.displayName);

  return rows.map((row) => ({
    ...row,
    outOfSync: row.slotCount !== row.picksPurchased,
  }));
}
