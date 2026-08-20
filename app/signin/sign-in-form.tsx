"use client";

import { useActionState, useState } from "react";

import { requestLinkAction, type SignInState } from "@/app/actions/auth";

const INITIAL: SignInState = { status: "idle", message: "" };

export function SignInForm() {
  const [state, formAction, pending] = useActionState(requestLinkAction, INITIAL);
  const [joining, setJoining] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Email</span>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          inputMode="email"
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-base outline-none focus:border-neutral-400"
        />
      </label>

      {joining ? (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Your name</span>
            <input
              type="text"
              name="displayName"
              required
              autoComplete="name"
              className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-base outline-none focus:border-neutral-400"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">League invite code</span>
            <input
              type="text"
              name="joinCode"
              required
              autoCapitalize="characters"
              className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-base uppercase outline-none focus:border-neutral-400"
            />
          </label>
        </>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-emerald-600 px-4 py-3 text-base font-semibold text-white disabled:opacity-50"
      >
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>

      <button
        type="button"
        onClick={() => setJoining((value) => !value)}
        className="text-sm text-neutral-400 underline underline-offset-4"
      >
        {joining ? "I already have an account" : "I have an invite code"}
      </button>

      {state.status !== "idle" ? (
        <p
          role="status"
          className={
            state.status === "error"
              ? "rounded-lg border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200"
              : "rounded-lg border border-emerald-800 bg-emerald-950/60 px-4 py-3 text-sm text-emerald-200"
          }
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
