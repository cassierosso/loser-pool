import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { AnchorPublisher } from "./types";

/**
 * Writes LOG_ANCHOR.md to the working tree.
 *
 * What development uses, and what a self-hosted deployment can use with a cron
 * that commits the file itself. It provides no independent timestamp on its own
 * -- only committing it does.
 */
export function createFileAnchorPublisher(root = process.cwd()): AnchorPublisher {
  return {
    name: "file",

    async read(path) {
      try {
        return readFileSync(resolve(root, path), "utf8");
      } catch {
        return null;
      }
    },

    async write(path, contents) {
      const target = resolve(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents, "utf8");
      return { location: target };
    },
  };
}

/** Test double. */
export function createMemoryAnchorPublisher(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  return {
    name: "memory",
    files,
    async read(path: string) {
      return files.get(path) ?? null;
    },
    async write(path: string, contents: string, message: string) {
      files.set(path, contents);
      return { location: `memory://${path}`, message };
    },
  };
}
