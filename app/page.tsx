import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Signed in, there is nothing to say here that Make Picks does not say better.
  if (await getCurrentUser()) redirect("/picks");

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Loser Survivor</h1>
      <p className="text-neutral-400">
        A private NFL pool. Every week, each of your picks goes on one team you think will{" "}
        <strong className="text-neutral-100">lose</strong>. Back a winner — or a tie — and that pick
        is gone for good. Last one standing takes it.
      </p>
      <Link
        href="/signin"
        className="rounded-lg bg-emerald-600 px-4 py-3 text-center text-base font-semibold text-white"
      >
        Sign in
      </Link>
    </main>
  );
}
