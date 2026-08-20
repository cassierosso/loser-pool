"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/current-user";
import { createAuditRecorder } from "@/lib/audit/writer";
import { getDatabase } from "@/lib/db/client";
import { submitAllocations, type SubmitFailure } from "@/lib/picks/submit";
import type { Allocation } from "@/lib/picks/allocate";

export interface SubmitPicksState {
  status: "idle" | "saved" | "error";
  message: string;
  errors: SubmitFailure[];
}

/**
 * SS5.3: re-runs validateSelection server-side for every pick, whatever the
 * client believed was allowed, and saves the whole form or none of it.
 */
export async function submitPicksAction(
  _previous: SubmitPicksState,
  formData: FormData,
): Promise<SubmitPicksState> {
  const user = await requireUser();
  const { db } = await getDatabase();

  // The client sends counts per team and never names a pick slot. Which slots
  // those picks land on is decided server-side (lib/picks/allocate.ts), so a
  // crafted request cannot aim a pick at somebody else's entry.
  let allocations: Allocation[];
  try {
    const raw = JSON.parse(String(formData.get("allocation") ?? "{}")) as Record<string, unknown>;
    allocations = Object.entries(raw).map(([teamId, count]) => ({
      teamId,
      count: Number(count),
    }));
  } catch {
    return { status: "error", message: "That submission could not be read.", errors: [] };
  }

  const total = allocations.reduce((sum, entry) => sum + (entry.count || 0), 0);
  if (total === 0) {
    return { status: "error", message: "Place at least one pick before submitting.", errors: [] };
  }

  const result = await submitAllocations(
    db,
    { user, allocations },
    createAuditRecorder(db),
  );

  if (!result.ok) {
    return {
      status: "error",
      message: "Nothing was saved. Please fix the problems below and submit again.",
      errors: result.errors,
    };
  }

  revalidatePath("/picks");
  return {
    status: "saved",
    message: `Saved ${result.saved} pick${result.saved === 1 ? "" : "s"} for ${result.weekLabel}.`,
    errors: [],
  };
}
