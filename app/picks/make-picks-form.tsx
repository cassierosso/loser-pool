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

export interface SlotView {
  id: string;
  label: string;
  selectedTeamId: string | null;
  wasAutoAssigned: boolean;
  teamUses: Record<string, number>;
  autoAssign: {
    explanation: string;
    teamAbbreviation: string | null;
    willEliminate: boolean;
  } | null;
}

const INITIAL: SubmitPicksState = { status: "idle", message: "", errors: [] };

/**
 * SS9. The copy here works hard on one thing: you are picking the team you
 * think will LOSE, and a tie kills the pick too. That is the rule everyone gets
 * wrong, so it is repeated on the heading, on every option, and again in the
 * confirmation step.
 */
export function MakePicksForm(props: {
  weekLabel: string;
  lockAt: string | null;
  lockLabel: string | null;
  matchups: MatchupView[];
  slots: SlotView[];
  canSubmit: boolean;
}) {
  const [state, formAction, pending] = useActionState(submitPicksAction, INITIAL);
  const [now, setNow] = useState(() => Date.now());
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      props.slots.flatMap((slot) => (slot.selectedTeamId ? [[slot.id, slot.selectedTeamId]] : [])),
    ),
  );
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!props.lockAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [props.lockAt]);

  // Close the confirmation panel once a submit succeeds, so the saved state is
  // what the entrant is looking at rather than a stale "confirm" prompt.
  useEffect(() => {
    if (state.status === "saved") setConfirming(false);
  }, [state.status]);

  const msUntilLock = props.lockAt ? new Date(props.lockAt).getTime() - now : null;
  // Once the deadline passes the server will refuse the submission anyway
  // (SS5.3, acceptance test 5). Saying so here rather than letting someone fill
  // the whole form in and be turned away at the end.
  const locked = msUntilLock !== null && msUntilLock <= 0;

  const teamsById = useMemo(() => {
    const map: Record<string, TeamView> = {};
    for (const matchup of props.matchups) {
      map[matchup.home.id] = matchup.home;
      map[matchup.away.id] = matchup.away;
    }
    return map;
  }, [props.matchups]);

  const errorsBySlot = useMemo(
    () => Object.fromEntries(state.errors.map((error) => [error.slotId, error])),
    [state.errors],
  );

  const chosenCount = Object.values(choices).filter(Boolean).length;
  const unpicked = props.slots.filter((slot) => !choices[slot.id]);

  return (
    <>
      <LockBanner
        weekLabel={props.weekLabel}
        msUntilLock={msUntilLock}
        lockLabel={props.lockLabel}
      />

      {locked ? (
        <p
          role="status"
          className="rounded-lg border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200"
        >
          <strong>{props.weekLabel} is locked.</strong> Picks are final — anything you left blank
          has been auto-assigned.
        </p>
      ) : null}

      <section className="rounded-xl border border-amber-700 bg-amber-950/40 px-4 py-3">
        <p className="text-sm font-semibold text-amber-100">
          Pick the team you think will LOSE.
        </p>
        <p className="mt-1 text-sm text-amber-200/90">
          If your team wins, that pick is gone for good.{" "}
          <strong className="text-amber-100">A tie eliminates it too.</strong>
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
        </p>
      ) : null}

      <form action={formAction} className="flex flex-col gap-5">
        {props.slots.map((slot) => (
          <fieldset key={slot.id} className="rounded-xl border border-neutral-800 p-4">
            <legend className="flex items-center gap-2 px-1 text-sm font-semibold">
              {slot.label}
              {slot.wasAutoAssigned ? (
                <span className="rounded-full bg-sky-900 px-2 py-0.5 text-[11px] font-medium text-sky-200">
                  auto-assigned
                </span>
              ) : null}
            </legend>

            <input type="hidden" name={`slot:${slot.id}`} value={choices[slot.id] ?? ""} />

            {errorsBySlot[slot.id] ? (
              <p className="mb-3 rounded-lg bg-red-950/60 px-3 py-2 text-xs text-red-200">
                {errorsBySlot[slot.id]!.reason}
              </p>
            ) : null}

            <div className="mt-2 flex flex-col gap-2">
              {props.matchups.map((matchup) => (
                <div key={`${slot.id}-${matchup.gameId}`} className="flex flex-col gap-1">
                  <p className="text-[11px] uppercase tracking-wide text-neutral-500">
                    {matchup.kickoffLabel}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {[matchup.away, matchup.home].map((team) => {
                      const selected = choices[slot.id] === team.id;
                      const uses = slot.teamUses[team.id] ?? 0;
                      return (
                        <button
                          key={team.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() =>
                            setChoices((current) => ({
                              ...current,
                              [slot.id]: current[slot.id] === team.id ? "" : team.id,
                            }))
                          }
                          className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left text-sm ${
                            selected
                              ? "border-emerald-500 bg-emerald-950/60 text-emerald-100"
                              : "border-neutral-700 bg-neutral-900 text-neutral-200"
                          }`}
                        >
                          <span>
                            <span className="font-semibold">{team.abbreviation}</span>{" "}
                            <span className="text-neutral-400">
                              {team === matchup.home ? "vs" : "at"}
                            </span>
                          </span>
                          <span className="flex items-center gap-1.5">
                            {uses > 0 ? (
                              <span
                                title={`This pick has used ${team.abbreviation} ${uses} time${uses === 1 ? "" : "s"}`}
                                className="rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400"
                              >
                                ×{uses}
                              </span>
                            ) : null}
                            {selected ? (
                              <span className="text-[10px] font-bold text-emerald-300">TO LOSE</span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {/* SS9: if nothing is submitted, say what happens and why. */}
            {!choices[slot.id] && slot.autoAssign ? (
              <p
                className={`mt-3 rounded-lg px-3 py-2 text-xs ${
                  slot.autoAssign.willEliminate
                    ? "bg-red-950/60 text-red-200"
                    : "bg-neutral-800/60 text-neutral-300"
                }`}
              >
                If you don&apos;t pick: {slot.label} {slot.autoAssign.explanation}
                {slot.autoAssign.teamAbbreviation ? ` (${slot.autoAssign.teamAbbreviation})` : ""}.
              </p>
            ) : null}
          </fieldset>
        ))}

        {confirming ? (
          <ConfirmationStep
            choices={choices}
            slots={props.slots}
            teamsById={teamsById}
            unpicked={unpicked}
            pending={pending}
            onBack={() => setConfirming(false)}
          />
        ) : (
          <button
            type="button"
            disabled={!props.canSubmit || chosenCount === 0 || locked}
            onClick={() => setConfirming(true)}
            className="sticky bottom-4 rounded-lg bg-emerald-600 px-4 py-3 text-base font-semibold text-white disabled:opacity-40"
          >
            {locked ? "Locked" : `Review ${chosenCount} pick${chosenCount === 1 ? "" : "s"}`}
          </button>
        )}
      </form>
    </>
  );
}

/**
 * SS9's confirmation step, restating every choice in the spec's own words:
 * "Pick 3 → Broncos to LOSE (a tie eliminates)".
 */
function ConfirmationStep(props: {
  choices: Record<string, string>;
  slots: SlotView[];
  teamsById: Record<string, TeamView>;
  unpicked: SlotView[];
  pending: boolean;
  onBack: () => void;
}) {
  return (
    <section className="sticky bottom-4 rounded-xl border border-emerald-700 bg-neutral-950 p-4 shadow-lg">
      <h2 className="text-sm font-semibold">Confirm your picks</h2>
      <ul className="mt-3 flex flex-col gap-2">
        {props.slots
          .filter((slot) => props.choices[slot.id])
          .map((slot) => {
            const team = props.teamsById[props.choices[slot.id]!];
            return (
              <li key={slot.id} className="text-sm">
                <span className="font-semibold">{slot.label}</span> →{" "}
                <span className="font-semibold text-emerald-300">{team?.name}</span> to{" "}
                <span className="font-bold">LOSE</span>{" "}
                <span className="text-neutral-400">(a tie eliminates)</span>
              </li>
            );
          })}
      </ul>

      {props.unpicked.length > 0 ? (
        <p className="mt-3 rounded-lg bg-amber-950/50 px-3 py-2 text-xs text-amber-200">
          {props.unpicked.map((slot) => slot.label).join(", ")} left blank — these will be
          auto-assigned at lock.
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
            remaining <= 0 ? "text-red-400" : remaining < 6 * 3600_000 ? "text-amber-300" : "text-neutral-200"
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
