import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createAuditRecorder } from "@/lib/audit/writer";
import { verifyAuditChain } from "@/lib/audit/verify";
import { listAllAuditEntries, listAuditEntries } from "@/lib/audit/query";
import { toCsv, toJson } from "@/lib/audit/export";
import {
  overrideGameResult,
  overrideSelectionResult,
  setSlotStatus,
  setPaymentInfo,
  setPicksPurchased,
  type AdminActor,
} from "@/lib/admin";
import { updateLeagueConfig, DEFAULT_LEAGUE_CONFIG } from "@/lib/config";
import type { Database, DatabaseHandle } from "@/lib/db/client";
import { auditLog, games, leagues, type GameRow, type TeamRow, type WeekStateRow } from "@/lib/db/schema";

import { createTestDatabase, seedTeams, setupLeague } from "../helpers/db";
import { addEntrant, addSelection, openWeekWithGames } from "../picks/helpers";

/**
 * SS7.1 and SS7.6 -- acceptance tests 23, 24, 28, 29.
 */

let handle: DatabaseHandle;
let db: Database;
let recorder: ReturnType<typeof createAuditRecorder>;
let teamRows: TeamRow[];
let week: WeekStateRow;
let weekGames: GameRow[];

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  recorder = createAuditRecorder(db);
  await setupLeague(db);
  teamRows = await seedTeams(db);
  ({ week, weekGames } = await openWeekWithGames(db, teamRows));
});

afterEach(async () => {
  await handle.close();
});

const actor = (overrides: Partial<AdminActor> = {}): AdminActor => ({
  actorUserId: null,
  actorRole: "admin",
  reason: "Because the league agreed",
  ...overrides,
});

describe("acceptance test 23 -- every admin mutation writes exactly one entry", () => {
  it("logs a picks_purchased change with before, after and a reason", async () => {
    const dana = await addEntrant(db, "dana", 0);

    await setPicksPurchased(db, { userId: dana.user.id, picksPurchased: 4 }, actor(), recorder);

    const entries = await listAllAuditEntries(db);
    const change = entries.filter((entry) => entry.action === "user.picks_purchased.change");

    expect(change).toHaveLength(1);
    expect(change[0]!.beforeJson).toMatchObject({ picksPurchased: 0 });
    expect(change[0]!.afterJson).toMatchObject({ picksPurchased: 4 });
    expect(change[0]!.reason.trim()).not.toBe("");
  });

  it("logs a payment change", async () => {
    const dana = await addEntrant(db, "dana", 1);

    await setPaymentInfo(
      db,
      { userId: dana.user.id, paymentStatus: "paid", paymentNote: "$100 Venmo" },
      actor(),
      recorder,
    );

    const entries = await listAllAuditEntries(db);
    // SS7.1 lists payment_status and payment_note as separate changes.
    expect(entries.filter((entry) => entry.action.startsWith("user.payment"))).toHaveLength(2);
  });

  it("logs a game override", async () => {
    await overrideGameResult(
      db,
      { gameId: weekGames[0]!.id, homeScore: 21, awayScore: 17, status: "final", winnerTeamId: teamRows[0]!.id },
      actor({ reason: "ESPN had the score wrong" }),
      recorder,
    );

    const entries = await listAllAuditEntries(db);
    const override = entries.find((entry) => entry.action === "game.override");

    expect(override).toBeDefined();
    expect(override!.afterJson).toMatchObject({ homeScore: 21, awayScore: 17 });
    expect(override!.reason).toBe("ESPN had the score wrong");

    const [game] = await db.select().from(games).where(eq(games.id, weekGames[0]!.id));
    expect(game?.homeScore).toBe(21);
  });

  it("logs a config change with the whole config on both sides", async () => {
    await updateLeagueConfig(db, { maxPicksPerUser: 12 }, actor(), recorder);

    const entries = await listAllAuditEntries(db);
    const change = entries.find((entry) => entry.action === "league.config.change");

    expect(change).toBeDefined();
    expect((change!.beforeJson as { config: { maxPicksPerUser: number } }).config.maxPicksPerUser).toBe(10);
    expect((change!.afterJson as { config: { maxPicksPerUser: number } }).config.maxPicksPerUser).toBe(12);
  });

  it("leaves the chain valid after a run of admin actions", async () => {
    const dana = await addEntrant(db, "dana", 2);
    await setPicksPurchased(db, { userId: dana.user.id, picksPurchased: 3 }, actor(), recorder);
    await setPaymentInfo(db, { userId: dana.user.id, paymentStatus: "paid" }, actor(), recorder);
    await overrideGameResult(db, { gameId: weekGames[0]!.id, status: "canceled" }, actor(), recorder);

    const result = await verifyAuditChain(db);
    expect(result.valid).toBe(true);
  });
});

describe("acceptance test 24 -- an empty reason is refused server-side", () => {
  it("refuses a game override with a blank reason and changes nothing", async () => {
    const result = await overrideGameResult(
      db,
      { gameId: weekGames[0]!.id, homeScore: 99 },
      actor({ reason: "   " }),
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("reason_required");

    const [game] = await db.select().from(games).where(eq(games.id, weekGames[0]!.id));
    expect(game?.homeScore).toBeNull();
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });
});

describe("acceptance test 28 -- self_affecting", () => {
  it("flags an admin eliminating their own pick slot", async () => {
    const dana = await addEntrant(db, "dana", 2, { role: "admin" });

    await setSlotStatus(
      db,
      { slotId: dana.slots[0]!.id, status: "eliminated" },
      actor({ actorUserId: dana.user.id, reason: "Withdrawing my own pick" }),
      recorder,
    );

    const entries = await listAllAuditEntries(db);
    const entry = entries.find((candidate) => candidate.action === "pick_slot.eliminate");

    expect(entry?.selfAffecting).toBe(true);
    expect(entry?.targetLabel).toContain("dana");
  });

  it("does not flag an admin acting on someone else", async () => {
    const dana = await addEntrant(db, "dana", 1, { role: "admin" });
    const marcus = await addEntrant(db, "marcus", 1);

    await setSlotStatus(
      db,
      { slotId: marcus.slots[0]!.id, status: "eliminated" },
      actor({ actorUserId: dana.user.id }),
      recorder,
    );

    const entry = (await listAllAuditEntries(db)).find(
      (candidate) => candidate.action === "pick_slot.eliminate",
    );
    expect(entry?.selfAffecting).toBe(false);
  });

  it("flags an admin overriding their own selection", async () => {
    const dana = await addEntrant(db, "dana", 1, { role: "admin" });
    const selection = await addSelection(db, {
      slotId: dana.slots[0]!.id,
      week,
      teamId: teamRows[0]!.id,
      gameId: weekGames[0]!.id,
      userId: dana.user.id,
    });

    await overrideSelectionResult(
      db,
      { selectionId: selection.id, result: "survived" },
      actor({ actorUserId: dana.user.id }),
      recorder,
    );

    const entry = (await listAllAuditEntries(db)).find(
      (candidate) => candidate.action === "selection.override",
    );
    expect(entry?.selfAffecting).toBe(true);
  });
});

describe("SS7.6 -- requireSecondAdminForSelfActions", () => {
  it("refuses a self-affecting action when the league demands a second admin", async () => {
    await db
      .update(leagues)
      .set({ config: { ...DEFAULT_LEAGUE_CONFIG, requireSecondAdminForSelfActions: true } });

    const dana = await addEntrant(db, "dana", 1, { role: "admin" });

    const result = await setSlotStatus(
      db,
      { slotId: dana.slots[0]!.id, status: "eliminated" },
      actor({ actorUserId: dana.user.id }),
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("second_admin_required");
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("still allows an action on somebody else", async () => {
    await db
      .update(leagues)
      .set({ config: { ...DEFAULT_LEAGUE_CONFIG, requireSecondAdminForSelfActions: true } });

    const dana = await addEntrant(db, "dana", 1, { role: "admin" });
    const marcus = await addEntrant(db, "marcus", 1);

    const result = await setSlotStatus(
      db,
      { slotId: marcus.slots[0]!.id, status: "eliminated" },
      actor({ actorUserId: dana.user.id }),
      recorder,
    );

    expect(result.ok).toBe(true);
  });
});

describe("acceptance test 29 -- a non-admin can read and export the whole log", () => {
  it("exposes every entry through the same query the screen uses", async () => {
    // listAuditEntries takes no viewer and performs no role check, by design:
    // a log only the referee can read referees nothing.
    const dana = await addEntrant(db, "dana", 1, { role: "admin" });
    await setPicksPurchased(db, { userId: dana.user.id, picksPurchased: 2 }, actor(), recorder);

    const { entries, total } = await listAuditEntries(db, { adminOnly: false });
    expect(total).toBeGreaterThan(0);
    expect(entries.length).toBe(total);
  });

  it("exports CSV carrying the hashes, so a member can verify their snapshot", async () => {
    const dana = await addEntrant(db, "dana", 1);
    await setPicksPurchased(db, { userId: dana.user.id, picksPurchased: 2 }, actor(), recorder);

    const csv = toCsv(await listAllAuditEntries(db));
    const [header, ...rows] = csv.split("\r\n");

    expect(header).toContain("prev_hash");
    expect(header).toContain("entry_hash");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("quotes CSV values that would otherwise break the row apart", async () => {
    const dana = await addEntrant(db, "dana", 1);
    await setPicksPurchased(
      db,
      { userId: dana.user.id, picksPurchased: 2 },
      actor({ reason: 'He said "pay me later", then paid' }),
      recorder,
    );

    const csv = toCsv(await listAllAuditEntries(db));
    expect(csv).toContain('"He said ""pay me later"", then paid"');
    // One header plus one row per entry -- the embedded comma broke nothing.
    expect(csv.split("\r\n")).toHaveLength((await listAllAuditEntries(db)).length + 1);
  });

  it("exports JSON carrying the hashes too", async () => {
    const dana = await addEntrant(db, "dana", 1);
    await setPicksPurchased(db, { userId: dana.user.id, picksPurchased: 2 }, actor(), recorder);

    const parsed = JSON.parse(toJson(await listAllAuditEntries(db))) as Array<Record<string, unknown>>;
    expect(parsed[0]).toHaveProperty("entry_hash");
    expect(parsed[0]).toHaveProperty("prev_hash");
    expect(parsed[0]!.seq).toBe(1);
  });
});
