"use server";

import { headers } from "next/headers";

import { revalidatePath } from "next/cache";

import {
  overrideGameResult,
  resolvePlayoffDecision,
  setPaymentInfo,
  setPicksPurchased,
  setSlotStatus,
  issueInviteLink,
  type AdminActor,
} from "@/lib/admin";
import { clearChainStatusCache } from "@/lib/audit/badge";
import { createAuditRecorder } from "@/lib/audit/writer";
import { requireAdmin } from "@/lib/auth/current-user";
import { updateLeagueConfig, type LeagueConfigPatch } from "@/lib/config";
import { getDatabase } from "@/lib/db/client";
import { createJobContext, isJobName, runJob } from "@/lib/jobs";

/**
 * SS9's admin screen, and SS7.6's guardrails around it.
 *
 * Every action here demands a typed reason, which is checked in the service
 * layer and again by a database constraint. Nothing is "quietly" done: each of
 * these writes to a log that every member of the league can read.
 */

export interface AdminState {
  status: "idle" | "done" | "error";
  message: string;
}

function reasonFrom(formData: FormData): string {
  return String(formData.get("reason") ?? "").trim();
}

async function actorFrom(formData: FormData): Promise<AdminActor> {
  const admin = await requireAdmin();
  return {
    actorUserId: admin.id,
    actorRole: "admin",
    reason: reasonFrom(formData),
    override: formData.get("override") === "on",
  };
}

/** Everything below refreshes the badge, since the chain head has moved. */
function done(message: string): AdminState {
  clearChainStatusCache();
  revalidatePath("/admin");
  revalidatePath("/log");
  revalidatePath("/board");
  return { status: "done", message };
}

export async function setPicksAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const actor = await actorFrom(formData);
  if (actor.reason === "") return { status: "error", message: "A reason is required." };

  const { db } = await getDatabase();
  const result = await setPicksPurchased(
    db,
    { userId: String(formData.get("userId")), picksPurchased: Number(formData.get("picks")) },
    actor,
    createAuditRecorder(db),
  );

  if (!result.ok) return { status: "error", message: result.error.message };

  const warnings = result.value.warnings.map((warning) => warning.message).join(" ");
  return done(
    `${result.value.user.displayName} now has ${result.value.user.picksPurchased} picks.` +
      (warnings ? ` ${warnings}` : ""),
  );
}

export async function setPaymentAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const actor = await actorFrom(formData);
  if (actor.reason === "") return { status: "error", message: "A reason is required." };

  const { db } = await getDatabase();
  const result = await setPaymentInfo(
    db,
    {
      userId: String(formData.get("userId")),
      paymentStatus: String(formData.get("paymentStatus")) as "unpaid" | "paid" | "comped",
      paymentNote: String(formData.get("paymentNote") ?? ""),
    },
    actor,
    createAuditRecorder(db),
  );

  return result.ok
    ? done(`Payment updated for ${result.value.displayName}.`)
    : { status: "error", message: result.error.message };
}

export async function setSlotStatusAction(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const actor = await actorFrom(formData);
  if (actor.reason === "") return { status: "error", message: "A reason is required." };

  const { db } = await getDatabase();
  const result = await setSlotStatus(
    db,
    {
      slotId: String(formData.get("slotId")),
      status: String(formData.get("status")) === "alive" ? "alive" : "eliminated",
    },
    actor,
    createAuditRecorder(db),
  );

  return result.ok
    ? done(`${result.value.label} is now ${result.value.status}.`)
    : { status: "error", message: result.error.message };
}

export async function overrideGameAction(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const actor = await actorFrom(formData);
  if (actor.reason === "") return { status: "error", message: "A reason is required." };

  const parseScore = (key: string) => {
    const raw = String(formData.get(key) ?? "").trim();
    return raw === "" ? null : Number.parseInt(raw, 10);
  };

  const winner = String(formData.get("winnerTeamId") ?? "");
  const { db } = await getDatabase();
  const result = await overrideGameResult(
    db,
    {
      gameId: String(formData.get("gameId")),
      homeScore: parseScore("homeScore"),
      awayScore: parseScore("awayScore"),
      // An empty winner on a final IS a tie (SS3) -- so it is a real choice
      // here, not a missing value.
      winnerTeamId: winner === "" ? null : winner,
      status: String(formData.get("status")) as "final" | "canceled" | "postponed" | "scheduled",
    },
    actor,
    createAuditRecorder(db),
  );

  return result.ok
    ? done("Game updated. Re-run gradeWeek to apply it to picks.")
    : { status: "error", message: result.error.message };
}

export async function updateConfigAction(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const actor = await actorFrom(formData);
  if (actor.reason === "") return { status: "error", message: "A reason is required." };

  const patch: LeagueConfigPatch = {};
  const max = String(formData.get("maxPicksPerUser") ?? "").trim();
  if (max !== "") patch.maxPicksPerUser = Number.parseInt(max, 10);
  const fallback = String(formData.get("missedPickFallback") ?? "");
  if (fallback) patch.missedPickFallback = fallback as LeagueConfigPatch["missedPickFallback"];
  const playoff = String(formData.get("playoffMode") ?? "");
  if (playoff) patch.playoffMode = playoff as LeagueConfigPatch["playoffMode"];
  const bothSides = String(formData.get("bothSidesOfGame") ?? "");
  if (bothSides) patch.bothSidesOfGame = bothSides as LeagueConfigPatch["bothSidesOfGame"];
  patch.requireSecondAdminForSelfActions = formData.get("requireSecondAdmin") === "on";

  try {
    const { db } = await getDatabase();
    await updateLeagueConfig(db, patch, actor, createAuditRecorder(db));
    return done("League settings updated.");
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export async function runJobAction(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const actor = await actorFrom(formData);
  if (actor.reason === "") return { status: "error", message: "A reason is required." };

  const name = String(formData.get("job"));
  if (!isJobName(name)) return { status: "error", message: `Unknown job "${name}".` };

  const { db } = await getDatabase();
  const recorder = createAuditRecorder(db);

  // SS7.1: "An admin manually triggers any job" is itself a logged action,
  // separate from whatever the job then records for itself.
  await recorder.record({
    actorUserId: actor.actorUserId,
    actorRole: "admin",
    action: "job.trigger",
    targetType: "job",
    targetId: name,
    targetLabel: `Manual run of ${name}`,
    beforeJson: {},
    afterJson: { job: name },
    reason: actor.reason,
    selfAffecting: false,
  });

  const result = await runJob(name, await createJobContext());
  return result.ok
    ? done(result.summary)
    : { status: "error", message: `${result.summary} ${result.warnings.join(" ")}` };
}

export async function resolvePlayoffAction(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const actor = await actorFrom(formData);
  if (actor.reason === "") return { status: "error", message: "A reason is required." };

  const { db } = await getDatabase();
  const result = await resolvePlayoffDecision(
    db,
    {
      choice:
        String(formData.get("choice")) === "continue" ? "continue" : "stop_at_regular_season",
    },
    actor,
    createAuditRecorder(db),
  );

  return result.ok
    ? done(`Playoff decision recorded: ${result.value.choice}.`)
    : { status: "error", message: result.error.message };
}


export interface InviteLinkState {
  status: "idle" | "created" | "error";
  message: string;
  url?: string;
  expiresAt?: string;
}

/**
 * SS7 -- minting a sign-in link for a member, for handing over directly.
 *
 * Useful when email is not available; dangerous because the link signs its
 * holder in as that member. Logged on mint, logged again on use, and disclosed
 * to the member on their own screen.
 */
export async function issueInviteLinkAction(
  _previous: InviteLinkState,
  formData: FormData,
): Promise<InviteLinkState> {
  const admin = await requireAdmin();
  const { db } = await getDatabase();

  const userId = String(formData.get("userId") ?? "");
  const reason = String(formData.get("reason") ?? "");

  const store = await headers();
  const host = store.get("x-forwarded-host") ?? store.get("host") ?? "localhost:3000";
  const proto = store.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const baseUrl = process.env.APP_URL?.trim() || `${proto}://${host}`;

  const result = await issueInviteLink(
    db,
    { userId, baseUrl },
    { actorUserId: admin.id, actorRole: "admin", reason },
    createAuditRecorder(db),
  );

  if (!result.ok) return { status: "error", message: result.error.message };

  revalidatePath("/admin");
  return {
    status: "created",
    message: "Link created. It works once, expires in 72 hours, and is recorded in the league log.",
    url: result.value.url,
    expiresAt: result.value.expiresAt.toISOString(),
  };
}
