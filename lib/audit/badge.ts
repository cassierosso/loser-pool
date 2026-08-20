import { getDatabase } from "@/lib/db/client";

import { verifyAuditChain, type VerifyResult } from "./verify";

/**
 * SS7.4 -- "Run it on League Board load (cached 5 minutes) and display the
 * result as a persistent badge."
 *
 * Cached in module scope rather than with React's cache(), because the point is
 * to avoid re-walking the whole log on every page view across all users, not
 * merely to deduplicate within one render.
 *
 * Note what is NOT cached: a FAILED result. If the chain is broken, every load
 * re-checks, so the red badge cannot be made to disappear for five minutes by
 * getting the timing right.
 */
const TTL_MS = 5 * 60 * 1000;

let cached: { at: number; result: VerifyResult } | null = null;

export async function getChainStatus(options: { force?: boolean } = {}): Promise<VerifyResult> {
  const now = Date.now();

  if (!options.force && cached && cached.result.valid && now - cached.at < TTL_MS) {
    return cached.result;
  }

  const { db } = await getDatabase();
  const result = await verifyAuditChain(db);
  cached = { at: now, result };
  return result;
}

export function clearChainStatusCache(): void {
  cached = null;
}
