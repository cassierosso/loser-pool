/**
 * Placeholder. The real screens (SS9) arrive in Phases 4-6; this page exists so
 * the Next build is exercised from Phase 1 rather than discovered to be broken
 * later. It deliberately touches no data.
 */
const PHASES: ReadonlyArray<{ label: string; state: "done" | "next" | "later" }> = [
  { label: "Phase 1 -- Schema, LEAGUE_CONFIG, provisioning, seed", state: "done" },
  { label: "Phase 2 -- Rules engine, auto-assignment, validation", state: "next" },
  { label: "Phase 3 -- ESPN provider and jobs", state: "later" },
  { label: "Phase 4 -- Auth and Make Picks", state: "later" },
  { label: "Phase 5 -- League Board, Week Results, History", state: "later" },
  { label: "Phase 6 -- Audit log, then the admin panel", state: "later" },
  { label: "Phase 7 -- Deploy, cron, prior-season dry run", state: "later" },
];

export default function Home() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Loser Survivor</h1>
        <p className="text-neutral-400">
          Pick the team you think will <strong className="text-neutral-100">lose</strong>. A tie
          eliminates too.
        </p>
      </header>

      <ol className="flex flex-col gap-2 text-sm">
        {PHASES.map((phase) => (
          <li
            key={phase.label}
            className={
              phase.state === "done"
                ? "text-emerald-400"
                : phase.state === "next"
                  ? "text-neutral-100"
                  : "text-neutral-500"
            }
          >
            {phase.state === "done" ? "✓ " : "· "}
            {phase.label}
          </li>
        ))}
      </ol>
    </main>
  );
}
