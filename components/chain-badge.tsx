import type { VerifyResult } from "@/lib/audit/verify";

/**
 * SS7.4's persistent badge: green with the head hash shown IN FULL, or red
 * naming the entry where verification failed.
 *
 * "The red state must be impossible for an admin to dismiss or hide." There is
 * therefore no dismiss control, no collapse, and no prop that suppresses it --
 * the only way to clear it is to make the log verify again.
 */
export function ChainBadge({ status }: { status: VerifyResult }) {
  if (!status.valid) {
    return (
      <section
        role="alert"
        className="rounded-xl border-2 border-red-500 bg-red-950 px-4 py-3"
      >
        <h2 className="text-sm font-bold uppercase tracking-wide text-red-200">
          Log integrity check FAILED at entry #{status.failure.seq}
        </h2>
        <p className="mt-1 text-sm text-red-100">{status.failure.detail}</p>
        <p className="mt-2 text-xs text-red-300/90">
          The league log has been altered. This warning cannot be dismissed.
        </p>
      </section>
    );
  }

  if (status.entries === 0) {
    return (
      <section className="rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-2.5">
        <p className="text-xs text-neutral-400">Nothing has been logged yet.</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-emerald-800 bg-emerald-950/40 px-4 py-2.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-300">
        Log verified · {status.entries} entries
      </p>
      <p className="mt-1 font-mono text-[10px] leading-relaxed break-all text-emerald-200/80">
        #{status.head?.seq} {status.head?.entryHash}
      </p>
      <p className="mt-1 text-[11px] text-emerald-300/70">
        Compare this hash to the one in your weekly digest email.
      </p>
    </section>
  );
}
