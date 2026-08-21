"use client";

import { useActionState } from "react";

import { setPasswordAction, type SetPasswordState } from "@/app/actions/auth";

const INITIAL: SetPasswordState = { status: "idle", message: "" };

const FIELD =
  "rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-base outline-none focus:border-neutral-400";

export function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const [state, formAction, pending] = useActionState(setPasswordAction, INITIAL);

  return (
    <form action={formAction} className="mt-3 flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">New password</span>
        <input type="password" name="password" required autoComplete="new-password" className={FIELD} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Confirm it</span>
        <input type="password" name="confirm" required autoComplete="new-password" className={FIELD} />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        {pending ? "Saving…" : hasPassword ? "Change password" : "Set password"}
      </button>

      {state.status !== "idle" ? (
        <p
          role="status"
          className={
            state.status === "error"
              ? "rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-sm text-red-200"
              : "rounded-lg border border-emerald-800 bg-emerald-950/60 px-3 py-2 text-sm text-emerald-200"
          }
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
