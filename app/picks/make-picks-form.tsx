"use client";

import { useActionState, useEffect, useMemo, useState } from "react";

import { submitPicksAction, type SubmitPicksState } from "@/app/actions/picks";
import { formatCountdown } from "@/lib/time";

export interface TeamView {
  id: string;
  abbreviation: string;
  name: string;
}

export interface MatchupView {
  gameId: string;
  kickoffAt: string;
  kickoffLabel: string;
  home: TeamView;
  away: TeamView;
}

export interface AutoAssignSummary {
  repeat: number;
  eliminate: number;
  other: number;
}

const INITIAL: SubmitPicksState = { status: "idle", message: "", errors: [] };

/**
 * SS9 -- Make Picks.
 *
 * Entrants think in totals, not in slots: "I have five picks, put two on
 * Dallas". So the screen is one list of this week's games with a stepper on
 * each team, and a running count of how many picks are still spare. Which
 * pick_slot each one lands on is decided on the server (lib/picks/allocate.ts),
 * because that is a question about history, not about this form.
 *
 * The copy works hard on the one rule everyone gets wrong: you are picking the
 * team you think will LOSE, and a tie kills the pick too.
 */
export function MakePicksForm(props: {
  weekLabel: string;
  lockAt: string | null;
  lockLabel: string | null;
  matchups: MatchupView[];
  aliveCount: number;
  initialAllocation: Record<string, number>;
  autoAssign: AutoAssignSummary;
  canSubmit: boolean;
}) {
  const [state, formAction, pending] = useActionState(submitPicksAction, INITIAL);
  const [now, setNow] = useState(() => Date.now());
  const [allocation, setAllocation] = useState<Record<string, number>>(props.initialAllocation);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!props.lockAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [props.lockAt]);

  useEffect(() => {
    if (state.status === "saved") setConfirming(false);
  }, [state.status]);

  const msUntilLock = props.lockAt ? new Date(props.lockAt).getTime() - now : null;
  const locked = msUntilLock !== null && msUntilLock <= 0;

  const teamsById = useMemo(() => {
    const map: Record<string, TeamView> = {};
    for (const matchup of props.matchups) {
      map[matchup.home.id] = matchup.home;
      map[matchup.away.id] = matchup.away;
    }
    return map;
  }, [props.matchups]);

  const used = Object.values(allocation).reduce((sum, count) => sum + count, 0);
  const spare = props.aliveCount - used;

  const adjust = (teamId: string, delta: number) => {
    setAllocation((current) => {
      const next = (current[teamId] ?? 0) + delta;
      if (next < 0) return current;
      if (delta > 0 && spare <= 0) return current;
      const updated = { ...current };
      if (next === 0) delete updated[teamId];
      else updated[teamId] = next;
      return updated;
    });
  };

  const chosen = Object.entries(allocation)
    .filter(([, count]) => count > 0)
    .map(([teamId, count]) => ({ team: teamsById[teamId], count }))
    .filter((entry): entry is { team: TeamView; count: number } => Boolean(entry.team))
    .sort((a, b) => b.count - a.count || a.team.name.localeCompare(b.team.name));

  return (
    <>
      <LockBanner weekLabel={props.weekLabel} msUntilLock={msUntilLock} lockLabel={props.lockLabel} />

      {locked ? (
        <p role="status" className="rounded-lg border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200">
          <strong>{props.weekLabel} is locked.</strong> Picks are final — anything left unallocated
          has been auto-assigned.
        </p>
      ) : null}

      <section className="rounded-xl border border-amber-700 bg-amber-950/40 px-4 py-3">
        <p className="text-sm font-semibold text-amber-100">Pick the teams you think will LOSE.</p>
        <p className="mt-1 text-sm text-amber-200/90">
          Put as many picks on a team as you like. If that team wins, every pick on it is gone for
          good — <strong className="text-amber-100">and a tie eliminates them too.</strong>
        </p>
      </section>

      {state.status !== "idle" ? (
        <p
          role="status"
          className={
            state.status === "error"
              ? "rounded-lg border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200"
              : "rounded-lg border border-emerald-800 bg-emerald-950/60 px-4 py-3 text-sm text-emerald-200"
          }
        >
          {state.message}
          {state.errors.length > 0 ? (
            <span className="mt-1 block text-xs opacity-90">
              {state.errors.map((error) => error.reason).join(" ")}
            </span>
          ) : null}
        </p>
      ) : null}

      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="allocation" value={JSON.stringify(allocation)} />

        <PickBudget used={used} total={props.aliveCount} />

        <div className="flex flex-col gap-4">
          {props.matchups.map((matchup) => (
            <section key={matchup.gameId} className="rounded-xl border border-neutral-800 p-3">
              <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-1">
                {/* Away team first, so who is at whose place stays readable. */}
                <h3 className="text-sm font-medium text-neutral-200">
                  {matchup.away.name} <span className="text-neutral-500">vs</span>{" "}
                  {matchup.home.name}
                </h3>
                <p className="text-[11px] uppercase tracking-wide text-neutral-500">
                  {matchup.kickoffLabel}
                </p>
              </header>
              <div className="mt-2.5 flex flex-col gap-2">
                {[matchup.away, matchup.home].map((team) => (
                  <TeamRow
                    key={team.id}
                    team={team}
                    count={allocation[team.id] ?? 0}
                    canAdd={spare > 0 && !locked && props.canSubmit}
                    disabled={locked || !props.canSubmit}
                    onAdjust={adjust}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>

        {confirming ? (
          <ConfirmationStep
            chosen={chosen}
            spare={spare}
            autoAssign={props.autoAssign}
            pending={pending}
            onBack={() => setConfirming(false)}
          />
        ) : (
          <button
            type="button"
            disabled={!props.canSubmit || locked || used === 0}
            onClick={() => setConfirming(true)}
            className="sticky bottom-4 rounded-lg bg-emerald-600 px-4 py-3 text-base font-semibold text-white disabled:opacity-40"
          >
            {locked ? "Locked" : `Review ${used} pick${used === 1 ? "" : "s"}`}
          </button>
        )}
      </form>
    </>
  );
}

/** The running total: how many picks are placed, and how many are still spare. */
function PickBudget(props: { used: number; total: number }) {
  const spare = props.total - props.used;
  return (
    <div className="sticky top-0 z-10 flex items-center justify-between gap-3 rounded-xl border border-neutral-700 bg-neutral-950/95 px-4 py-3 backdrop-blur">
      <p className="text-sm">
        <span className="text-lg font-semibold tabular-nums">
          {props.used}/{props.total}
        </span>{" "}
        <span className="text-neutral-400">picks placed</span>
      </p>
      <p
        className={`text-xs font-medium ${spare === 0 ? "text-emerald-400" : "text-amber-300"}`}
      >
        {spare === 0 ? "all picks used" : `${spare} still spare`}
      </p>
    </div>
  );
}

function TeamRow(props: {
  team: TeamView;
  count: number;
  canAdd: boolean;
  disabled: boolean;
  onAdjust: (teamId: string, delta: number) => void;
}) {
  const { team, count } = props;

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 ${
        count > 0 ? "border-emerald-500 bg-emerald-950/50" : "border-neutral-700 bg-neutral-900"
      }`}
    >
      <div className="min-w-0">
        {/* The matchup is named in the header above, so the box only needs the
            team itself -- no abbreviation, no home/away marker. */}
        <p className="truncate text-sm font-medium">{team.name}</p>
        {count > 0 ? (
          <p className="mt-0.5 text-[11px] font-bold text-emerald-300">{count} to LOSE</p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label={`Remove a pick from ${team.name}`}
          disabled={props.disabled || count === 0}
          onClick={() => props.onAdjust(team.id, -1)}
          className="h-9 w-9 rounded-lg border border-neutral-700 text-lg font-semibold disabled:opacity-30"
        >
          −
        </button>
        <span className="w-6 text-center text-base font-semibold tabular-nums">{count}</span>
        <button
          type="button"
          aria-label={`Add a pick to ${team.name}`}
          disabled={props.disabled || !props.canAdd}
          onClick={() => props.onAdjust(team.id, 1)}
          className="h-9 w-9 rounded-lg border border-neutral-700 text-lg font-semibold disabled:opacity-30"
        >
          +
        </button>
      </div>
    </div>
  );
}

/** SS9's confirmation step: the full recap, in the spec's own words. */
function ConfirmationStep(props: {
  chosen: Array<{ team: TeamView; count: number }>;
  spare: number;
  autoAssign: AutoAssignSummary;
  pending: boolean;
  onBack: () => void;
}) {
  const total = props.chosen.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <section className="sticky bottom-4 rounded-xl border border-emerald-700 bg-neutral-950 p-4 shadow-lg">
      <h2 className="text-sm font-semibold">Confirm your picks</h2>

      <ul className="mt-3 flex flex-col gap-2">
        {props.chosen.map(({ team, count }) => (
          <li key={team.id} className="text-sm">
            <span className="font-semibold tabular-nums">{count} ×</span>{" "}
            <span className="font-semibold text-emerald-300">{team.name}</span> to{" "}
            <span className="font-bold">LOSE</span>{" "}
            <span className="text-neutral-400">(a tie eliminates)</span>
          </li>
        ))}
      </ul>

      <p className="mt-3 border-t border-neutral-800 pt-3 text-xs text-neutral-400">
        {total} pick{total === 1 ? "" : "s"} placed across {props.chosen.length} team
        {props.chosen.length === 1 ? "" : "s"}.
      </p>

      {props.spare > 0 ? (
        <p
          className={`mt-2 rounded-lg px-3 py-2 text-xs ${
            props.autoAssign.eliminate > 0
              ? "bg-red-950/60 text-red-200"
              : "bg-amber-950/50 text-amber-200"
          }`}
        >
          {props.spare} pick{props.spare === 1 ? "" : "s"} left spare. At lock{" "}
          {props.autoAssign.eliminate > 0 ? (
            <>
              up to <strong>{props.autoAssign.eliminate}</strong> of them would be{" "}
              <strong>ELIMINATED</strong> — there is no previous pick to repeat.
            </>
          ) : (
            <>they would repeat last week&apos;s team where it is playing.</>
          )}
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={props.onBack}
          className="flex-1 rounded-lg border border-neutral-700 px-4 py-3 text-sm font-medium"
        >
          Back
        </button>
        <button
          type="submit"
          disabled={props.pending}
          className="flex-[2] rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {props.pending ? "Saving…" : "Submit picks"}
        </button>
      </div>
    </section>
  );
}

/** SS9: a prominent countdown to lock. */
function LockBanner(props: {
  weekLabel: string;
  msUntilLock: number | null;
  lockLabel: string | null;
}) {
  const remaining = props.msUntilLock;

  return (
    <section className="flex items-baseline justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3">
      <div>
        <h2 className="text-lg font-semibold">{props.weekLabel}</h2>
        {props.lockLabel ? (
          <p className="text-xs text-neutral-400">All picks lock at {props.lockLabel}</p>
        ) : (
          <p className="text-xs text-neutral-400">Lock time not set yet</p>
        )}
      </div>
      {remaining !== null ? (
        <p
          className={`text-right text-sm font-semibold tabular-nums ${
            remaining <= 0
              ? "text-red-400"
              : remaining < 6 * 3600_000
                ? "text-amber-300"
                : "text-neutral-200"
          }`}
        >
          {formatCountdown(remaining)}
          <span className="block text-[10px] font-normal uppercase tracking-wide text-neutral-500">
            until lock
          </span>
        </p>
      ) : null}
    </section>
  );
}
