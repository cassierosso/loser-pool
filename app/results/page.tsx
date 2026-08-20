import Link from "next/link";

import { AppShell, ResultBadge } from "@/components/app-shell";
import { requireUser } from "@/lib/auth/current-user";
import { getDatabase } from "@/lib/db/client";
import { formatKickoff } from "@/lib/time";
import { getWeekResults, type ResultGame } from "@/lib/views/week-results";

export const dynamic = "force-dynamic";

/**
 * SS9 -- Week Results. Scores, ties flagged loudly, and every selection
 * colour-coded. Other entrants' picks appear only once the week has locked.
 */
export default async function ResultsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const user = await requireUser();
  const { db } = await getDatabase();

  const { week: weekParam } = await searchParams;
  const requested = weekParam ? Number.parseInt(weekParam, 10) : undefined;
  const data = await getWeekResults(db, user, {
    ...(requested !== undefined && !Number.isNaN(requested) ? { ordinal: requested } : {}),
  });

  if (!data) {
    return (
      <AppShell title="Week Results" current="/results">
        <p className="rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm text-neutral-400">
          No week has been played yet.
        </p>
      </AppShell>
    );
  }

  return (
    <AppShell title="Week Results" subtitle={data.week.displayLabel} current="/results">
      <nav className="flex items-center justify-between gap-3">
        {data.previousOrdinal ? (
          <Link
            href={`/results?week=${data.previousOrdinal}`}
            className="rounded-lg border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300"
          >
            ← Previous
          </Link>
        ) : (
          <span />
        )}
        {data.nextOrdinal ? (
          <Link
            href={`/results?week=${data.nextOrdinal}`}
            className="rounded-lg border border-neutral-800 px-3 py-1.5 text-sm text-neutral-300"
          >
            Next →
          </Link>
        ) : (
          <span />
        )}
      </nav>

      {!data.revealed ? (
        <p className="rounded-xl border border-amber-800 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
          {data.week.displayLabel} has not locked yet, so only your own picks are shown.
        </p>
      ) : null}

      <section className="flex flex-col gap-3">
        {data.gamesInWeek.map((game) => (
          <GameCard key={game.gameId} game={game} />
        ))}
        {data.gamesInWeek.length === 0 ? (
          <p className="text-sm text-neutral-500">No games scheduled for this week yet.</p>
        ) : null}
      </section>
    </AppShell>
  );
}

function GameCard({ game }: { game: ResultGame }) {
  const finished = game.status === "final";

  return (
    <article
      className={`rounded-xl border p-3 ${
        game.isTie ? "border-amber-600 bg-amber-950/20" : "border-neutral-800"
      }`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1">
        <h2 className="text-sm font-medium">
          {game.away.name} <span className="text-neutral-500">vs</span> {game.home.name}
        </h2>
        <p className="text-[11px] uppercase tracking-wide text-neutral-500">
          {finished ? "Final" : formatKickoff(game.kickoffAt)}
        </p>
      </header>

      {game.isTie ? (
        <p className="mx-1 mt-2 rounded-lg bg-amber-900/50 px-3 py-1.5 text-xs font-semibold text-amber-100">
          TIE — every pick on both teams is eliminated
        </p>
      ) : null}

      {game.status === "canceled" ? (
        <p className="mx-1 mt-2 rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-semibold text-neutral-200">
          CANCELED — picks on this game are void and survive
        </p>
      ) : null}

      {game.status === "postponed" ? (
        <p className="mx-1 mt-2 rounded-lg bg-neutral-800 px-3 py-1.5 text-xs font-semibold text-neutral-200">
          POSTPONED — this week cannot be graded until it is played
        </p>
      ) : null}

      <div className="mt-2 flex flex-col gap-2">
        {[game.away, game.home].map((team) => {
          const won = game.winnerTeamId === team.id;
          const picks = game.selections.filter((selection) => selection.teamId === team.id);

          return (
            <div key={team.id} className="rounded-lg bg-neutral-900 px-3 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 truncate text-sm">
                  <span className={won ? "font-semibold" : "font-medium"}>{team.name}</span>{" "}
                  {finished ? (
                    <span className="text-[11px] uppercase text-neutral-500">
                      {won ? "won" : game.isTie ? "tied" : "lost"}
                    </span>
                  ) : null}
                </p>
                {team.score !== null ? (
                  <span className="text-base font-semibold tabular-nums">{team.score}</span>
                ) : null}
              </div>

              {picks.length > 0 ? (
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {picks.map((pick) => (
                    <li
                      key={`${pick.userId}-${pick.slotLabel}`}
                      className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] ${
                        pick.isViewer ? "border-neutral-600" : "border-neutral-800"
                      }`}
                    >
                      <span className={pick.isViewer ? "font-medium" : "text-neutral-400"}>
                        {pick.displayName} · {pick.slotLabel}
                      </span>
                      <ResultBadge result={pick.result} wasAutoAssigned={pick.wasAutoAssigned} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </article>
  );
}
