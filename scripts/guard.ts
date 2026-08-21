import { resolveDatabaseUrl } from "@/lib/db/url";

/**
 * Stops a destructive script from running against a database that is not local.
 *
 * `db:seed` inserts eight fictional entrants and a whole invented season;
 * `db:reset` drops everything. Both are exactly right for development and
 * catastrophic against the league's real data, and the only thing that
 * distinguishes the two is a connection string in an env file.
 *
 * So the check is here rather than in a comment nobody reads at 11pm.
 */
export function assertLocalDatabase(action: string): void {
  const target = resolveDatabaseUrl(process.env.DATABASE_URL);

  // PGlite is embedded; there is no remote PGlite to protect.
  if (target.kind === "pglite" || isLocalHost(target.url)) return;

  const url = target.url;

  if (process.env.ALLOW_DESTRUCTIVE_REMOTE === "1") {
    console.warn(
      `\n!! ${action} is running against a REMOTE database because ` +
        `ALLOW_DESTRUCTIVE_REMOTE=1 was set.\n   ${redact(url)}\n`,
    );
    return;
  }

  console.error(
    [
      "",
      `REFUSING to ${action}: DATABASE_URL does not look local.`,
      `  ${redact(url)}`,
      "",
      "  This script is destructive and is meant for development databases.",
      "  Production is set up with:  npm run bootstrap",
      "",
      "  If you genuinely mean it, re-run with ALLOW_DESTRUCTIVE_REMOTE=1.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function isLocalHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Never print a password to a terminal or a CI log. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return url;
  }
}
