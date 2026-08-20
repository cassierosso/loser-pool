import Link from "next/link";

import { signOutAction } from "@/app/actions/auth";
import { requireUser } from "@/lib/auth/current-user";
import { getDatabase } from "@/lib/db/client";
import { getMakePicksData } from "@/lib/picks/queries";
import { formatKickoff } from "@/lib/time";

import { MakePicksForm, type AutoAssignSummary, type MatchupView } from "./make-picks-form";

export const dynamic = "force-dynamic";

/**
 * SS9 -- Make Picks, the main screen. Mobile-first: most people submit from a
 * phone on the couch.
 *
 * Only this user's data is loaded (see lib/picks/queries.ts). Other entrants'
 * selections are never fetched, so they cannot leak into the payload.
 */
export default async function PicksPage() {
  const user = await requireUser();
  const { db } = await getDatabase();
  const data = await getMakePicksData(db, user);

  const team = (row: { id: string; abbreviation: string; displayName: string }) => ({
    id: row.id,
    abbreviation: row.abbreviation,
    name: row.displayName,
  });

  const matchups: MatchupView[] = data.matchups.map((matchup) => ({
    gameId: matchup.game.id,
    kickoffAt: matchup.game.kickoffAt.toISOString(),
    kickoffLabel: formatKickoff(matchup.game.kickoffAt),
    home: team(matchup.home),
    away: team(matchup.away),
  }));

  // SS9: say what happens to picks left unallocated. Counted from the real
  // SS5.2 engine over this entrant's slots, so the warning cannot drift from
  // what lockWeek will actually do.
  const autoAssign: AutoAssignSummary = Object.values(data.autoAssignPreview).reduce(
    (summary, entry) => {
      if (entry.resolution === "repeat_last_week") summary.repeat += 1;
      else if (entry.resolution === "eliminate") summary.eliminate += 1;
      else summary.other += 1;
      return summary;
    },
    { repeat: 0, eliminate: 0, other: 0 } as AutoAssignSummary,
  );

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Make Picks</h1>
          <p className="text-sm text-neutral-400">{user.displayName}</p>
        </div>
        <form action={signOutAction}>
          <button type="submit" className="text-sm text-neutral-400 underline underline-offset-4">
            Sign out
          </button>
        </form>
      </header>

      {user.picksPurchased === 0 ? (
        <Notice tone="warn" title="You don't have any picks yet">
          You can look around, but you can&apos;t submit until an admin records your payment and
          provisions your picks.
        </Notice>
      ) : null}

      {!data.week ? (
        <Notice tone="info" title="No week is open">
          Picks open once the next week&apos;s schedule is published.
        </Notice>
      ) : data.slots.length === 0 && user.picksPurchased > 0 ? (
        <Notice tone="warn" title="All of your picks are out">
          Every pick you had has been eliminated. Nothing more to submit this season.
        </Notice>
      ) : (
        <MakePicksForm
          weekLabel={data.week.displayLabel}
          lockAt={data.week.lockAt?.toISOString() ?? null}
          lockLabel={data.week.lockAt ? formatKickoff(data.week.lockAt) : null}
          matchups={matchups}
          aliveCount={data.slots.length}
          blockBothSides={data.config.bothSidesOfGame === "block"}
          initialAllocation={data.allocationByTeamId}
          autoAssign={autoAssign}
          canSubmit={user.picksPurchased > 0}
        />
      )}

      {data.eliminatedSlots.length > 0 ? (
        <section className="rounded-xl border border-neutral-800 p-4">
          <h2 className="text-sm font-semibold text-neutral-300">Eliminated</h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {data.eliminatedSlots.map((slot) => (
              <li
                key={slot.id}
                className="rounded-full border border-neutral-700 px-3 py-1 text-xs text-neutral-500 line-through"
              >
                {slot.label}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <nav className="text-sm text-neutral-500">
        <Link href="/" className="underline underline-offset-4">
          Back to overview
        </Link>
      </nav>
    </main>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "info" | "warn";
  title: string;
  children: React.ReactNode;
}) {
  const styles =
    tone === "warn"
      ? "border-amber-800 bg-amber-950/40 text-amber-100"
      : "border-neutral-800 bg-neutral-900 text-neutral-300";

  return (
    <section className={`rounded-xl border px-4 py-3 ${styles}`}>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-sm opacity-90">{children}</p>
    </section>
  );
}
