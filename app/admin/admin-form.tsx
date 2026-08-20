"use client";

import { useActionState } from "react";

import type { AdminState } from "@/app/actions/admin";

const INITIAL: AdminState = { status: "idle", message: "" };

/**
 * SS7.6: "Admin actions show a confirmation dialog stating plainly: 'This will
 * be recorded in the public league log, visible to all members, permanently.'"
 *
 * Rendered inline above the submit button rather than as a modal, so it is
 * impossible to click past without reading, and the reason field sits inside
 * the same warning -- you type your justification while looking at who will
 * read it.
 */
export function AdminForm({
  action,
  title,
  description,
  children,
  submitLabel,
  danger,
}: {
  action: (prev: AdminState, formData: FormData) => Promise<AdminState>;
  title: string;
  description?: string;
  children: React.ReactNode;
  submitLabel: string;
  danger?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-xl border border-neutral-800 p-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-neutral-400">{description}</p> : null}
      </div>

      {children}

      <label className="flex flex-col gap-1.5 rounded-lg border border-amber-800 bg-amber-950/40 p-3">
        <span className="text-xs font-semibold text-amber-100">
          This will be recorded in the public league log, visible to all members, permanently.
        </span>
        <input
          type="text"
          name="reason"
          required
          placeholder="Why are you doing this?"
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
      </label>

      {state.status !== "idle" ? (
        <p
          role="status"
          className={`rounded-lg px-3 py-2 text-sm ${
            state.status === "error"
              ? "border border-red-800 bg-red-950/60 text-red-200"
              : "border border-emerald-800 bg-emerald-950/60 text-emerald-200"
          }`}
        >
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className={`rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 ${
          danger ? "bg-red-700" : "bg-emerald-600"
        }`}
      >
        {pending ? "Working…" : submitLabel}
      </button>
    </form>
  );
}

export const inputClass =
  "rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm";
