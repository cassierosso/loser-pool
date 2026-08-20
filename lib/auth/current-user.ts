import { cache } from "react";
import { redirect } from "next/navigation";

import { getDatabase } from "@/lib/db/client";
import type { UserRow } from "@/lib/db/schema";

import { resolveSession } from "./service";
import { readSessionToken } from "./session-cookie";

/**
 * The signed-in user, or null.
 *
 * Wrapped in React's cache() so a page that asks several times in one render
 * hits the database once.
 */
export const getCurrentUser = cache(async (): Promise<UserRow | null> => {
  const token = await readSessionToken();
  if (!token) return null;

  const { db } = await getDatabase();
  return resolveSession(db, token);
});

/** For pages that require a session. */
export async function requireUser(): Promise<UserRow> {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  return user;
}

export async function requireAdmin(): Promise<UserRow> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");
  return user;
}
