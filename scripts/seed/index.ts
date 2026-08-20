import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";

import { createAuditRecorder } from "@/lib/audit/writer";
import {
  createUser,
  getRoster,
  setPicksPurchased,
  type AdminActor,
  type RosterEntry,
} from "@/lib/admin";
import { DEFAULT_LEAGUE_CONFIG } from "@/lib/config";
import { createDatabase, type Database } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import {
  games,
  leagues,
  pickSlots,
  selections,
  teams as teamsTable,
  users,
  weekStates,
  type GameRow,
  type TeamRow,
  type UserRow,
} from "@/lib/db/schema";
import { allWeekDescriptors, REGULAR_SEASON_WEEKS } from "@/lib/week/ordinal";

import { argInt, argString, loadEnv, parseArgs } from "../env";
import { dropEverything, truncateAll } from "../reset";
import { createRng } from "./rng";
import {
  generatePostseason,
  generateRegularSeason,
  type FixtureGame,
  type FixtureTeam,
} from "./schedule";

/**
 * Seeds a complete fake season: 32 real teams, a structurally valid 272-game
 * regular season, the full postseason bracket with the Pro Bowl week skipped,
 * and a roster of entrants whose slots are created through the real
 * provisioning service rather than by raw insert -- so seeding exercises SS4
 * instead of going around it.
 *
 *   npm run db:seed                      # results through week 10
 *   npm run db:seed -- --through 18      # whole regular season graded
 *   npm run db:seed -- --through 23      # entire season including the Super Bowl
 *   npm run db:seed -- --no-anomalies    # omit the canceled/postponed games
 *
 * Idempotent: it truncates first and every random choice comes from a seeded
 * PRNG, so two runs produce the same season down to the scores. Row UUIDs are
 * database-generated and will differ; nothing depends on them.
 *
 * GRADING SHORTCUT: this script marks selections survived/eliminated directly
 * using the plain SS5.1 outcomes so that the fixture has a realistic mix of
 * graded weeks and live entrants. It is NOT the rules engine and must not grow
 * into one -- Phase 2 owns gradeWeek(), and this shortcut deliberately handles
 * only the simple cases (win / loss / tie / canceled).
 */

const SEED = 20260820;
/** Chance a fixture entrant picks the team that actually lost. */
const SURVIVAL_RATE = 0.9;
/** Chance a fixture selection is marked as having been auto-assigned at lock. */
const AUTO_ASSIGN_RATE = 0.08;

interface SeedOptions {
  seasonYear: number;
  /** display_ordinal through which results exist. 1-18 regular, 19-23 postseason. */
  through: number;
  includeAnomalies: boolean;
}

const FIXTURE_USERS: ReadonlyArray<{
  displayName: string;
  email: string;
  role: UserRow["role"];
  picks: number;
  paymentStatus: UserRow["paymentStatus"];
  paymentNote: string | null;
}> = [
  { displayName: "Dana Okafor", email: "dana@example.com", role: "admin", picks: 10, paymentStatus: "paid", paymentNote: "$100 Venmo 2024-08-28" },
  { displayName: "Marcus Bell", email: "marcus@example.com", role: "player", picks: 10, paymentStatus: "paid", paymentNote: "$100 cash 2024-08-30" },
  { displayName: "Priya Raman", email: "priya@example.com", role: "player", picks: 10, paymentStatus: "paid", paymentNote: "$100 Venmo 2024-09-02" },
  { displayName: "Tom Whitaker", email: "tom@example.com", role: "player", picks: 8, paymentStatus: "paid", paymentNote: "$80 Zelle 2024-09-03" },
  { displayName: "Elena Duarte", email: "elena@example.com", role: "player", picks: 5, paymentStatus: "paid", paymentNote: "$50 Venmo 2024-09-04" },
  { displayName: "Jae-won Park", email: "jaewon@example.com", role: "player", picks: 3, paymentStatus: "comped", paymentNote: "Comped - ran last year's pool" },
  { displayName: "Rita Alvarez", email: "rita@example.com", role: "player", picks: 10, paymentStatus: "paid", paymentNote: "$100 cash 2024-09-05" },
  // SS2: a user with picks_purchased = 0 can log in and view but cannot submit.
  { displayName: "Sam Cole", email: "sam@example.com", role: "player", picks: 0, paymentStatus: "unpaid", paymentNote: "Said he's in, hasn't paid" },
];

function loadTeamFixtures(): Array<Omit<TeamRow, "id">> {
  const path = fileURLToPath(new URL("../../fixtures/teams.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Array<Omit<TeamRow, "id">>;
}

export async function seed(db: Database, options: SeedOptions): Promise<void> {
  const rng = createRng(SEED);
  await truncateAll(db);

  // --- teams -------------------------------------------------------------
  const insertedTeams = await db.insert(teamsTable).values(loadTeamFixtures()).returning();
  const fixtureTeams: FixtureTeam[] = insertedTeams.map((team) => ({
    id: team.id,
    abbreviation: team.abbreviation,
    conference: team.conference,
  }));

  // --- league ------------------------------------------------------------
  await db.insert(leagues).values({
    name: "The Loser Survivor League",
    seasonYear: options.seasonYear,
    joinCode: "LOSERS",
    config: DEFAULT_LEAGUE_CONFIG,
  });

  // --- schedule ----------------------------------------------------------
  const regular = generateRegularSeason(fixtureTeams, options.seasonYear, rng, { tieInWeek: 3 });
  const postseason = generatePostseason(
    fixtureTeams,
    options.seasonYear,
    rng,
    regular.winsByTeamId,
  );
  const fixtureGames = [...regular.games, ...postseason.games];

  // --- week_state --------------------------------------------------------
  // lock_at is the earliest kickoff in the week, per lockPolicy "first_kickoff".
  const earliestKickoff = new Map<number, Date>();
  for (const game of fixtureGames) {
    const current = earliestKickoff.get(game.displayOrdinal);
    if (!current || game.kickoffAt < current) {
      earliestKickoff.set(game.displayOrdinal, game.kickoffAt);
    }
  }

  const descriptors = allWeekDescriptors();
  const firstOpenOrdinal = descriptors.find(
    (week) => !week.skipped && week.displayOrdinal > options.through,
  )?.displayOrdinal;

  const insertedWeeks = await db
    .insert(weekStates)
    .values(
      descriptors.map((week) => ({
        seasonYear: options.seasonYear,
        seasonType: week.seasonType,
        weekNumber: week.weekNumber,
        displayOrdinal: week.displayOrdinal,
        displayLabel: week.displayLabel,
        lockAt: earliestKickoff.get(week.displayOrdinal) ?? null,
        // SS3.1: the Pro Bowl week exists, is skipped, and never opens.
        status: week.skipped
          ? ("skipped" as const)
          : week.displayOrdinal < options.through
            ? ("graded" as const)
            : week.displayOrdinal === options.through
              ? ("locked" as const)
              : week.displayOrdinal === firstOpenOrdinal
                ? ("open" as const)
                : ("upcoming" as const),
        lastSyncedAt: new Date(),
      })),
    )
    .returning();

  const weekByOrdinal = new Map(insertedWeeks.map((week) => [week.displayOrdinal, week]));

  // --- games -------------------------------------------------------------
  // SS13 tests 15 and 16 need both shapes to exist in real data: a canceled game
  // voids its selections, a postponed one blocks grading of its week. The
  // postponed game is placed in the locked (ungraded) week so the fixture stays
  // internally consistent -- a graded week containing a postponed game would be
  // a state the rules engine is supposed to make impossible.
  const throughWeekGames = fixtureGames.filter(
    (game) => game.displayOrdinal === options.through,
  );
  const canceledEventId =
    options.includeAnomalies && options.through >= 4
      ? fixtureGames.find((game) => game.displayOrdinal === 4)?.espnEventId
      : undefined;
  // Never postpone a week's only game -- that would postpone the Super Bowl
  // when seeding a complete season, leaving the league with no result at all.
  const postponedEventId =
    options.includeAnomalies && throughWeekGames.length >= 2
      ? throughWeekGames[0]?.espnEventId
      : undefined;

  const insertedGames = await db
    .insert(games)
    .values(
      fixtureGames.map((game) => {
        const week = weekByOrdinal.get(game.displayOrdinal);
        if (!week) throw new Error(`No week_state for ordinal ${game.displayOrdinal}`);

        const played = game.displayOrdinal <= options.through;
        const canceled = game.espnEventId === canceledEventId;
        const postponed = game.espnEventId === postponedEventId;
        const status = canceled
          ? ("canceled" as const)
          : postponed
            ? ("postponed" as const)
            : played
              ? ("final" as const)
              : ("scheduled" as const);
        const hasScore = status === "final";

        return {
          espnEventId: game.espnEventId,
          seasonYear: options.seasonYear,
          seasonType: game.seasonType,
          weekNumber: game.weekNumber,
          weekStateId: week.id,
          kickoffAt: game.kickoffAt,
          homeTeamId: game.homeTeamId,
          awayTeamId: game.awayTeamId,
          homeScore: hasScore ? game.homeScore : null,
          awayScore: hasScore ? game.awayScore : null,
          status,
          winnerTeamId: hasScore ? game.winnerTeamId : null,
        };
      }),
    )
    .returning();

  // --- users and pick slots ---------------------------------------------
  const systemActor: AdminActor = {
    actorUserId: null,
    actorRole: "system",
    reason: "Initial season provisioning (seed script)",
    // The fixture season is in the past, so picks are already frozen by the
    // time we provision. Seeding therefore goes through the SS4 override path
    // on purpose -- it is the same path an admin uses, and exercising it here
    // means a broken freeze check shows up immediately.
    override: true,
  };

  // The seed provisions through the real service, so it writes real audit
  // entries too -- which is what gives the League Log something to show.
  const recorder = createAuditRecorder(db);
  const createdUsers: UserRow[] = [];
  for (const fixture of FIXTURE_USERS) {
    const created = await createUser(
      db,
      {
        email: fixture.email,
        displayName: fixture.displayName,
        role: fixture.role,
        paymentStatus: fixture.paymentStatus,
        paymentNote: fixture.paymentNote,
      },
      systemActor,
      recorder,
    );
    if (!created.ok) throw new Error(`Seed failed creating ${fixture.email}: ${created.error.message}`);

    const provisioned = await setPicksPurchased(
      db,
      { userId: created.value.id, picksPurchased: fixture.picks },
      systemActor,
      recorder,
    );
    if (!provisioned.ok) {
      throw new Error(`Seed failed provisioning ${fixture.email}: ${provisioned.error.message}`);
    }

    createdUsers.push(provisioned.value.user);
  }

  await seedSelections(db, {
    options,
    rng,
    insertedGames,
    weekByOrdinal,
  });
}

interface SelectionSeedContext {
  options: SeedOptions;
  rng: ReturnType<typeof createRng>;
  insertedGames: GameRow[];
  weekByOrdinal: Map<number, typeof weekStates.$inferSelect>;
}

async function seedSelections(db: Database, context: SelectionSeedContext): Promise<void> {
  const { options, rng, insertedGames, weekByOrdinal } = context;

  const gamesByWeekId = new Map<string, GameRow[]>();
  for (const game of insertedGames) {
    const bucket = gamesByWeekId.get(game.weekStateId);
    if (bucket) bucket.push(game);
    else gamesByWeekId.set(game.weekStateId, [game]);
  }

  const playedOrdinals = [...weekByOrdinal.values()]
    .filter((week) => week.status !== "skipped" && week.displayOrdinal <= options.through)
    .sort((a, b) => a.displayOrdinal - b.displayOrdinal);

  // Ordered by email, never by user_id: ids are random UUIDs, and because every
  // slot draws from the shared PRNG stream in turn, iterating them in a
  // different order would hand out a different season on every run.
  const slotRows = await db
    .select({ slot: pickSlots, email: users.email })
    .from(pickSlots)
    .innerJoin(users, eq(users.id, pickSlots.userId))
    .orderBy(users.email, pickSlots.slotNumber);
  const slots = slotRows.map((row) => row.slot);

  const rows: Array<typeof selections.$inferInsert> = [];
  const eliminations: Array<{
    slotId: string;
    seasonType: number;
    weekNumber: number;
    reason: "team_won" | "tie";
    at: Date;
  }> = [];

  for (const slot of slots) {
    for (const week of playedOrdinals) {
      const weekGames = gamesByWeekId.get(week.id) ?? [];
      if (weekGames.length === 0) continue;

      const game = rng.pick(weekGames);

      // Fixture entrants are decent at this: most of the time they land on the
      // team that actually lost. Straight coin flips would wipe the league out
      // by week 6 and leave nothing interesting to look at.
      const preferLoser = rng.next() < SURVIVAL_RATE;
      const teamId =
        game.winnerTeamId === null
          ? rng.pick([game.homeTeamId, game.awayTeamId])
          : preferLoser
            ? game.winnerTeamId === game.homeTeamId
              ? game.awayTeamId
              : game.homeTeamId
            : game.winnerTeamId;

      const isCurrentWeek = week.displayOrdinal === options.through;
      let result: "pending" | "survived" | "eliminated" | "void" = "pending";

      if (!isCurrentWeek) {
        if (game.status === "canceled") {
          result = "void";
        } else if (game.status === "postponed") {
          result = "pending";
        } else if (game.winnerTeamId === null) {
          result = "eliminated"; // SS5.1: a tie eliminates every pick on both teams.
        } else if (game.winnerTeamId === teamId) {
          result = "eliminated";
        } else {
          result = "survived";
        }
      }

      const submittedAt = new Date(game.kickoffAt.getTime() - 2 * 60 * 60 * 1000);

      rows.push({
        pickSlotId: slot.id,
        weekStateId: week.id,
        seasonType: week.seasonType,
        weekNumber: week.weekNumber,
        teamId,
        gameId: game.id,
        submittedAt,
        submittedByUserId: slot.userId,
        wasAutoAssigned: rng.next() < AUTO_ASSIGN_RATE,
        result,
        gradedAt: result === "pending" ? null : game.kickoffAt,
      });

      if (result === "eliminated") {
        eliminations.push({
          slotId: slot.id,
          seasonType: week.seasonType,
          weekNumber: week.weekNumber,
          reason: game.winnerTeamId === null ? "tie" : "team_won",
          at: game.kickoffAt,
        });
        break; // A pick is eliminated permanently; it makes no further selections.
      }
    }
  }

  if (rows.length > 0) {
    await db.insert(selections).values(rows);
  }

  for (const elimination of eliminations) {
    await db
      .update(pickSlots)
      .set({
        status: "eliminated",
        eliminatedSeasonType: elimination.seasonType,
        eliminatedWeek: elimination.weekNumber,
        eliminatedReason: elimination.reason,
        eliminatedAt: elimination.at,
      })
      .where(eq(pickSlots.id, elimination.slotId));
  }
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const options: SeedOptions = {
    seasonYear: argInt(args, "season-year", 2024),
    through: argInt(args, "through", 10),
    includeAnomalies: args.get("no-anomalies") !== true,
  };

  if (options.through < 1 || options.through > 23) {
    throw new Error("--through must be a display_ordinal between 1 and 23");
  }

  const handle = await createDatabase(
    process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL,
  );

  try {
    // A full reset, not a truncate: audit_log is append-only and nothing may
    // delete from it, so starting over means recreating the schema.
    await dropEverything(handle.db);
    await runMigrations(handle);
    await seed(handle.db, options);

    const roster = await getRoster(handle.db);
    const played = options.through <= REGULAR_SEASON_WEEKS
      ? `regular-season week ${options.through}`
      : `postseason (ordinal ${options.through})`;

    console.log(`\nSeeded ${options.seasonYear} fixture season through ${played}.`);
    console.log(`Anomalies (canceled + postponed games): ${options.includeAnomalies ? "on" : "off"}\n`);
    console.log(formatRoster(roster));
  } finally {
    await handle.close();
  }
}

function formatRoster(roster: RosterEntry[]): string {
  const header = ["Player", "Pay", "Bought", "Alive", "Out", "Note"];
  const rows = roster.map((entry) => [
    entry.displayName + (entry.role === "admin" ? " (admin)" : ""),
    entry.paymentStatus,
    String(entry.picksPurchased),
    String(entry.aliveCount),
    String(entry.eliminatedCount),
    entry.paymentNote ?? "",
  ]);
  const widths = header.map((_, column) =>
    Math.max(header[column]?.length ?? 0, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");

  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
