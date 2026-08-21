import { NextResponse } from "next/server";

import { getDatabase } from "@/lib/db/client";
import { checkSchemaState, describeSchemaState } from "@/lib/db/schema-check";

/**
 * Deploy-time and runtime health.
 *
 * Exists so that a build deployed ahead of its migration fails LOUDLY here --
 * in a CI step that can be read -- rather than silently, as a member unable to
 * sign in. Returns 503 when the database is missing migrations this build
 * needs, which is what the post-deploy workflow checks.
 *
 * Deliberately says nothing about the connection, the host, or any data:
 * migration tags and counts only, so it is safe to leave unauthenticated.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const { db } = await getDatabase();
    const schema = await checkSchemaState(db);

    return NextResponse.json(
      {
        ok: schema.ok,
        schema: {
          status: describeSchemaState(schema),
          expected: schema.expected,
          applied: schema.applied,
          pending: schema.pending,
          ahead: schema.ahead,
        },
      },
      { status: schema.ok ? 200 : 503 },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
