import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  createUser,
  getRoster,
  setPicksPurchased,
  type AdminActor,
} from "@/lib/admin";
import { createCollectingAuditRecorder } from "@/lib/audit/port";
import type { Database, DatabaseHandle } from "@/lib/db/client";
import { games, pickSlots, selections, teams, weekStates, type UserRow } from "@/lib/db/schema";

import { createTestDatabase, setupLeague, TEST_SEASON_YEAR } from "./helpers/db";

/**
 * SS4 -- admin provisioning. Covers acceptance tests 7, 8 and 9, plus the
 * invariant the whole section rests on: pick slots and picks_purchased never
 * disagree, and eliminated slots still count.
 */

let handle: DatabaseHandle;
let db: Database;
let recorder: ReturnType<typeof createCollectingAuditRecorder>;

const admin: AdminActor = {
  actorUserId: null,
  actorRole: "admin",
  reason: "Paid $100 by Venmo on 2024-08-28",
};

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  recorder = createCollectingAuditRecorder();
});

afterEach(async () => {
  await handle.close();
});

async function makeUser(displayName = "Dave"): Promise<UserRow> {
  const result = await createUser(
    db,
    { email: `${displayName.toLowerCase()}@example.com`, displayName },
    admin,
    recorder,
  );
  if (!result.ok) throw new Error(result.error.message);
  recorder.events.length = 0;
  return result.value;
}

async function slotsFor(userId: string) {
  return db.select().from(pickSlots).where(eq(pickSlots.userId, userId)).orderBy(pickSlots.slotNumber);
}

/**
 * Creates the teams/game rows a selection needs, once per test database.
 * Reused across calls so a test can give several slots history.
 */
async function ensureFixtureGame(): Promise<{ teamId: string; gameId: string; weekId: string }> {
  const [existing] = await db.select().from(games).limit(1);
  if (existing) {
    return { teamId: existing.homeTeamId, gameId: existing.id, weekId: existing.weekStateId };
  }

  const inserted = await db
    .insert(teams)
    .values([
      { espnTeamId: "999", abbreviation: "TST", displayName: "Test Team", conference: "AFC", division: "East" },
      { espnTeamId: "998", abbreviation: "OPP", displayName: "Opponent", conference: "NFC", division: "West" },
    ])
    .returning();
  const [week] = await db.select().from(weekStates).where(eq(weekStates.displayOrdinal, 1)).limit(1);
  const [game] = await db
    .insert(games)
    .values({
      espnEventId: "evt-1",
      seasonYear: TEST_SEASON_YEAR,
      seasonType: 2,
      weekNumber: 1,
      weekStateId: week!.id,
      kickoffAt: new Date("2024-09-05T23:15:00Z"),
      homeTeamId: inserted[0]!.id,
      awayTeamId: inserted[1]!.id,
    })
    .returning();

  return { teamId: inserted[0]!.id, gameId: game!.id, weekId: week!.id };
}

/** Gives a slot selection history, which is what makes it undeletable. */
async function giveSlotHistory(slotId: string, userId: string): Promise<void> {
  const fixture = await ensureFixtureGame();
  await db.insert(selections).values({
    pickSlotId: slotId,
    weekStateId: fixture.weekId,
    seasonType: 2,
    weekNumber: 1,
    teamId: fixture.teamId,
    gameId: fixture.gameId,
    submittedByUserId: userId,
  });
}

/** Kills a slot without giving it a selection -- what a no_submission elimination looks like. */
async function eliminateSlot(slotId: string): Promise<void> {
  await db
    .update(pickSlots)
    .set({
      status: "eliminated",
      eliminatedSeasonType: 2,
      eliminatedWeek: 3,
      eliminatedReason: "no_submission",
      eliminatedAt: new Date(),
    })
    .where(eq(pickSlots.id, slotId));
}

describe("provisioning pick slots (SS4)", () => {
  it("creates slots labelled Pick 1..N and keeps the count in step", async () => {
    await setupLeague(db);
    const user = await makeUser();

    const result = await setPicksPurchased(db, { userId: user.id, picksPurchased: 4 }, admin, recorder);

    expect(result.ok).toBe(true);
    const slots = await slotsFor(user.id);
    expect(slots.map((slot) => slot.label)).toEqual(["Pick 1", "Pick 2", "Pick 3", "Pick 4"]);
    expect(slots.every((slot) => slot.status === "alive")).toBe(true);

    const [roster] = await getRoster(db);
    expect(roster?.picksPurchased).toBe(4);
    expect(roster?.aliveCount).toBe(4);
    expect(roster?.outOfSync).toBe(false);
  });

  it("gives a user with picks_purchased = 0 no slots at all", async () => {
    // Acceptance test 7. They can log in and watch; they have nothing to submit.
    await setupLeague(db);
    const user = await makeUser();

    const result = await setPicksPurchased(db, { userId: user.id, picksPurchased: 0 }, admin, recorder);

    expect(result.ok).toBe(true);
    expect(await slotsFor(user.id)).toHaveLength(0);
    const [roster] = await getRoster(db);
    expect(roster?.picksPurchased).toBe(0);
    expect(roster?.slotCount).toBe(0);
  });

  it("refuses to exceed maxPicksPerUser", async () => {
    await setupLeague(db, { config: { maxPicksPerUser: 10 } });
    const user = await makeUser();

    const result = await setPicksPurchased(db, { userId: user.id, picksPurchased: 11 }, admin, recorder);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("exceeds_max");
    expect(await slotsFor(user.id)).toHaveLength(0);
  });

  it("honours a raised ceiling from LEAGUE_CONFIG rather than a hardcoded 10", async () => {
    // SS0: no setting may be hardcoded anywhere outside LEAGUE_CONFIG.
    await setupLeague(db, { config: { maxPicksPerUser: 15 } });
    const user = await makeUser();

    const result = await setPicksPurchased(db, { userId: user.id, picksPurchased: 15 }, admin, recorder);

    expect(result.ok).toBe(true);
    expect(await slotsFor(user.id)).toHaveLength(15);
  });

  it("is idempotent and records nothing when the value is unchanged", async () => {
    await setupLeague(db);
    const user = await makeUser();
    await setPicksPurchased(db, { userId: user.id, picksPurchased: 3 }, admin, recorder);
    const before = await slotsFor(user.id);
    recorder.events.length = 0;

    const again = await setPicksPurchased(db, { userId: user.id, picksPurchased: 3 }, admin, recorder);

    expect(again.ok).toBe(true);
    expect(await slotsFor(user.id)).toEqual(before);
    expect(recorder.events).toHaveLength(0);
  });
});

describe("reducing picks_purchased (SS4)", () => {
  it("cannot delete a slot that has selection history", async () => {
    // Acceptance test 8.
    await setupLeague(db);
    const user = await makeUser();
    await setPicksPurchased(db, { userId: user.id, picksPurchased: 3 }, admin, recorder);
    const slots = await slotsFor(user.id);
    await giveSlotHistory(slots[2]!.id, user.id); // history on the highest slot
    await giveSlotHistory(slots[1]!.id, user.id);

    const result = await setPicksPurchased(db, { userId: user.id, picksPurchased: 1 }, admin, recorder);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("reduction_blocked");
    expect(result.error.blockingSlots?.map((slot) => slot.label)).toEqual(["Pick 3", "Pick 2"]);
    // Nothing partially applied.
    expect(await slotsFor(user.id)).toHaveLength(3);
  });

  it("removes the highest-numbered removable slots and never renumbers survivors", async () => {
    await setupLeague(db);
    const user = await makeUser();
    await setPicksPurchased(db, { userId: user.id, picksPurchased: 5 }, admin, recorder);
    const slots = await slotsFor(user.id);
    await giveSlotHistory(slots[4]!.id, user.id); // Pick 5 is now untouchable

    const result = await setPicksPurchased(db, { userId: user.id, picksPurchased: 3 }, admin, recorder);

    expect(result.ok).toBe(true);
    const remaining = await slotsFor(user.id);
    // Pick 4 and Pick 3 were the highest removable ones; Pick 5 keeps its label
    // and its history, and the gap is left in place on purpose.
    expect(remaining.map((slot) => slot.label)).toEqual(["Pick 1", "Pick 2", "Pick 5"]);
  });

  it("refuses to delete an eliminated slot even when it has no selections", async () => {
    // A slot eliminated for no_submission has no selection row, so "has history"
    // is not enough of a guard on its own -- being dead has to block deletion
    // too, or a reduction could quietly erase an elimination from the record.
    await setupLeague(db);
    const user = await makeUser();
    await setPicksPurchased(db, { userId: user.id, picksPurchased: 2 }, admin, recorder);
    const slots = await slotsFor(user.id);
    await giveSlotHistory(slots[0]!.id, user.id); // Pick 1: has history
    await eliminateSlot(slots[1]!.id); // Pick 2: dead, no selections

    const result = await setPicksPurchased(db, { userId: user.id, picksPurchased: 1 }, admin, recorder);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("reduction_blocked");
    expect(result.error.blockingSlots).toEqual([
      { slotId: slots[1]!.id, label: "Pick 2", reason: "eliminated", selectionCount: 0 },
      { slotId: slots[0]!.id, label: "Pick 1", reason: "has_selection_history", selectionCount: 1 },
    ]);
    expect(await slotsFor(user.id)).toHaveLength(2);
  });

  it("will delete an alive unused slot in preference to a dead one", async () => {
    // SS4 permits removing any alive slot with zero selections. When the only
    // removable slot is a low-numbered one, that is the one that goes -- the
    // eliminated slot stays on the books, because its elimination is history.
    await setupLeague(db);
    const user = await makeUser();
    await setPicksPurchased(db, { userId: user.id, picksPurchased: 2 }, admin, recorder);
    const slots = await slotsFor(user.id);
    await eliminateSlot(slots[1]!.id);

    const result = await setPicksPurchased(db, { userId: user.id, picksPurchased: 1 }, admin, recorder);

    expect(result.ok).toBe(true);
    const remaining = await slotsFor(user.id);
    expect(remaining.map((slot) => slot.label)).toEqual(["Pick 2"]);
    expect(remaining[0]?.status).toBe("eliminated");
  });

  it("counts eliminated slots toward picks_purchased", async () => {
    // The season-long invariant: a player who bought 10 and lost 6 still bought
    // 10. Alive and eliminated counts are derived, never stored.
    await setupLeague(db);
    const user = await makeUser();
    await setPicksPurchased(db, { userId: user.id, picksPurchased: 4 }, admin, recorder);
    const slots = await slotsFor(user.id);
    await eliminateSlot(slots[0]!.id);

    const [roster] = await getRoster(db);
    expect(roster).toMatchObject({
      picksPurchased: 4,
      slotCount: 4,
      aliveCount: 3,
      eliminatedCount: 1,
      outOfSync: false,
    });
  });
});

describe("the picks freeze (SS4)", () => {
  const beforeKickoff = new Date("2024-09-01T00:00:00Z");
  const afterKickoff = new Date("2024-09-20T00:00:00Z");
  const week1Kickoff = new Date("2024-09-05T23:15:00Z");

  it("allows changes before week 1 kickoff", async () => {
    await setupLeague(db, { week1LockAt: week1Kickoff });
    const user = await makeUser();

    const result = await setPicksPurchased(
      db,
      { userId: user.id, picksPurchased: 6, now: beforeKickoff },
      admin,
      recorder,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings).toHaveLength(0);
  });

  it("rejects a change after picksFrozenAt without an override", async () => {
    // Acceptance test 9.
    await setupLeague(db, { week1LockAt: week1Kickoff });
    const user = await makeUser();

    const result = await setPicksPurchased(
      db,
      { userId: user.id, picksPurchased: 6, now: afterKickoff },
      admin,
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("picks_frozen");
    expect(await slotsFor(user.id)).toHaveLength(0);
    expect(recorder.events).toHaveLength(0);
  });

  it("allows an override and flags the competitive-integrity warning", async () => {
    await setupLeague(db, { week1LockAt: week1Kickoff });
    const user = await makeUser();

    const result = await setPicksPurchased(
      db,
      { userId: user.id, picksPurchased: 2, now: afterKickoff },
      { ...admin, override: true, reason: "Paid late; agreed by the league" },
      recorder,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.map((warning) => warning.code)).toEqual([
      "frozen_override_used",
      "mid_season_addition",
    ]);
    expect(result.value.warnings[1]?.slotLabels).toEqual(["Pick 1", "Pick 2"]);
  });

  it("is not frozen while no schedule has been synced", async () => {
    // picksFrozenAt resolves against week 1's kickoff; with no kickoff known
    // there is nothing to be past.
    await setupLeague(db);
    const user = await makeUser();

    const result = await setPicksPurchased(
      db,
      { userId: user.id, picksPurchased: 2, now: afterKickoff },
      admin,
      recorder,
    );

    expect(result.ok).toBe(true);
  });

  it("never freezes under picksFrozenAt: never", async () => {
    await setupLeague(db, { config: { picksFrozenAt: "never" }, week1LockAt: week1Kickoff });
    const user = await makeUser();

    const result = await setPicksPurchased(
      db,
      { userId: user.id, picksPurchased: 2, now: afterKickoff },
      admin,
      recorder,
    );

    expect(result.ok).toBe(true);
  });
});

describe("the audit seam (SS7, implemented in Phase 6)", () => {
  it("emits exactly one well-formed event per applied change", async () => {
    // Groundwork for acceptance test 23: before/after populated, reason present.
    await setupLeague(db);
    const user = await makeUser();

    await setPicksPurchased(db, { userId: user.id, picksPurchased: 2 }, admin, recorder);

    expect(recorder.events).toHaveLength(1);
    const [event] = recorder.events;
    expect(event).toMatchObject({
      action: "user.picks_purchased.change",
      targetType: "user",
      targetId: user.id,
      actorRole: "admin",
      selfAffecting: false,
    });
    expect(event?.beforeJson).toEqual({ picksPurchased: 0, slotLabels: [] });
    expect(event?.afterJson).toMatchObject({
      picksPurchased: 2,
      slotLabels: ["Pick 1", "Pick 2"],
    });
    expect(event?.reason.trim()).not.toBe("");
  });

  it("rejects an empty reason server-side and changes nothing", async () => {
    // Groundwork for acceptance test 24. No default text, no placeholder.
    await setupLeague(db);
    const user = await makeUser();

    const result = await setPicksPurchased(
      db,
      { userId: user.id, picksPurchased: 2 },
      { ...admin, reason: "   " },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("reason_required");
    expect(await slotsFor(user.id)).toHaveLength(0);
    expect(recorder.events).toHaveLength(0);
  });

  it("flags an admin changing their own entry as self_affecting", async () => {
    // Groundwork for acceptance test 28.
    await setupLeague(db);
    const user = await makeUser("Dana");

    await setPicksPurchased(
      db,
      { userId: user.id, picksPurchased: 3 },
      { ...admin, actorUserId: user.id },
      recorder,
    );

    expect(recorder.events[0]?.selfAffecting).toBe(true);
  });
});
