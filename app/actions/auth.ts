"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { destroySession, requestLoginLink } from "@/lib/auth/service";
import { clearSessionCookie, readSessionToken } from "@/lib/auth/session-cookie";
import { getDatabase } from "@/lib/db/client";
import { createMailer } from "@/lib/mail";

export interface SignInState {
  status: "idle" | "sent" | "error";
  message: string;
}

async function resolveBaseUrl(): Promise<string> {
  const configured = process.env.APP_URL?.trim();
  if (configured) return configured;

  const store = await headers();
  const host = store.get("x-forwarded-host") ?? store.get("host") ?? "localhost:3000";
  const proto = store.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function requestLinkAction(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const email = String(formData.get("email") ?? "");
  const joinCode = String(formData.get("joinCode") ?? "");
  const displayName = String(formData.get("displayName") ?? "");

  if (!email.includes("@")) {
    return { status: "error", message: "Please enter a valid email address." };
  }

  const { db } = await getDatabase();
  const result = await requestLoginLink(
    db,
    { email, joinCode: joinCode || undefined, displayName: displayName || undefined },
    { mailer: createMailer(), baseUrl: await resolveBaseUrl() },
  );

  if (!result.ok) return { status: "error", message: result.message };

  // Deliberately the same message whether or not the address is in the league:
  // this page must not become a way to find out who is playing.
  return {
    status: "sent",
    message: "If that address belongs to the league, a sign-in link is on its way. It expires in 15 minutes.",
  };
}

export async function signOutAction(): Promise<void> {
  const token = await readSessionToken();
  if (token) {
    const { db } = await getDatabase();
    await destroySession(db, token);
  }
  await clearSessionCookie();
  redirect("/signin");
}
