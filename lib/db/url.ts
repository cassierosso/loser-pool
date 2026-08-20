/**
 * Single place that decides which Postgres we are talking to.
 *
 * PGlite is an embedded Postgres 16 (WASM) that needs no server; it is the
 * zero-install default for local work and tests. Anything else is treated as a
 * normal Postgres connection string. The SQL is identical either way -- only
 * the driver differs -- so migrations generated here apply unchanged to Neon.
 */
export type DatabaseTarget =
  | { kind: "pglite"; url: string }
  | { kind: "postgres"; url: string };

export const DEFAULT_PGLITE_PATH = "./.pglite";

export function resolveDatabaseUrl(raw: string | undefined): DatabaseTarget {
  const value = raw?.trim();

  if (!value) {
    return { kind: "pglite", url: DEFAULT_PGLITE_PATH };
  }

  if (value.startsWith("pglite://")) {
    const path = value.slice("pglite://".length);
    return { kind: "pglite", url: path === "" || path === "memory" ? "memory://" : path };
  }

  if (value === "memory://" || value === ":memory:") {
    return { kind: "pglite", url: "memory://" };
  }

  return { kind: "postgres", url: value };
}
