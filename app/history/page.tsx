import { AppShell, ResultBadge } from "@/components/app-shell";
import { requireUser } from "@/lib/auth/current-user";
import { getDatabase } from "@/lib/db/client";
import { getMyPicksHistory, type HistorySlot } from "@/lib/views/history";

export const dynamic = "force-dynamic";

/**
 * SS9 -- My Picks History. Per slot, the full season trail: week, team,
 * outcome, and an auto-assigned marker where it applies.
 *
 * A slot is a persistent entity with its own story, so the page is organised by
 * slot rather than by week -- that is how the season actually reads back.
 */
export default async function HistoryPage() {
  const user = await requireUser();
  const { db } = await getDatabase();
  const history = await getMyPicksHistory(db, user.id);

  return (
    <AppShell
      title="My Picks"
      subtitle={`${history.aliveCount} alive · ${history.eliminatedCount} eliminated`}
      current="/history"
    >
      {history.slots.length === 0 ? (
        <p className="rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm text-neutral-400">
          You don&apos;t have any picks yet. An admin provisions them once your payment is recorded.
        </p>
      ) : (
        history.slots.map((slot) => <SlotTrail key={slot.slot.id} slot={slot} />)
      )}
    </AppShell>
  );
}

function SlotTrail({ slot }: { slot: HistorySlot }) {
  const dead = slot.slot.status === "eliminated";

  return (
    <section className={`rounded-xl border p-3 ${dead ? "border-neutral-900" : "border-neutral-800"}`}>
      <header className="flex items-baseline justify-between gap-3 px-1">
        <h2 className={`text-sm font-semibold ${dead ? "text-neutral-500" : ""}`}>
          {slot.slot.label}
        </h2>
        {dead ? (
          <p className="text-[11px] uppercase tracking-wide text-red-300/80">
            out — {slot.slot.eliminatedReason?.replace(/_/g, " ")}
          </p>
        ) : (
          <p className="text-[11px] uppercase tracking-wide text-emerald-400">alive</p>
        )}
      </header>

      {slot.entries.length === 0 ? (
        <p className="mt-2 px-1 text-sm text-neutral-500">No picks made with this one yet.</p>
      ) : (
        <ol className="mt-2 flex flex-col gap-1.5">
          {slot.entries.map((entry) => (
            <li
              key={entry.displayOrdinal}
              className="flex items-center justify-between gap-3 rounded-lg bg-neutral-900 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="text-xs text-neutral-500">{entry.weekLabel}</span>
                <span className="ml-2 text-sm font-medium">{entry.teamAbbreviation}</span>
                {entry.opponentAbbreviation ? (
                  <span className="ml-1 text-xs text-neutral-500">
                    vs {entry.opponentAbbreviation}
                  </span>
                ) : null}
                {entry.scoreLine ? (
                  <span className="ml-2 text-xs tabular-nums text-neutral-400">
                    {entry.scoreLine}
                  </span>
                ) : null}
              </span>
              <ResultBadge result={entry.result} wasAutoAssigned={entry.wasAutoAssigned} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
