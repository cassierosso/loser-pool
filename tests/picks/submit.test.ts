import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createCollectingAuditRecorder } from "@/lib/audit/port";
import type { Database, DatabaseHandle } from "@/lib/db/client";
import { pickSlots, selections, weekStates, type GameRow, type TeamRow, type WeekStateRow } from "@/lib/db/schema";
import { submitSelections } from "@/lib/picks/submit";

import { createTestDatabase, seedTeams, setupLeague } from "../helpers/db";
import { addEntrant, addSelection, AFTER_LOCK, BEFORE_LOCK, openWeekWithGames } from "./helpers";

/**
 * SS5.3 / SS9 -- submitting picks. NEVER TRUST THE CLIENT: everything here goes
 * through the same server-side validation regardless of what the UI allowed.
 */

let handle: DatabaseHandle;
let db: Database;
let recorder: ReturnType<typeof createCollectingAuditRecorder>;
let teamRows: TeamRow[];
let week: WeekStateRow;
let weekGames: GameRow[];

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  recorder = createCollectingAuditRecorder();
  await setupLeague(db);
  teamRows = await seedTeams(db);
  ({ week, weekGames } = await openWeekWithGames(db, teamRows));
});

afterEach(async () => {
  await handle.close();
});

describe("submitting picks", () => {
  it("saves a pick for each alive slot", async () => {
    const dana = await addEntrant(db, "dana", 2);

    const result = await submitSelections(
      db,
      {
        user: dana.user,
        now: BEFORE_LOCK,
        picks: [
          { slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id },
          { slotId: dana.slots[1]!.id, teamId: teamRows[2]!.id },
        ],
      },
      recorder,
    );

    expect(result).toMatchObject({ ok: true, saved: 2 });
    const rows = await db.select().from(selections);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.wasAutoAssigned === false)).toBe(true);
    expect(rows.every((row) => row.result === "pending")).toBe(true);
  });

  it("rejects a submission after lock, even though the client sent it", async () => {
    // Acceptance test 5.
    const dana = await addEntrant(db, "dana", 1);

    const result = await submitSelections(
      db,
      { user: dana.user, now: AFTER_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("week_locked");
    expect(await db.select().from(selections)).toHaveLength(0);
  });

  it("rejects a pick from an eliminated slot", async () => {
    // Acceptance test 6.
    const dana = await addEntrant(db, "dana", 1);
    await db
      .update(pickSlots)
      .set({
        status: "eliminated",
        eliminatedSeasonType: 2,
        eliminatedWeek: 3,
        eliminatedReason: "team_won",
        eliminatedAt: BEFORE_LOCK,
      })
      .where(eq(pickSlots.id, dana.slots[0]!.id));

    const result = await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("slot_eliminated");
  });

  it("rejects a user who has bought no picks", async () => {
    // Acceptance test 7's submit half.
    const sam = await addEntrant(db, "sam", 0);
    const dana = await addEntrant(db, "dana", 1);

    const result = await submitSelections(
      db,
      { user: sam.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Someone else's slot is refused as such, without confirming it exists.
    expect(result.errors[0]?.code).toBe("not_your_slot");
  });

  it("refuses to let one entrant submit for another's slot", async () => {
    const dana = await addEntrant(db, "dana", 1);
    const marcus = await addEntrant(db, "marcus", 1);

    const result = await submitSelections(
      db,
      { user: marcus.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("not_your_slot");
    expect(await db.select().from(selections)).toHaveLength(0);
  });

  it("rejects a team that is not playing this week", async () => {
    const dana = await addEntrant(db, "dana", 1);

    const result = await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[20]!.id }] },
      recorder,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("team_not_playing");
  });

  it("saves nothing at all when any pick in the form is invalid", async () => {
    // SS9 says save all slots in one submit; a partial save would leave the
    // entrant believing they had picked when they had not.
    const dana = await addEntrant(db, "dana", 2);

    const result = await submitSelections(
      db,
      {
        user: dana.user,
        now: BEFORE_LOCK,
        picks: [
          { slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }, // fine
          { slotId: dana.slots[1]!.id, teamId: teamRows[20]!.id }, // not playing
        ],
      },
      recorder,
    );

    expect(result.ok).toBe(false);
    expect(await db.select().from(selections)).toHaveLength(0);
    expect(recorder.events).toHaveLength(0);
  });
});

describe("what submitting must NOT block (SS5.3)", () => {
  it("allows two of a user's own slots on the same team", async () => {
    // Acceptance test 4.
    const dana = await addEntrant(db, "dana", 2);

    const result = await submitSelections(
      db,
      {
        user: dana.user,
        now: BEFORE_LOCK,
        picks: [
          { slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id },
          { slotId: dana.slots[1]!.id, teamId: teamRows[0]!.id },
        ],
      },
      recorder,
    );

    expect(result).toMatchObject({ ok: true, saved: 2 });
  });

  it("allows the same team again in a later week", async () => {
    // Acceptance test 3.
    const dana = await addEntrant(db, "dana", 1);
    const [previousWeek] = await db
      .select()
      .from(weekStates)
      .where(eq(weekStates.displayOrdinal, 4));
    await addSelection(db, {
      slotId: dana.slots[0]!.id,
      week: previousWeek!,
      teamId: teamRows[0]!.id,
      gameId: weekGames[0]!.id,
      userId: dana.user.id,
    });

    const result = await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );

    expect(result.ok).toBe(true);
  });
});

describe("editing a pick", () => {
  it("replaces the existing selection rather than adding one", async () => {
    const dana = await addEntrant(db, "dana", 1);
    await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );

    await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[2]!.id }] },
      recorder,
    );

    const rows = await db.select().from(selections);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.teamId).toBe(teamRows[2]!.id);
  });

  it("clears the auto-assigned flag when the entrant picks for themselves", async () => {
    const dana = await addEntrant(db, "dana", 1);
    await addSelection(db, {
      slotId: dana.slots[0]!.id,
      week,
      teamId: teamRows[0]!.id,
      gameId: weekGames[0]!.id,
      userId: dana.user.id,
      wasAutoAssigned: true,
    });

    await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[2]!.id }] },
      recorder,
    );

    const [row] = await db.select().from(selections);
    expect(row?.wasAutoAssigned).toBe(false);
  });
});

describe("the audit trail (SS7.1)", () => {
  it("records a submission with the team that was picked", async () => {
    const dana = await addEntrant(db, "dana", 1);

    await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );

    expect(recorder.events).toHaveLength(1);
    expect(recorder.events[0]).toMatchObject({
      action: "selection.submit",
      actorUserId: dana.user.id,
      actorRole: "player",
      targetType: "selection",
    });
    expect(recorder.events[0]?.afterJson).toMatchObject({ team: teamRows[0]!.abbreviation });
  });

  it("records an edit with the previous team in before_json", async () => {
    const dana = await addEntrant(db, "dana", 1);
    await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[0]!.id }] },
      recorder,
    );
    recorder.events.length = 0;

    await submitSelections(
      db,
      { user: dana.user, now: BEFORE_LOCK, picks: [{ slotId: dana.slots[0]!.id, teamId: teamRows[2]!.id }] },
      recorder,
    );

    expect(recorder.events[0]).toMatchObject({ action: "selection.edit" });
    expect(recorder.events[0]?.beforeJson).toMatchObject({ team: teamRows[0]!.abbreviation });
    expect(recorder.events[0]?.afterJson).toMatchObject({ team: teamRows[2]!.abbreviation });
  });
});
