import Link from "next/link";

import {
  overrideGameAction,
  resolvePlayoffAction,
  runJobAction,
  setPaymentAction,
  setPicksAction,
  setSlotStatusAction,
  updateConfigAction,
} from "@/app/actions/admin";
import { AppShell } from "@/components/app-shell";
import { ChainBadge } from "@/components/chain-badge";
import { getChainStatus } from "@/lib/audit/badge";
import { requireAdmin } from "@/lib/auth/current-user";
import { getRoster } from "@/lib/admin";
import { loadLeague } from "@/lib/config";
import { getDatabase } from "@/lib/db/client";
import { games, pickSlots, teams, users, weekStates } from "@/lib/db/schema";
import { JOB_NAMES } from "@/lib/jobs";
import { formatKickoff } from "@/lib/time";
import { and, desc, eq } from "drizzle-orm";

import { AdminForm, inputClass } from "./admin-form";

export const dynamic = "force-dynamic";

/**
 * SS9's Admin screen, built ON TOP of the audit log rather than beside it:
 * every control here routes through a service that writes an entry the whole
 * league can read.
 */
export default async function AdminPage() {
  const admin = await requireAdmin();
  const { db } = await getDatabase();

  const [{ row: league, config }, roster, status] = await Promise.all([
    loadLeague(db),
    getRoster(db),
    getChainStatus(),
  ]);

  const allSlots = await db
    .select({
      id: pickSlots.id,
      label: pickSlots.label,
      status: pickSlots.status,
      owner: users.displayName,
    })
    .from(pickSlots)
    .innerJoin(users, eq(users.id, pickSlots.userId))
    .orderBy(users.displayName, pickSlots.slotNumber);

  const [currentWeek] = await db
    .select()
    .from(weekStates)
    .where(
      and(eq(weekStates.seasonYear, league.seasonYear), eq(weekStates.status, "locked")),
    )
    .orderBy(desc(weekStates.displayOrdinal))
    .limit(1);

  const recentGames = currentWeek
    ? await db.select().from(games).where(eq(games.weekStateId, currentWeek.id)).orderBy(games.kickoffAt)
    : [];
  const teamRows = await db.select().from(teams);
  const teamName = new Map(teamRows.map((team) => [team.id, team.displayName]));

  return (
    <AppShell title="Admin" subtitle={admin.displayName} current="/admin">
      <ChainBadge status={status} />

      <p className="rounded-xl border border-amber-700 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
        You are also a competitor here. Everything you do on this screen is written to the{" "}
        <Link href="/log" className="font-semibold underline underline-offset-4">
          league log
        </Link>
        , which every member can read and export.
      </p>

      {league.seasonStatus === "pending_admin" ? (
        <AdminForm
          action={resolvePlayoffAction}
          title="Resolve the playoff decision"
          description="The season is frozen until you answer. No week will open before then."
          submitLabel="Record decision"
        >
          <select name="choice" defaultValue="continue" className={inputClass}>
            <option value="continue">Continue into the playoffs</option>
            <option value="stop_at_regular_season">Stop at the regular season</option>
          </select>
        </AdminForm>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-neutral-800">
        <h2 className="border-b border-neutral-800 px-3 py-2 text-sm font-semibold">Roster</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
              <th scope="col" className="px-3 py-2 font-medium">Player</th>
              <th scope="col" className="px-2 py-2 font-medium">Pay</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Bought</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Alive</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Out</th>
            </tr>
          </thead>
          <tbody>
            {roster.map((entry) => (
              <tr key={entry.userId} className="border-t border-neutral-900">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {entry.displayName}
                  {entry.outOfSync ? (
                    <span className="ml-2 text-[10px] uppercase text-red-400">out of sync</span>
                  ) : null}
                  {entry.paymentNote ? (
                    <span className="block text-[11px] text-neutral-500">{entry.paymentNote}</span>
                  ) : null}
                </th>
                <td className="px-2 py-2 text-xs text-neutral-400">{entry.paymentStatus}</td>
                <td className="px-2 py-2 text-right tabular-nums">{entry.picksPurchased}</td>
                <td className="px-2 py-2 text-right font-semibold tabular-nums">{entry.aliveCount}</td>
                <td className="px-3 py-2 text-right tabular-nums text-neutral-500">
                  {entry.eliminatedCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <AdminForm
        action={setPicksAction}
        title="Provision picks"
        description={`Ceiling is ${config.maxPicksPerUser}. After week 1 kickoff this needs the override box.`}
        submitLabel="Set pick count"
      >
        <select name="userId" className={inputClass} aria-label="Player">
          {roster.map((entry) => (
            <option key={entry.userId} value={entry.userId}>
              {entry.displayName} (has {entry.picksPurchased})
            </option>
          ))}
        </select>
        <input type="number" name="picks" min={0} max={config.maxPicksPerUser} defaultValue={config.defaultPicksPerUser} className={inputClass} aria-label="Picks" />
        <label className="flex items-center gap-2 text-xs text-neutral-300">
          <input type="checkbox" name="override" />
          Override the freeze (competitive-integrity warning applies)
        </label>
      </AdminForm>

      <AdminForm action={setPaymentAction} title="Record a payment" submitLabel="Save payment">
        <select name="userId" className={inputClass} aria-label="Player">
          {roster.map((entry) => (
            <option key={entry.userId} value={entry.userId}>
              {entry.displayName}
            </option>
          ))}
        </select>
        <select name="paymentStatus" className={inputClass} aria-label="Payment status">
          <option value="unpaid">unpaid</option>
          <option value="paid">paid</option>
          <option value="comped">comped</option>
        </select>
        <input type="text" name="paymentNote" placeholder="$100 Venmo 2024-09-02" className={inputClass} aria-label="Payment note" />
      </AdminForm>

      <AdminForm
        action={setSlotStatusAction}
        title="Revive or eliminate a pick"
        description="The bluntest instrument here. Expect to be asked about it."
        submitLabel="Change pick status"
        danger
      >
        <select name="slotId" className={inputClass} aria-label="Pick slot">
          {allSlots.map((slot) => (
            <option key={slot.id} value={slot.id}>
              {slot.owner} — {slot.label} ({slot.status})
            </option>
          ))}
        </select>
        <select name="status" className={inputClass} aria-label="New status">
          <option value="alive">alive</option>
          <option value="eliminated">eliminated</option>
        </select>
      </AdminForm>

      {recentGames.length > 0 ? (
        <AdminForm
          action={overrideGameAction}
          title="Override a game result"
          description={`${currentWeek?.displayLabel}. Leaving the winner blank on a final records a TIE, which eliminates every pick on both teams.`}
          submitLabel="Override game"
          danger
        >
          <select name="gameId" className={inputClass} aria-label="Game">
            {recentGames.map((game) => (
              <option key={game.id} value={game.id}>
                {teamName.get(game.awayTeamId)} at {teamName.get(game.homeTeamId)} —{" "}
                {formatKickoff(game.kickoffAt)}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <input type="number" name="awayScore" placeholder="away" className={`${inputClass} w-full`} aria-label="Away score" />
            <input type="number" name="homeScore" placeholder="home" className={`${inputClass} w-full`} aria-label="Home score" />
          </div>
          <select name="winnerTeamId" className={inputClass} aria-label="Winner">
            <option value="">— tie / no winner —</option>
            {teamRows.map((team) => (
              <option key={team.id} value={team.id}>
                {team.displayName}
              </option>
            ))}
          </select>
          <select name="status" defaultValue="final" className={inputClass} aria-label="Status">
            <option value="final">final</option>
            <option value="scheduled">scheduled</option>
            <option value="canceled">canceled</option>
            <option value="postponed">postponed</option>
          </select>
        </AdminForm>
      ) : null}

      <AdminForm
        action={updateConfigAction}
        title="League settings"
        description="LEAGUE_CONFIG. Blank fields are left as they are."
        submitLabel="Save settings"
      >
        <input type="number" name="maxPicksPerUser" placeholder={`maxPicksPerUser (${config.maxPicksPerUser})`} className={inputClass} aria-label="Max picks per user" />
        <select name="missedPickFallback" defaultValue={config.missedPickFallback} className={inputClass} aria-label="Missed pick fallback">
          <option value="eliminate">missedPickFallback: eliminate</option>
          <option value="auto_underdog">missedPickFallback: auto_underdog</option>
          <option value="survive">missedPickFallback: survive</option>
        </select>
        <select name="playoffMode" defaultValue={config.playoffMode} className={inputClass} aria-label="Playoff mode">
          <option value="continue">playoffMode: continue</option>
          <option value="stop_at_regular_season">playoffMode: stop_at_regular_season</option>
          <option value="admin_decides">playoffMode: admin_decides</option>
        </select>
        <select name="bothSidesOfGame" defaultValue={config.bothSidesOfGame} className={inputClass} aria-label="Both sides of game">
          <option value="block">bothSidesOfGame: block</option>
          <option value="allow">bothSidesOfGame: allow</option>
        </select>
        <label className="flex items-center gap-2 text-xs text-neutral-300">
          <input type="checkbox" name="requireSecondAdmin" defaultChecked={config.requireSecondAdminForSelfActions} />
          Require a second admin to approve actions affecting your own entry
        </label>
      </AdminForm>

      <AdminForm action={runJobAction} title="Run a job" submitLabel="Run job">
        <select name="job" className={inputClass} aria-label="Job">
          {JOB_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </AdminForm>
    </AppShell>
  );
}
