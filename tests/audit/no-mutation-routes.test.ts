import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ACCEPTANCE TEST 30 -- "No API route, at any role, permits updating or
 * deleting an audit_log row."
 *
 * The database trigger already makes such a route fail (test 25). This checks
 * the stronger claim SS7.3 layer 1 actually makes: that no such code exists at
 * all. It is a source scan rather than a request, because the guarantee is
 * about absence, and you cannot prove absence by trying a few URLs.
 */

const ROOT = new URL("../../", import.meta.url).pathname;
const SEARCHED = ["app", "lib", "scripts"];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}

const files = SEARCHED.flatMap((dir) => sourceFiles(join(ROOT, dir)));

describe("nothing in the codebase can mutate the audit log", () => {
  it("has sources to scan", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("never calls update() or delete() against auditLog", () => {
    const offenders = files.filter((path) => {
      const source = readFileSync(path, "utf8");
      return (
        /\.update\(\s*auditLog\s*\)/.test(source) || /\.delete\(\s*auditLog\s*\)/.test(source)
      );
    });

    expect(offenders.map((path) => path.replace(ROOT, ""))).toEqual([]);
  });

  it("never issues raw SQL that updates or deletes audit_log", () => {
    const offenders = files.filter((path) => {
      const source = readFileSync(path, "utf8");
      return /(update|delete\s+from)\s+audit_log/i.test(source);
    });

    expect(offenders.map((path) => path.replace(ROOT, ""))).toEqual([]);
  });

  it("writes to audit_log from exactly one module", () => {
    const writers = files.filter((path) => {
      const source = readFileSync(path, "utf8");
      return /\.insert\(\s*auditLog\s*\)/.test(source);
    });

    expect(writers.map((path) => path.replace(ROOT, ""))).toEqual(["lib/audit/writer.ts"]);
  });

  it("does not delete audit entries when resetting the database", () => {
    // truncateAll clears the fixture data. It must not reach the log; starting
    // over means dropping the schema, which is a different act.
    const reset = readFileSync(join(ROOT, "scripts/reset.ts"), "utf8");
    const truncate = reset.slice(reset.indexOf("export async function truncateAll"));
    expect(truncate.slice(0, truncate.indexOf("}"))).not.toContain("auditLog");
  });
});
