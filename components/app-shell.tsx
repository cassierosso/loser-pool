import Link from "next/link";

import { signOutAction } from "@/app/actions/auth";
import { getCurrentUser } from "@/lib/auth/current-user";

/**
 * Shared chrome. SS9 is mobile-first: the nav is a scrollable strip of pills
 * rather than anything that needs a hamburger on a phone.
 */
const LINKS = [
  { href: "/picks", label: "Make Picks" },
  { href: "/board", label: "League Board" },
  { href: "/results", label: "Week Results" },
  { href: "/history", label: "My Picks" },
  { href: "/account", label: "Account" },
  // SS7.5: the League Log gets its own screen "linked from the main nav, not
  // buried in settings", and is readable by every member.
  { href: "/log", label: "League Log" },
];



export async function AppShell({
  title,
  subtitle,
  current,
  children,
}: {
  title: string;
  subtitle?: string;
  current: string;
  children: React.ReactNode;
}) {
  const viewer = await getCurrentUser();
  // The admin screen is linked only for admins. That is convenience, not
  // security -- the page itself calls requireAdmin.
  const links = viewer?.role === "admin" ? [...LINKS, { href: "/admin", label: "Admin" }] : LINKS;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-5 sm:px-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="truncate text-sm text-neutral-400">{subtitle}</p> : null}
        </div>
        <form action={signOutAction}>
          <button type="submit" className="shrink-0 text-sm text-neutral-400 underline underline-offset-4">
            Sign out
          </button>
        </form>
      </header>

      <nav className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <ul className="flex w-max gap-2">
          {links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={current === link.href ? "page" : undefined}
                className={`block whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm ${
                  current === link.href
                    ? "border-emerald-500 bg-emerald-950/60 text-emerald-100"
                    : "border-neutral-800 text-neutral-400"
                }`}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {children}
    </div>
  );
}

/** survived / eliminated / void / auto-assigned, colour-coded per SS9. */
export function ResultBadge({
  result,
  wasAutoAssigned,
}: {
  result: "pending" | "survived" | "eliminated" | "void";
  wasAutoAssigned?: boolean;
}) {
  const styles: Record<typeof result, string> = {
    survived: "bg-emerald-900/70 text-emerald-200",
    eliminated: "bg-red-900/70 text-red-200",
    void: "bg-neutral-800 text-neutral-300",
    pending: "bg-neutral-800/60 text-neutral-400",
  };

  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${styles[result]}`}>
        {result}
      </span>
      {wasAutoAssigned ? (
        <span
          title="Assigned automatically at lock because no pick was submitted"
          className="rounded-full bg-sky-900/70 px-2 py-0.5 text-[10px] font-semibold uppercase text-sky-200"
        >
          auto
        </span>
      ) : null}
    </span>
  );
}
