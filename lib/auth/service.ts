import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";

import type { Database } from "@/lib/db/client";
import { leagues, loginTokens, sessions, users, type UserRow } from "@/lib/db/schema";
import type { Mailer } from "@/lib/mail/types";

import { hashPassword, lockoutMsFor, validatePassword, verifyPassword } from "./password";
import {
  generateToken,
  hashToken,
  INVITE_LINK_TTL_MS,
  LOGIN_TOKEN_TTL_MS,
  MAX_ACTIVE_TOKENS_PER_USER,
  SESSION_REFRESH_AFTER_MS,
  SESSION_TTL_MS,
} from "./tokens";

/**
 * SS10 -- passwordless magic-link authentication.
 *
 * No HTTP and no framework in here: the cookie layer sits above this, and every
 * path below is exercised directly in tests against an in-memory database.
 */

export interface RequestLinkInput {
  email: string;
  /** SS10: users join via the league invite code. Required for a new account. */
  joinCode?: string;
  displayName?: string;
}

export interface RequestLinkDeps {
  mailer: Mailer;
  baseUrl: string;
  now?: Date;
}

export type RequestLinkResult =
  | { ok: true; delivered: boolean; created: boolean }
  | { ok: false; code: "invalid_invite_code" | "rate_limited" | "deactivated" | "name_required"; message: string };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function findUserByEmail(db: Database, email: string): Promise<UserRow | undefined> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, email))
    .limit(1);
  return user;
}

/**
 * Sends a login link, creating the account first if a valid invite code came
 * with it.
 *
 * Deliberately does NOT reveal whether an address belongs to the league: a
 * request for an unknown address with no invite code returns ok with
 * delivered:false, and the UI shows the same message either way. An invite code
 * that is simply wrong IS reported, because someone typing a code needs to know
 * they typed it wrong.
 */
export async function requestLoginLink(
  db: Database,
  input: RequestLinkInput,
  deps: RequestLinkDeps,
): Promise<RequestLinkResult> {
  const now = deps.now ?? new Date();
  const email = normalizeEmail(input.email);

  if (!email.includes("@")) {
    return { ok: true, delivered: false, created: false };
  }

  let user = await findUserByEmail(db, email);
  let created = false;

  if (!user) {
    const joinCode = input.joinCode?.trim();
    if (!joinCode) {
      // Unknown address, no code: say nothing about who is in the league.
      return { ok: true, delivered: false, created: false };
    }

    const [league] = await db.select().from(leagues).limit(1);
    if (!league || league.joinCode.toLowerCase() !== joinCode.toLowerCase()) {
      return { ok: false, code: "invalid_invite_code", message: "That invite code is not valid." };
    }

    const displayName = input.displayName?.trim();
    if (!displayName) {
      return { ok: false, code: "name_required", message: "Please enter the name your league knows you by." };
    }

    const [inserted] = await db
      .insert(users)
      .values({
        email,
        displayName,
        role: "player",
        // SS4: joining gets you an account, not picks. An admin provisions
        // those once they have seen your money.
        picksPurchased: 0,
        paymentStatus: "unpaid",
      })
      .returning();

    user = inserted!;
    created = true;
  }

  if (user.deactivatedAt) {
    return { ok: false, code: "deactivated", message: "That account is no longer active." };
  }

  const [active] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(loginTokens)
    .where(
      and(
        eq(loginTokens.userId, user.id),
        isNull(loginTokens.consumedAt),
        gt(loginTokens.expiresAt, now),
      ),
    );

  if ((active?.n ?? 0) >= MAX_ACTIVE_TOKENS_PER_USER) {
    return {
      ok: false,
      code: "rate_limited",
      message: "Too many sign-in links requested. Check your inbox, or try again shortly.",
    };
  }

  const raw = generateToken();
  await db.insert(loginTokens).values({
    userId: user.id,
    tokenHash: hashToken(raw),
    expiresAt: new Date(now.getTime() + LOGIN_TOKEN_TTL_MS),
  });

  const url = `${deps.baseUrl.replace(/\/$/, "")}/api/auth/callback?token=${encodeURIComponent(raw)}`;
  await deps.mailer.send({
    to: user.email,
    subject: "Your Loser Survivor sign-in link",
    text: [
      `Hi ${user.displayName},`,
      "",
      "Here is your sign-in link. It works once and expires in 15 minutes:",
      "",
      url,
      "",
      "If you didn't ask for this, you can ignore it.",
    ].join("\n"),
  });

  return { ok: true, delivered: true, created };
}

export type ConsumeResult =
  | {
      ok: true;
      sessionToken: string;
      user: UserRow;
      expiresAt: Date;
      /** Set when the link was minted by an admin rather than requested. */
      mintedByUserId: string | null;
    }
  | { ok: false; code: "invalid" | "expired" | "used" };

/**
 * Exchanges a magic-link token for a session.
 *
 * Single use is enforced in the database, not in application logic: the UPDATE
 * matches only rows that are still unconsumed, so two simultaneous clicks on
 * the same link cannot both win.
 */
export async function consumeLoginToken(
  db: Database,
  rawToken: string,
  options: { now?: Date } = {},
): Promise<ConsumeResult> {
  const now = options.now ?? new Date();
  const tokenHash = hashToken(rawToken);

  const [existing] = await db
    .select()
    .from(loginTokens)
    .where(eq(loginTokens.tokenHash, tokenHash))
    .limit(1);

  if (!existing) return { ok: false, code: "invalid" };
  if (existing.consumedAt) return { ok: false, code: "used" };
  if (existing.expiresAt.getTime() <= now.getTime()) return { ok: false, code: "expired" };

  const claimed = await db
    .update(loginTokens)
    .set({ consumedAt: now })
    .where(and(eq(loginTokens.id, existing.id), isNull(loginTokens.consumedAt)))
    .returning();

  if (claimed.length === 0) return { ok: false, code: "used" };

  const [user] = await db.select().from(users).where(eq(users.id, existing.userId)).limit(1);
  if (!user || user.deactivatedAt) return { ok: false, code: "invalid" };

  // Signing in invalidates any other outstanding links for this account.
  await db
    .update(loginTokens)
    .set({ consumedAt: now })
    .where(and(eq(loginTokens.userId, user.id), isNull(loginTokens.consumedAt)));

  const sessionToken = generateToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    userId: user.id,
    tokenHash: hashToken(sessionToken),
    expiresAt,
    lastSeenAt: now,
  });

  return {
    ok: true,
    sessionToken,
    user,
    expiresAt,
    mintedByUserId: existing.createdByUserId ?? null,
  };
}

export async function resolveSession(
  db: Database,
  sessionToken: string,
  options: { now?: Date } = {},
): Promise<UserRow | null> {
  const now = options.now ?? new Date();

  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashToken(sessionToken)))
    .limit(1);

  if (!row) return null;
  if (row.session.expiresAt.getTime() <= now.getTime()) return null;
  if (row.user.deactivatedAt) return null;

  /**
   * Slide the expiry forward for anyone still using the app. Without this every
   * member is thrown out on a fixed schedule regardless of activity, which for
   * a season-long league means the whole roster re-authenticating mid-season --
   * quite possibly on the Sunday they least want to.
   *
   * Only written when it has actually moved, to keep this off the hot path of
   * every page render.
   */
  if (now.getTime() - row.session.lastSeenAt.getTime() > SESSION_REFRESH_AFTER_MS) {
    await db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
      .where(eq(sessions.id, row.session.id));
  }

  return row.user;
}

export async function destroySession(db: Database, sessionToken: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(sessionToken)));
}

/** Housekeeping for expired rows; safe to call any time. */
export async function purgeExpiredAuthRows(db: Database, now: Date = new Date()): Promise<void> {
  await db.delete(sessions).where(sql`${sessions.expiresAt} <= ${now}`);
  await db.delete(loginTokens).where(sql`${loginTokens.expiresAt} <= ${now}`);
}


/**
 * Password sign-in.
 *
 * Magic links remain the way in for anyone who has not set a password, and the
 * recovery path for anyone who forgets one -- which is why there is no reset
 * flow. See lib/auth/password.ts for why passwords exist at all.
 */
export type PasswordSignInResult =
  | { ok: true; sessionToken: string; user: UserRow; expiresAt: Date }
  | { ok: false; code: "invalid_credentials" | "locked" | "no_password"; message: string };

export async function signInWithPassword(
  db: Database,
  input: { email: string; password: string },
  options: { now?: Date } = {},
): Promise<PasswordSignInResult> {
  const now = options.now ?? new Date();
  const email = normalizeEmail(input.email);

  const user = await findUserByEmail(db, email);

  /**
   * Every failure below returns the SAME message. The login form must not
   * become the enumeration oracle that requestLoginLink was carefully written
   * not to be -- otherwise "no account with that address" tells a stranger
   * exactly who is in the league.
   */
  const refuse = (code: "invalid_credentials" | "no_password" = "invalid_credentials") =>
    ({
      ok: false as const,
      code,
      message: "That email and password do not match. You can also sign in with an emailed link.",
    });

  if (!user || user.deactivatedAt) {
    // Spend roughly the time a real verification costs, so the response time
    // does not reveal whether the address exists.
    await verifyPassword(input.password, await hashPassword("timing-equalisation"));
    return refuse();
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60_000);
    return {
      ok: false,
      code: "locked",
      message: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or sign in with an emailed link instead.`,
    };
  }

  if (!user.passwordHash) return refuse("no_password");

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    const failed = user.failedLoginCount + 1;
    const lockMs = lockoutMsFor(failed);

    await db
      .update(users)
      .set({
        failedLoginCount: failed,
        lockedUntil: lockMs > 0 ? new Date(now.getTime() + lockMs) : null,
      })
      .where(eq(users.id, user.id));

    return refuse();
  }

  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null })
    .where(eq(users.id, user.id));

  const sessionToken = generateToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    userId: user.id,
    tokenHash: hashToken(sessionToken),
    expiresAt,
    lastSeenAt: now,
  });

  return { ok: true, sessionToken, user, expiresAt };
}

export type SetPasswordResult = { ok: true } | { ok: false; message: string };

/** Setting or changing a password. Requires an existing session, not the old password. */
export async function setPassword(
  db: Database,
  input: { userId: string; password: string },
  options: { now?: Date } = {},
): Promise<SetPasswordResult> {
  const check = validatePassword(input.password);
  if (!check.ok) return { ok: false, message: check.reason };

  const now = options.now ?? new Date();
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(input.password),
      passwordSetAt: now,
      failedLoginCount: 0,
      lockedUntil: null,
    })
    .where(eq(users.id, input.userId));

  return { ok: true };
}

export async function clearPassword(db: Database, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash: null, passwordSetAt: null })
    .where(eq(users.id, userId));
}


/**
 * Mints a sign-in link for another member, for an admin to hand over directly.
 *
 * Exists because email is not always available -- no verified sending domain,
 * or simply a league that communicates in a group chat. The link is the same
 * single-use token the emails carry.
 *
 * This is the most dangerous thing an admin can do in this application. The
 * link signs the holder in AS that member: their picks, their history, their
 * ability to submit. SS7 exists because the admin is also a competitor, and
 * this hands them a key to everyone's front door.
 *
 * It is therefore never quiet. Minting is logged; consuming is logged
 * separately with the admin who minted it named; and the member is shown a
 * notice on their own screen. If an admin uses one of these to peek at a rival's
 * picks, the rival finds out and so does everyone reading the log.
 */
export async function createInviteLink(
  db: Database,
  input: { userId: string; createdByUserId: string; baseUrl: string },
  options: { now?: Date } = {},
): Promise<{ ok: true; url: string; expiresAt: Date } | { ok: false; message: string }> {
  const now = options.now ?? new Date();

  const [user] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!user) return { ok: false, message: "No such member." };
  if (user.deactivatedAt) return { ok: false, message: "That account is no longer active." };

  const raw = generateToken();
  const expiresAt = new Date(now.getTime() + INVITE_LINK_TTL_MS);

  await db.insert(loginTokens).values({
    userId: user.id,
    tokenHash: hashToken(raw),
    expiresAt,
    createdByUserId: input.createdByUserId,
  });

  return {
    ok: true,
    url: `${input.baseUrl.replace(/\/$/, "")}/api/auth/callback?token=${encodeURIComponent(raw)}`,
    expiresAt,
  };
}

/**
 * Whether this member has been signed in through a link an admin minted, and
 * has not yet been told. Drives the notice on their own screen.
 */
export async function pendingAdminLinkNotice(
  db: Database,
  userId: string,
): Promise<{ createdAt: Date; adminName: string | null } | null> {
  const [row] = await db
    .select({ createdAt: loginTokens.createdAt, adminName: users.displayName })
    .from(loginTokens)
    .leftJoin(users, eq(users.id, loginTokens.createdByUserId))
    .where(
      and(
        eq(loginTokens.userId, userId),
        isNotNull(loginTokens.createdByUserId),
        isNotNull(loginTokens.consumedAt),
      ),
    )
    .orderBy(desc(loginTokens.createdAt))
    .limit(1);

  return row ?? null;
}
