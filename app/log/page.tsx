import Link from "next/link";

import { ChainBadge } from "@/components/chain-badge";
import { AppShell } from "@/components/app-shell";
import { getChainStatus } from "@/lib/audit/badge";
import { markLogViewed } from "@/lib/audit/banner";
import { listAuditActions, listAuditEntries, type AuditEntryView } from "@/lib/audit/query";
import { requireUser } from "@/lib/auth/current-user";
import { getDatabase } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { formatKickoff } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * SS7.5 -- the League Log.
 *
 * "Readable by every logged-in league member, not just admins. Its own screen,
 * linked from the main nav, not buried in settings." So: requireUser, never
 * requireAdmin.
 */
export default async function LogPage({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string; action?: string; player?: string; all?: string }>;
}) {
  const viewer = await requireUser();
  const { db } = await getDatabase();
  const params = await searchParams;

  // SS7.5: the post-lock banner clears once every member has looked. This is
  // the looking.
  await markLogViewed(db, viewer.id);

  // SS7.5: "Default view shows admin actions only, since those are the ones
  // under scrutiny."
  const adminOnly = params.all !== "1";

  const [status, { entries, total }, actions, everyone] = await Promise.all([
    getChainStatus(),
    listAuditEntries(db, {
      adminOnly,
      ...(params.actor ? { actorUserId: params.actor } : {}),
      ...(params.action ? { action: params.action } : {}),
      ...(params.player ? { affectedUserId: params.player } : {}),
      limit: 200,
    }),
    listAuditActions(db),
    db.select({ id: users.id, displayName: users.displayName }).from(users).orderBy(users.displayName),
  ]);

  return (
    <AppShell
      title="League Log"
      subtitle={
        adminOnly
          ? `${total} admin action${total === 1 ? "" : "s"} — filtered`
          : `${total} entr${total === 1 ? "y" : "ies"}`
      }
      current="/log"
    >
      <ChainBadge status={status} />

      <section className="flex flex-col gap-3 rounded-xl border border-neutral-800 p-3">
        <form className="flex flex-col gap-2 sm:flex-row sm:flex-wrap" method="get">
          <select
            name="actor"
            defaultValue={params.actor ?? ""}
            aria-label="Filter by who acted"
            className="rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-2 text-sm"
          >
            <option value="">Anyone acting</option>
            {everyone.map((person) => (
              <option key={person.id} value={person.id}>
                {person.displayName}
              </option>
            ))}
          </select>

          <select
            name="action"
            defaultValue={params.action ?? ""}
            aria-label="Filter by action"
            className="rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-2 text-sm"
          >
            <option value="">Any action</option>
            {actions.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>

          <select
            name="player"
            defaultValue={params.player ?? ""}
            aria-label="Filter by affected player"
            className="rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-2 text-sm"
          >
            <option value="">Anyone affected</option>
            {everyone.map((person) => (
              <option key={person.id} value={person.id}>
                {person.displayName}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 px-1 text-sm text-neutral-300">
            <input type="checkbox" name="all" value="1" defaultChecked={!adminOnly} />
            include system &amp; player actions
          </label>

          <button
            type="submit"
            className="rounded-lg bg-neutral-800 px-3 py-2 text-sm font-medium"
          >
            Apply
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-2 border-t border-neutral-800 pt-3">
          <span className="text-xs text-neutral-500">Export the full log:</span>
          <a
            href="/api/log/export?format=csv"
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs font-medium"
          >
            CSV
          </a>
          <a
            href="/api/log/export?format=json"
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs font-medium"
          >
            JSON
          </a>
          <span className="text-xs text-neutral-600">includes every hash</span>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        {entries.length === 0 ? (
          <p className="rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3 text-sm text-neutral-400">
            {adminOnly ? "No admin actions recorded." : "Nothing recorded yet."}
          </p>
        ) : (
          entries.map((entry) => <LogEntry key={entry.seq} entry={entry} viewerId={viewer.id} />)
        )}
      </section>

      {total > entries.length ? (
        <p className="text-center text-xs text-neutral-500">
          Showing the {entries.length} most recent of {total}.{" "}
          <Link href="/api/log/export?format=json" className="underline underline-offset-4">
            Export for the rest.
          </Link>
        </p>
      ) : null}
    </AppShell>
  );
}

function LogEntry({ entry, viewerId }: { entry: AuditEntryView; viewerId: string }) {
  // SS7.5: self-affecting entries get "a distinct high-contrast treatment".
  const selfAffecting = entry.selfAffecting;

  return (
    <article
      className={`rounded-xl border p-3 ${
        selfAffecting ? "border-amber-500 bg-amber-950/30" : "border-neutral-800"
      }`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium">
          <span className="font-mono text-xs text-neutral-500">#{entry.seq}</span>{" "}
          <span className={entry.actorRole === "admin" ? "text-amber-200" : ""}>
            {entry.actorName ?? "System"}
          </span>{" "}
          <span className="text-neutral-500">{entry.action}</span>
        </h2>
        <p className="text-[11px] uppercase tracking-wide text-neutral-500">
          {formatKickoff(entry.occurredAt)}
        </p>
      </header>

      {selfAffecting ? (
        <p className="mt-2 rounded-lg bg-amber-900/60 px-3 py-1.5 text-xs font-semibold text-amber-100">
          Admin action affecting their own entry
          {entry.actorUserId === viewerId ? " (yours)" : ""}
        </p>
      ) : null}

      <p className="mt-2 text-sm text-neutral-300">{entry.targetLabel}</p>
      <p className="mt-1 text-sm">
        <span className="text-neutral-500">Reason:</span> {entry.reason}
      </p>

      <dl className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded-lg bg-neutral-900 p-2">
          <dt className="text-neutral-500">before</dt>
          <dd className="mt-0.5 break-all font-mono text-neutral-300">
            {JSON.stringify(entry.beforeJson)}
          </dd>
        </div>
        <div className="rounded-lg bg-neutral-900 p-2">
          <dt className="text-neutral-500">after</dt>
          <dd className="mt-0.5 break-all font-mono text-neutral-300">
            {JSON.stringify(entry.afterJson)}
          </dd>
        </div>
      </dl>

      <p className="mt-2 break-all font-mono text-[9px] text-neutral-600">{entry.entryHash}</p>
    </article>
  );
}
