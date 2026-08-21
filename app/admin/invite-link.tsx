"use client";

import { useActionState, useState } from "react";

import { issueInviteLinkAction, type InviteLinkState } from "@/app/actions/admin";

const INITIAL: InviteLinkState = { status: "idle", message: "" };

/**
 * SS7 -- hand a member a way in without email.
 *
 * The warning is not decoration. This link signs its holder in AS the member,
 * and the admin is also a competitor. Saying so plainly, every time, is the
 * point: an admin who mints one anyway has read the sentence.
 */
export function InviteLinkButton({ userId, displayName }: { userId: string; displayName: string }) {
  const [state, formAction, pending] = useActionState(issueInviteLinkAction, INITIAL);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300"
      >
        Sign-in link
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-amber-700 bg-amber-950/40 p-3">
      <p className="text-xs font-semibold text-amber-100">
        This link signs whoever holds it in as {displayName}.
      </p>
      <p className="mt-1 text-[11px] text-amber-200/90">
        Creating it is recorded in the public league log, using it is recorded separately, and
        {" "}{displayName} is shown a notice that it happened. Send it to them directly — don&apos;t
        post it anywhere others can read.
      </p>

      {state.status === "created" && state.url ? (
        <div className="mt-2 flex flex-col gap-2">
          <code className="block overflow-x-auto rounded bg-neutral-950 px-2 py-1.5 text-[10px] break-all">
            {state.url}
          </code>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(state.url!);
                setCopied(true);
              }}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white"
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs"
            >
              Done
            </button>
          </div>
          <p className="text-[11px] text-amber-200/80">{state.message}</p>
        </div>
      ) : (
        <form action={formAction} className="mt-2 flex flex-col gap-2">
          <input type="hidden" name="userId" value={userId} />
          <input
            type="text"
            name="reason"
            required
            placeholder="Why? (recorded publicly)"
            className="rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {pending ? "Creating…" : "Create link"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs"
            >
              Cancel
            </button>
          </div>
          {state.status === "error" ? (
            <p className="text-[11px] text-red-300">{state.message}</p>
          ) : null}
        </form>
      )}
    </div>
  );
}
