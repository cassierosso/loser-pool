"use client";

import { useActionState, useState } from "react";

import {
  passwordSignInAction,
  requestLinkAction,
  type PasswordSignInState,
  type SignInState,
} from "@/app/actions/auth";

const LINK_INITIAL: SignInState = { status: "idle", message: "" };
const PASSWORD_INITIAL: PasswordSignInState = { status: "idle", message: "" };

const FIELD =
  "rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-base outline-none focus:border-neutral-400";

type Mode = "password" | "link" | "join";

/**
 * Three ways in, one form.
 *
 * Password is the default because it is the one that works at 12:55 on a Sunday
 * without a round trip through an email app. The emailed link stays for anyone
 * who has not set a password yet and for anyone who has forgotten one -- it is
 * the recovery path, which is why there is no separate reset flow to build or
 * for anyone to phish.
 */
export function SignInForm() {
  const [mode, setMode] = useState<Mode>("password");
  const [linkState, linkAction, linkPending] = useActionState(requestLinkAction, LINK_INITIAL);
  const [pwState, pwAction, pwPending] = useActionState(passwordSignInAction, PASSWORD_INITIAL);

  if (mode === "password") {
    return (
      <div className="flex flex-col gap-4">
        <form action={pwAction} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Email</span>
            <input type="email" name="email" required autoComplete="email" inputMode="email" className={FIELD} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Password</span>
            <input type="password" name="password" required autoComplete="current-password" className={FIELD} />
          </label>
          <button
            type="submit"
            disabled={pwPending}
            className="rounded-lg bg-emerald-600 px-4 py-3 text-base font-semibold text-white disabled:opacity-50"
          >
            {pwPending ? "Signing in…" : "Sign in"}
          </button>
          {pwState.status === "error" ? (
            <p role="alert" className="rounded-lg border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200">
              {pwState.message}
            </p>
          ) : null}
        </form>

        <div className="flex flex-col gap-2 border-t border-neutral-800 pt-4 text-sm">
          <button type="button" onClick={() => setMode("link")} className="text-neutral-300 underline underline-offset-4">
            Email me a sign-in link instead
          </button>
          <button type="button" onClick={() => setMode("join")} className="text-neutral-400 underline underline-offset-4">
            I have an invite code
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form action={linkAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Email</span>
          <input type="email" name="email" required autoComplete="email" inputMode="email" className={FIELD} />
        </label>

        {mode === "join" ? (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Your name</span>
              <input type="text" name="displayName" required autoComplete="name" className={FIELD} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">League invite code</span>
              <input
                type="text"
                name="joinCode"
                required
                autoCapitalize="characters"
                className={`${FIELD} uppercase`}
              />
            </label>
          </>
        ) : (
          <p className="text-sm text-neutral-400">
            No password needed — we&apos;ll email you a link that signs you in. It works once and
            expires in 15 minutes.
          </p>
        )}

        <button
          type="submit"
          disabled={linkPending}
          className="rounded-lg bg-emerald-600 px-4 py-3 text-base font-semibold text-white disabled:opacity-50"
        >
          {linkPending ? "Sending…" : mode === "join" ? "Join the league" : "Email me a sign-in link"}
        </button>

        {linkState.status !== "idle" ? (
          <p
            role="status"
            className={
              linkState.status === "error"
                ? "rounded-lg border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200"
                : "rounded-lg border border-emerald-800 bg-emerald-950/60 px-4 py-3 text-sm text-emerald-200"
            }
          >
            {linkState.message}
          </p>
        ) : null}
      </form>

      <button
        type="button"
        onClick={() => setMode("password")}
        className="border-t border-neutral-800 pt-4 text-sm text-neutral-300 underline underline-offset-4"
      >
        Back to signing in with a password
      </button>
    </div>
  );
}
