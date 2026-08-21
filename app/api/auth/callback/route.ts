import { NextResponse } from "next/server";

import { createAuditRecorder } from "@/lib/audit/writer";
import { consumeLoginToken } from "@/lib/auth/service";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/session-cookie";
import { getDatabase } from "@/lib/db/client";

/**
 * SS10: the magic link lands here. The token is exchanged for a session exactly
 * once -- single use is enforced in the database, not by this handler.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MESSAGES: Record<string, string> = {
  invalid: "That sign-in link is not valid. Please request a new one.",
  expired: "That sign-in link has expired. Please request a new one.",
  used: "That sign-in link has already been used. Please request a new one.",
};

export async function GET(request: Request): Promise<NextResponse> {
  const token = new URL(request.url).searchParams.get("token");
  const origin = new URL(request.url).origin;

  if (!token) {
    return NextResponse.redirect(`${origin}/signin?error=${encodeURIComponent(MESSAGES.invalid!)}`);
  }

  const { db } = await getDatabase();
  const result = await consumeLoginToken(db, token);

  if (!result.ok) {
    return NextResponse.redirect(
      `${origin}/signin?error=${encodeURIComponent(MESSAGES[result.code] ?? MESSAGES.invalid!)}`,
    );
  }

  // The cookie goes on THIS response. Setting it via the cookies() store does
  // not attach it to a redirect, which lands the user back on the sign-in page
  // with a perfectly valid session they never received.
  const response = NextResponse.redirect(`${origin}/picks`);
  response.cookies.set(SESSION_COOKIE, result.sessionToken, sessionCookieOptions(result.expiresAt));
  return response;
}
