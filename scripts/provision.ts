import { eq, sql } from "drizzle-orm";

import {
  createUser,
  getRoster,
  setPaymentInfo,
  setPicksPurchased,
  type AdminActor,
  type ProvisionWarning,
  type RosterEntry,
} from "@/lib/admin";
import { createAuditRecorder } from "@/lib/audit/writer";
import { getLeagueConfig } from "@/lib/config";
import { createDatabase, type Database } from "@/lib/db/client";
import { users, type UserRow } from "@/lib/db/schema";

import { argInt, argString, loadEnv, parseArgs } from "./env";

/**
 * SS4 admin provisioning from the command line.
 *
 * Phase 4 brings auth and Phase 6 the admin panel; until then this is how an
 * admin acts, and it calls exactly the same service functions the panel will.
 * Every mutation demands a typed --reason, the same as the UI will, because
 * SS7.6 makes that a server-side rule rather than a form validation.
 *
 *   npm run provision -- roster
 *   npm run provision -- add-user --email dave@example.com --name "Dave" --reason "Joined"
 *   npm run provision -- set-picks --email dave@example.com --picks 8 --reason "Paid $80"
 *   npm run provision -- set-picks --email dave@example.com --picks 9 --reason "..." --override
 *   npm run provision -- set-payment --email dave@example.com --status paid --note "$80 Venmo" --reason "..."
 */

const USAGE = `
Usage: npm run provision -- <command> [options]

Commands:
  roster                            Show the reconciliation table (SS4)
  add-user      --email --name [--role player|admin] --reason
  set-picks     --email --picks N [--override] --reason
  set-payment   --email [--status unpaid|paid|comped] [--note "..."] --reason

Every mutating command requires a non-empty --reason. It is recorded in the
public league log once Phase 6 lands, and is rejected server-side if blank.
`.trim();

function formatRoster(roster: RosterEntry[]): string {
  const header = ["Player", "Email", "Pay", "Bought", "Alive", "Out", "Note"];
  const rows = roster.map((entry) => [
    entry.displayName + (entry.role === "admin" ? " (admin)" : ""),
    entry.email,
    entry.paymentStatus,
    String(entry.picksPurchased),
    String(entry.aliveCount),
    String(entry.eliminatedCount),
    (entry.paymentNote ?? "") + (entry.outOfSync ? "  !! slots out of sync" : ""),
  ]);
  const widths = header.map((_, column) =>
    Math.max(header[column]?.length ?? 0, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");

  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function printWarnings(warnings: ProvisionWarning[]): void {
  for (const warning of warnings) {
    console.warn(`\n[${warning.code}] ${warning.message}`);
    if (warning.slotLabels?.length) {
      console.warn(`  Affected: ${warning.slotLabels.join(", ")}`);
    }
  }
}

async function findUser(db: Database, email: string): Promise<UserRow> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
    .limit(1);

  if (!user) throw new Error(`No user with email ${email}. Run \`roster\` to list them.`);
  return user;
}

function requireReason(args: Map<string, string | boolean>): string {
  const reason = argString(args, "reason", "").trim();
  if (reason === "") {
    throw new Error("--reason is required and cannot be blank. No default text, no placeholder.");
  }
  return reason;
}

async function main(): Promise<void> {
  loadEnv();
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command || command === "help" || args.get("help") === true) {
    console.log(USAGE);
    return;
  }

  const handle = await createDatabase(process.env.DATABASE_URL);
  const db = handle.db;

  try {
    if (command === "roster") {
      const config = await getLeagueConfig(db);
      console.log(
        `\nmaxPicksPerUser: ${config.maxPicksPerUser}   ` +
          `defaultPicksPerUser: ${config.defaultPicksPerUser}   ` +
          `picksFrozenAt: ${config.picksFrozenAt}\n`,
      );
      console.log(formatRoster(await getRoster(db)));
      return;
    }

    const actor: AdminActor = {
      // Phase 4 supplies a real signed-in admin; until then the CLI acts as the
      // system, which is exactly how the seed script is recorded too.
      actorUserId: null,
      actorRole: "system",
      reason: requireReason(args),
      override: args.get("override") === true,
    };

    if (command === "add-user") {
      const result = await createUser(
        db,
        {
          email: argString(args, "email", ""),
          displayName: argString(args, "name", ""),
          role: argString(args, "role", "player") === "admin" ? "admin" : "player",
        },
        actor,
        createAuditRecorder(db),
      );
      if (!result.ok) throw new Error(result.error.message);
      console.log(`Created ${result.value.displayName} <${result.value.email}> with 0 picks.`);
      console.log("Provision their picks with: npm run provision -- set-picks --email ... --picks N --reason ...");
      return;
    }

    if (command === "set-picks") {
      const user = await findUser(db, argString(args, "email", ""));
      const result = await setPicksPurchased(
        db,
        { userId: user.id, picksPurchased: argInt(args, "picks", -1) },
        actor,
        createAuditRecorder(db),
      );

      if (!result.ok) {
        console.error(`\nREJECTED (${result.error.code}): ${result.error.message}`);
        if (result.error.blockingSlots?.length) {
          console.error("\nBlocked by:");
          for (const slot of result.error.blockingSlots) {
            console.error(`  ${slot.label} -- ${slot.reason} (${slot.selectionCount} selections)`);
          }
        }
        process.exitCode = 1;
        return;
      }

      const { created, removed } = result.value;
      console.log(
        `${user.displayName} now has ${result.value.user.picksPurchased} picks ` +
          `(+${created.length} / -${removed.length}).`,
      );
      printWarnings(result.value.warnings);
      return;
    }

    if (command === "set-payment") {
      const user = await findUser(db, argString(args, "email", ""));
      const status = args.get("status");
      const note = args.get("note");
      const result = await setPaymentInfo(
        db,
        {
          userId: user.id,
          ...(typeof status === "string"
            ? { paymentStatus: status as UserRow["paymentStatus"] }
            : {}),
          ...(typeof note === "string" ? { paymentNote: note } : {}),
        },
        actor,
        createAuditRecorder(db),
      );
      if (!result.ok) throw new Error(result.error.message);
      console.log(
        `${result.value.displayName}: ${result.value.paymentStatus}` +
          (result.value.paymentNote ? ` -- ${result.value.paymentNote}` : ""),
      );
      return;
    }

    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

try {
  await main();
} catch (error) {
  // Operator error (a blank reason, an unknown email) should read as a plain
  // sentence, not a stack trace.
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
