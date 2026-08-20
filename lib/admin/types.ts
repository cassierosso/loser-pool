import type { PickSlotRow, UserRow } from "@/lib/db/schema";

/** SS4. Every failure mode the admin can hit, as data rather than a thrown string. */
export type ProvisionErrorCode =
  | "reason_required"
  | "user_not_found"
  | "user_deactivated"
  | "picks_negative"
  | "exceeds_max"
  | "picks_frozen"
  | "reduction_blocked"
  | "second_admin_required";

export interface BlockingSlot {
  slotId: string;
  label: string;
  /** Why this slot cannot be removed -- shown verbatim to the admin. */
  reason: "has_selection_history" | "eliminated";
  selectionCount: number;
}

export interface ProvisionError {
  code: ProvisionErrorCode;
  message: string;
  blockingSlots?: BlockingSlot[];
}

export type ProvisionWarningCode = "frozen_override_used" | "mid_season_addition";

export interface ProvisionWarning {
  code: ProvisionWarningCode;
  message: string;
  slotLabels?: string[];
}

export interface ProvisionOutcome {
  user: UserRow;
  created: PickSlotRow[];
  removed: PickSlotRow[];
  /**
   * SS4: mid-season additions are a competitive-integrity problem, not an error.
   * They are surfaced for the admin UI to show before confirming.
   */
  warnings: ProvisionWarning[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ProvisionError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T>(
  code: ProvisionErrorCode,
  message: string,
  blockingSlots?: BlockingSlot[],
): Result<T> {
  return { ok: false, error: { code, message, ...(blockingSlots ? { blockingSlots } : {}) } };
}

/** SS4's reconciliation view, one row per entrant. */
export interface RosterEntry {
  userId: string;
  displayName: string;
  email: string;
  role: UserRow["role"];
  paymentStatus: UserRow["paymentStatus"];
  paymentNote: string | null;
  picksPurchased: number;
  slotCount: number;
  aliveCount: number;
  eliminatedCount: number;
  /**
   * True when slotCount and picksPurchased disagree -- the invariant is that
   * they never do, so this is a repair prompt, not a normal state.
   */
  outOfSync: boolean;
}
