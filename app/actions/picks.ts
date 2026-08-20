"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/current-user";
import { noopAuditRecorder } from "@/lib/audit/port";
import { getDatabase } from "@/lib/db/client";
import { submitSelections, type SubmitFailure } from "@/lib/picks/submit";

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

  const picks: Array<{ slotId: string; teamId: string }> = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("slot:")) continue;
    const teamId = String(value);
    if (teamId === "") continue; // left blank on purpose
    picks.push({ slotId: key.slice("slot:".length), teamId });
  }

  if (picks.length === 0) {
    return { status: "error", message: "Choose a team for at least one pick.", errors: [] };
  }

  const result = await submitSelections(
    db,
    { user, picks },
    // Phase 6 swaps in the hash-chained writer; the events are already emitted.
    noopAuditRecorder,
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
