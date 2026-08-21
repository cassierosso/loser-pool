import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { eq, sql } from "drizzle-orm";

import { createAuditRecorder } from "@/lib/audit/writer";
import { DEFAULT_LEAGUE_CONFIG } from "@/lib/config";
import { createDatabase } from "@/lib/db/client";
import { leagues, teams, users } from "@/lib/db/schema";

import { argString, loadEnv, parseArgs } from "./env";
import { redact } from "./guard";

/**
 * Sets up a REAL league. Safe to run against production, and safe to run twice.
 *
 * This is the counterpart to `db:seed`, which invents eight entrants and a
 * whole fake season -- perfect for development, catastrophic here. Bootstrap
 * creates only the three things a real league cannot start without:
 *
 *   1. the league row, with its config and join code
 *   2. the 32 NFL teams
 *   3. the first admin, who cannot be created from inside the app
 *
 * Everything else is the league's own doing: syncSchedule imports the real
 * fixtures and week rows, and the admin provisions entrants as they pay.
 *
 *   npm run bootstrap -- --name "The Loser Survivor League" --season 2025 \
 *     --admin-email you@example.com --admin-name "Cassie"
 */

interface FixtureTeam {
  espnTeamId: string;
  abbreviation: string;
  displayName: string;
  logoUrl: string | null;
  conference: string;
  division: string;
}

function randomJoinCode(): string {
  // No I/O/0/1: this gets read aloud and typed on a phone.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(
    { length: 6 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join("");
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  const name = argString(args, "name", "Loser Survivor");
  const seasonYear = Number.parseInt(argString(args, "season", ""), 10);
  const joinCode = argString(args, "join-code", randomJoinCode()).toUpperCase();
  const adminEmail = argString(args, "admin-email", "").trim().toLowerCase();
  const adminName = argString(args, "admin-name", "").trim();

  if (Number.isNaN(seasonYear)) {
    console.error("--season is required, e.g. --season 2025");
    process.exit(1);
  }
  if (!adminEmail || !adminName) {
    console.error("--admin-email and --admin-name are required for the first admin.");
    process.exit(1);
  }

  const handle = await createDatabase();
  const { db } = handle;
  console.log(`Bootstrapping ${redact(process.env.DATABASE_URL ?? "local PGlite")}\n`);

  // --- the league -----------------------------------------------------------
  const [existingLeague] = await db.select().from(leagues).limit(1);
  let leagueId: string;

  if (existingLeague) {
    leagueId = existingLeague.id;
    console.log(`league       already exists: "${existingLeague.name}" (${existingLeague.seasonYear})`);
    console.log(`             join code: ${existingLeague.joinCode}`);
  } else {
    const [created] = await db
      .insert(leagues)
      .values({ name, seasonYear, joinCode, config: DEFAULT_LEAGUE_CONFIG })
      .returning();
    leagueId = created!.id;
    console.log(`league       created: "${name}" (${seasonYear})`);
    console.log(`             join code: ${joinCode}   <- share this with your league`);
  }

  // --- the teams ------------------------------------------------------------
  const fixture = JSON.parse(
    readFileSync(resolve(process.cwd(), "fixtures/teams.json"), "utf8"),
  ) as FixtureTeam[];

  const [teamRow] = await db.select({ count: sql<number>`count(*)::int` }).from(teams);
  const teamCount = teamRow?.count ?? 0;

  if (teamCount > 0) {
    console.log(`teams        already present: ${teamCount}`);
  } else {
    await db.insert(teams).values(fixture);
    console.log(`teams        inserted: ${fixture.length}`);
  }

  // --- the first admin ------------------------------------------------------
  const [existingAdmin] = await db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, adminEmail))
    .limit(1);

  if (existingAdmin) {
    if (existingAdmin.role !== "admin") {
      await db.update(users).set({ role: "admin" }).where(eq(users.id, existingAdmin.id));
      console.log(`admin        promoted existing user ${adminEmail}`);
    } else {
      console.log(`admin        already exists: ${adminEmail}`);
    }
  } else {
    const [admin] = await db
      .insert(users)
      .values({
        email: adminEmail,
        displayName: adminName,
        role: "admin",
        // SS4: even the admin starts with nothing. They provision themselves
        // like anyone else, and that action is logged like anyone else's.
        picksPurchased: 0,
        paymentStatus: "unpaid",
      })
      .returning();

    // The very first entry in the chain records how the league began.
    await createAuditRecorder(db).record({
      actorUserId: admin!.id,
      actorRole: "system",
      action: "league.bootstrap",
      targetType: "league",
      targetId: leagueId,
      targetLabel: name,
      beforeJson: {},
      afterJson: { seasonYear, firstAdmin: adminEmail, teams: fixture.length },
      reason: "League bootstrapped",
      selfAffecting: false,
    });

    console.log(`admin        created: ${adminName} <${adminEmail}>`);
  }

  console.log("\nNext:");
  console.log("  1. npm run job -- syncSchedule     (imports real fixtures and week rows)");
  console.log("  2. sign in at your deployment and provision entrants from /admin");

  await handle.close();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
