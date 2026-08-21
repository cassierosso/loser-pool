import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/auth/current-user";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

import { PasswordForm } from "./password-form";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await requireUser();

  return (
    <AppShell title="Account" subtitle={user.email} current="/account">
      <section className="rounded-xl border border-neutral-800 p-4">
        <h2 className="text-sm font-semibold">
          {user.passwordHash ? "Change your password" : "Set a password"}
        </h2>
        <p className="mt-1 text-sm text-neutral-400">
          {user.passwordHash
            ? "You can sign in with your email and password."
            : `Set one and you won't need an emailed link every time — handy when picks lock in ten minutes. At least ${MIN_PASSWORD_LENGTH} characters; a few ordinary words is fine.`}
        </p>
        <PasswordForm hasPassword={Boolean(user.passwordHash)} />
      </section>

      <section className="rounded-xl border border-neutral-800 p-4">
        <h2 className="text-sm font-semibold">Signing in by email</h2>
        <p className="mt-1 text-sm text-neutral-400">
          An emailed link always works, whether or not you have a password — including if you
          forget it. That is why there is no password reset to lose.
        </p>
      </section>
    </AppShell>
  );
}
