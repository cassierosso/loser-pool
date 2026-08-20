import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/current-user";

import { SignInForm } from "./sign-in-form";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getCurrentUser()) redirect("/picks");
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Loser Survivor</h1>
        <p className="text-sm text-neutral-400">
          Pick the team you think will <strong className="text-neutral-100">lose</strong>.
          No password — we email you a link.
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-800 bg-red-950/60 px-4 py-3 text-sm text-red-200"
        >
          {error}
        </p>
      ) : null}

      <SignInForm />
    </main>
  );
}
