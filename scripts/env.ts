import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads .env.local then .env for scripts run through tsx. Values already in the
 * environment win, so CI and one-off overrides behave the way people expect.
 */
export function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), file);
    if (existsSync(path)) {
      process.loadEnvFile(path);
    }
  }
}

export function parseArgs(argv: string[]): Map<string, string | boolean> {
  const args = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args.set(key, true);
    } else {
      args.set(key, next);
      i += 1;
    }
  }
  return args;
}

export function argInt(
  args: Map<string, string | boolean>,
  key: string,
  fallback: number,
): number {
  const raw = args.get(key);
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`--${key} must be an integer, got "${raw}"`);
  return parsed;
}

export function argString(
  args: Map<string, string | boolean>,
  key: string,
  fallback: string,
): string {
  const raw = args.get(key);
  return typeof raw === "string" ? raw : fallback;
}
