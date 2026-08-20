import { AppShell, ResultBadge } from "@/components/app-shell";
import { ChainBadge } from "@/components/chain-badge";
import { getChainStatus } from "@/lib/audit/badge";
import { getPostLockAdminNotice } from "@/lib/audit/banner";
import Link from "next/link";
import { requireUser } from "@/lib/auth/current-user";
import { getDatabase } from "@/lib/db/client";
import { formatKickoff } from "@/lib/time";
import { getLeagueBoard } from "@/lib/views/board";

export const dynamic = "force-dynamic";

/**
 * SS9 -- League Board. Everyone's alive/eliminated counts and what they bought,
 * with this week's picks appearing once the week locks.
 */
export default async function BoardPage() {
  const user = await requireUser();
  const { db } = await getDatabase();
  const [board, chainStatus] = await Promise.all([
    getLeagueBoard(db, user),
    // SS7.4: verified on League Board load, cached five minutes.
    getChainStatus(),
  ]);
  const postLock = await getPostLockAdminNotice(db, board.league.seasonYear);

  const picksByUser = new Map<string, typeof board.picks>();
  for (const pick of board.picks) {
    const bucket = picksByUser.get(pick.userId);
    if (bucket) bucket.push(pick);
    else picksByUser.set(pick.userId, [pick]);
  }

  return (
    <AppShell
      title="League Board"
      subtitle={`${board.league.name} · ${board.league.seasonYear}`}
      current="/board"
    >
      <ChainBadge status={chainStatus} />

      {postLock.show ? (
        <section role="alert" className="rounded-xl border-2 border-amber-500 bg-amber-950/60 px-4 py-3">
          <h2 className="text-sm font-bold text-amber-100">
            {postLock.count} admin action{postLock.count === 1 ? "" : "s"} taken after picks locked
          </h2>
          <p className="mt-1 text-sm text-amber-200/90">
            Changes were made while this week&apos;s picks were already final.{" "}
            <Link href="/log" className="font-semibold underline underline-offset-4">
              Read the league log
            </Link>{" "}
            to see exactly what and why.
          </p>
          {postLock.unseenBy > 0 ? (
            <p className="mt-1 text-xs text-amber-300/80">
              {postLock.unseenBy} member{postLock.unseenBy === 1 ? " has" : "s have"} not looked yet.
            </p>
          ) : null}
        </section>
      ) : null}

      {board.league.seasonStatus === "closed" && board.league.seasonOutcome ? (
        <section className="rounded-xl border border-emerald-600 bg-emerald-950/50 px-4 py-3">
          <h2 className="text-sm font-semibold text-emerald-100">
            {board.championUserIds.length > 1 ? "Co-champions" : "Champion"}
          </h2>
          <p className="mt-1 text-sm text-emerald-200/90">{board.league.seasonOutcome.reason}</p>
        </section>
      ) : null}

      {board.week ? (
        <section className="flex items-baseline justify-between gap-3 rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3">
          <div>
            <h2 className="text-base font-semibold">{board.week.displayLabel}</h2>
            {board.week.lockAt ? (
              <p className="text-xs text-neutral-400">
                {board.revealed ? "Locked" : "Locks"} {formatKickoff(board.week.lockAt)}
              </p>
            ) : null}
          </div>
          <p className={`text-xs font-medium ${board.revealed ? "text-emerald-400" : "text-amber-300"}`}>
            {board.revealed ? "picks visible" : "picks hidden until lock"}
          </p>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-neutral-800">
        <table className="w-full text-sm">
          <caption className="sr-only">Entrants, ordered by surviving picks</caption>
          <thead>
            <tr className="border-b border-neutral-800 text-left text-xs uppercase tracking-wide text-neutral-500">
              <th scope="col" className="px-3 py-2 font-medium">Entrant</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Alive</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Out</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Bought</th>
            </tr>
          </thead>
          <tbody>
            {board.entrants.map((entrant) => (
              <tr
                key={entrant.userId}
                className={`border-b border-neutral-900 last:border-0 ${
                  entrant.isViewer ? "bg-neutral-900/70" : ""
                }`}
              >
                <th scope="row" className="px-3 py-2.5 text-left font-normal">
                  <span className={entrant.aliveCount === 0 ? "text-neutral-500 line-through" : ""}>
                    {entrant.displayName}
                  </span>
                  {entrant.isViewer ? (
                    <span className="ml-1.5 text-[10px] uppercase text-neutral-500">you</span>
                  ) : null}
                  {entrant.isAdmin ? (
                    <span className="ml-1.5 text-[10px] uppercase text-neutral-500">admin</span>
                  ) : null}
                </th>
                <td className="px-2 py-2.5 text-right font-semibold tabular-nums">
                  {entrant.aliveCount}
                </td>
                <td className="px-2 py-2.5 text-right tabular-nums text-neutral-500">
                  {entrant.eliminatedCount}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-neutral-400">
                  {entrant.picksPurchased}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-300">
          {board.week ? `${board.week.displayLabel} picks` : "Picks"}
        </h2>

        {!board.revealed ? (
          <p className="rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm text-neutral-400">
            Everyone&apos;s picks stay hidden until the week locks — including yours, from them.
            Only your own are shown below.
          </p>
        ) : null}

        {board.picks.length === 0 ? (
          <p className="text-sm text-neutral-500">No picks submitted yet.</p>
        ) : (
          [...picksByUser.entries()].map(([userId, picks]) => (
            <article key={userId} className="rounded-xl border border-neutral-800 p-3">
              <h3 className="px-1 text-sm font-medium">{picks[0]!.displayName}</h3>
              <ul className="mt-2 flex flex-col gap-1.5">
                {picks.map((pick) => (
                  <li
                    key={`${userId}-${pick.slotLabel}`}
                    className="flex items-center justify-between gap-3 rounded-lg bg-neutral-900 px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-sm">
                      <span className="text-neutral-500">{pick.slotLabel}</span>{" "}
                      <span className="font-medium">{pick.teamName}</span>
                    </span>
                    <ResultBadge result={pick.result} wasAutoAssigned={pick.wasAutoAssigned} />
                  </li>
                ))}
              </ul>
            </article>
          ))
        )}
      </section>
    </AppShell>
  );
}
