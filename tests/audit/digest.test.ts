import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemoryAnchorPublisher } from "@/lib/anchor/file";
import { renderAnchorFile, renderDigestText, buildDigestData } from "@/lib/audit/digest";
import { describeEntry } from "@/lib/audit/describe";
import type { AuditEntryView } from "@/lib/audit/query";
import { createAuditRecorder } from "@/lib/audit/writer";
import { setPicksPurchased, setSlotStatus, type AdminActor } from "@/lib/admin";
import type { Database, DatabaseHandle } from "@/lib/db/client";
import { weeklyDigest } from "@/lib/jobs/weekly-digest";
import type { JobContext } from "@/lib/jobs/types";
import { createCapturingMailer, type CapturingMailer } from "@/lib/mail/console";
import type { ScheduleProvider } from "@/lib/providers/types";

import { createTestDatabase, setupLeague } from "../helpers/db";
import { addEntrant } from "../picks/helpers";

/**
 * SS7.3 layer 3 -- "Do not skip this. Without it the hash chain is decorative."
 */

let handle: DatabaseHandle;
let db: Database;
let mailer: CapturingMailer;
let anchor: ReturnType<typeof createMemoryAnchorPublisher>;

const NOW = new Date("2024-11-18T12:00:00Z");

const noProvider: ScheduleProvider = {
  name: "none",
  getTeams: () => Promise.reject(new Error("digest must not call a provider")),
  getWeekGames: () => Promise.reject(new Error("digest must not call a provider")),
};

function context(): JobContext {
  return { db, provider: noProvider, recorder: createAuditRecorder(db), now: NOW };
}

const actor = (overrides: Partial<AdminActor> = {}): AdminActor => ({
  actorUserId: null,
  actorRole: "admin",
  reason: "Agreed with the league",
  ...overrides,
});

beforeEach(async () => {
  handle = await createTestDatabase();
  db = handle.db;
  mailer = createCapturingMailer();
  anchor = createMemoryAnchorPublisher();
  await setupLeague(db);
});

afterEach(async () => {
  await handle.close();
});

describe("plain-English descriptions (SS7.3)", () => {
  const base: AuditEntryView = {
    id: 1,
    seq: 1,
    occurredAt: NOW,
    actorUserId: null,
    actorRole: "admin",
    action: "user.picks_purchased.change",
    targetType: "user",
    targetId: "u1",
    targetLabel: "Marcus Bell",
    beforeJson: { picksPurchased: 8 },
    afterJson: { picksPurchased: 10 },
    reason: "Paid for two more",
    selfAffecting: false,
    prevHash: "0".repeat(64),
    entryHash: "a".repeat(64),
    actorName: "Dana Okafor",
  };

  it("puts the before and after inside the sentence", () => {
    expect(describeEntry(base)).toBe(
      "Dana Okafor changed Marcus Bell's pick count from 8 to 10.",
    );
  });

  it("says when the freeze was overridden", () => {
    expect(
      describeEntry({ ...base, afterJson: { picksPurchased: 10, overrideUsed: true } }),
    ).toContain("overriding the mid-season freeze");
  });

  it("describes an elimination bluntly", () => {
    expect(
      describeEntry({ ...base, action: "pick_slot.eliminate", targetLabel: "Dana Okafor — Pick 1" }),
    ).toBe("Dana Okafor ELIMINATED Dana Okafor — Pick 1 by hand.");
  });

  it("names only the settings that actually moved", () => {
    const description = describeEntry({
      ...base,
      action: "league.config.change",
      beforeJson: { config: { maxPicksPerUser: 10, playoffMode: "continue" } },
      afterJson: { config: { maxPicksPerUser: 12, playoffMode: "continue" } },
    });

    expect(description).toContain("maxPicksPerUser: 10 → 12");
    expect(description).not.toContain("playoffMode");
  });

  it("still says something for an action nobody wrote a sentence for", () => {
    // Silence is the one thing the log may never do.
    expect(describeEntry({ ...base, action: "something.new" })).toContain("something.new");
  });
});

describe("the digest body", () => {
  it("carries the head hash in full and the instruction SS7.3 requires", async () => {
    const dana = await addEntrant(db, "dana", 0);
    await setPicksPurchased(db, { userId: dana.user.id, picksPurchased: 5 }, actor(), createAuditRecorder(db));

    const data = await buildDigestData(db, { now: NOW });
    const body = renderDigestText(data, "The Loser Survivor League");

    expect(data.head).not.toBeNull();
    expect(body).toContain(data.head!.entryHash);
    expect(body).toContain("Compare this hash to the one shown on the League Board.");
  });

  it("sends even in a week when nothing happened, because the anchor still matters", async () => {
    const data = await buildDigestData(db, { now: NOW });
    const body = renderDigestText(data, "League");

    expect(body).toContain("No admin actions were taken this week.");
    expect(body).toContain("LOG INTEGRITY");
  });

  it("flags a self-affecting action unmistakably", async () => {
    const dana = await addEntrant(db, "dana", 2, { role: "admin" });
    await setSlotStatus(
      db,
      { slotId: dana.slots[0]!.id, status: "eliminated" },
      actor({ actorUserId: dana.user.id }),
      createAuditRecorder(db),
    );

    const body = renderDigestText(await buildDigestData(db, { now: NOW }), "League");
    expect(body).toContain("** THIS WAS AN ADMIN ACTING ON THEIR OWN ENTRY **");
  });

  it("includes the reason the admin typed", async () => {
    const dana = await addEntrant(db, "dana", 0);
    await setPicksPurchased(
      db,
      { userId: dana.user.id, picksPurchased: 5 },
      actor({ reason: "He paid me in the car park" }),
      createAuditRecorder(db),
    );

    const body = renderDigestText(await buildDigestData(db, { now: NOW }), "League");
    expect(body).toContain("Reason given: He paid me in the car park");
  });

  it("leaves out player and system actions", async () => {
    // SS7.3 asks for admin actions; the rest is noise in an inbox.
    await addEntrant(db, "dana", 1);
    const data = await buildDigestData(db, { now: NOW });
    expect(data.adminActions.every((entry) => entry.actorRole === "admin")).toBe(true);
  });
});

describe("the weeklyDigest job", () => {
  it("emails every member, one at a time", async () => {
    await addEntrant(db, "dana", 1);
    await addEntrant(db, "marcus", 1);
    await addEntrant(db, "sam", 0); // no picks, still a witness

    const result = await weeklyDigest(context(), { mailer, anchor });

    expect(result.detail.delivered).toBe(3);
    expect(mailer.messages.map((message) => message.to).sort()).toEqual([
      "dana@example.com",
      "marcus@example.com",
      "sam@example.com",
    ]);
  });

  it("keeps going when one address fails", async () => {
    await addEntrant(db, "dana", 1);
    await addEntrant(db, "marcus", 1);

    const brokenMailer = {
      name: "broken",
      messages: [] as Array<{ to: string }>,
      async send(message: { to: string }) {
        if (message.to.startsWith("dana")) throw new Error("mailbox full");
        brokenMailer.messages.push(message);
      },
    };

    const result = await weeklyDigest(context(), { mailer: brokenMailer as never, anchor });

    expect(result.detail.delivered).toBe(1);
    expect(result.warnings.some((warning) => warning.includes("dana@example.com"))).toBe(true);
  });

  it("writes an anchor row rather than replacing the file", async () => {
    await addEntrant(db, "dana", 1);

    await weeklyDigest(context(), { mailer, anchor });
    const first = anchor.files.get("LOG_ANCHOR.md")!;

    await weeklyDigest(context(), { mailer, anchor }, { force: true });
    const second = anchor.files.get("LOG_ANCHOR.md")!;

    // The repository's history is meant to accumulate every head the league has
    // ever had, not just the latest.
    expect(second.startsWith(first.trimEnd())).toBe(true);
    expect(second.split("\n").length).toBeGreaterThan(first.split("\n").length);
  });

  it("puts the chain head in the anchor file", async () => {
    const dana = await addEntrant(db, "dana", 0);
    await setPicksPurchased(db, { userId: dana.user.id, picksPurchased: 3 }, actor(), createAuditRecorder(db));

    await weeklyDigest(context(), { mailer, anchor });
    const contents = anchor.files.get("LOG_ANCHOR.md")!;

    const data = await buildDigestData(db, { now: NOW });
    expect(contents).toContain("| sent at (UTC) |");
    // The head moved on when the job logged itself, so match the row shape.
    expect(contents).toMatch(/\| #\d+ \| `[0-9a-f]{64}` \| \d+ \|/);
    expect(data.head).not.toBeNull();
  });

  it("does not send twice in the same week", async () => {
    await addEntrant(db, "dana", 1);

    await weeklyDigest(context(), { mailer, anchor });
    const afterFirst = mailer.messages.length;

    const second = await weeklyDigest(context(), { mailer, anchor });

    expect(second.detail.skipped).toBe(true);
    expect(mailer.messages).toHaveLength(afterFirst);
  });

  it("can be forced, for a re-send", async () => {
    await addEntrant(db, "dana", 1);
    await weeklyDigest(context(), { mailer, anchor });
    await weeklyDigest(context(), { mailer, anchor }, { force: true });

    expect(mailer.messages).toHaveLength(2);
  });

  it("says loudly when the anchor has no independent timestamp", async () => {
    await addEntrant(db, "dana", 1);
    const result = await weeklyDigest(context(), { mailer, anchor });

    // No GITHUB_TOKEN in the test environment, so the trail SS7.3 relies on is
    // missing and the job must not be quiet about it.
    expect(result.warnings.some((warning) => warning.includes("GITHUB_TOKEN"))).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("records itself in the log", async () => {
    await addEntrant(db, "dana", 1);
    await weeklyDigest(context(), { mailer, anchor });

    const { listAllAuditEntries } = await import("@/lib/audit/query");
    const entries = await listAllAuditEntries(db);
    const digestEntry = entries.find((candidate) => candidate.action === "job.weekly_digest");

    expect(digestEntry).toBeDefined();
    expect(digestEntry!.afterJson).toMatchObject({ recipients: 1, adminActions: 0 });
    // Delivery counts are deliberately absent: the entry is written BEFORE the
    // emails go out, so that the hash it anchors is its own. How delivery went
    // is reported as job warnings, which SS8 requires to be loud.
  });

  it("emails the hash that the League Board is showing at that moment", async () => {
    // The first version of this job emailed the head as it stood and THEN
    // logged itself, advancing the head by one -- so a member following the
    // instruction to compare the two found a mismatch and would reasonably
    // have concluded the log had been tampered with.
    await addEntrant(db, "dana", 1);

    await weeklyDigest(context(), { mailer, anchor });

    const { getChainHead } = await import("@/lib/audit/writer");
    const boardHead = await getChainHead(db);
    const emailed = mailer.messages[0]!.text;

    expect(boardHead).not.toBeNull();
    expect(emailed).toContain(boardHead!.entryHash);
    expect(emailed).toContain(`entry #${boardHead!.seq}`);
    expect(anchor.files.get("LOG_ANCHOR.md")).toContain(boardHead!.entryHash);
  });
});

describe("renderAnchorFile", () => {
  it("creates the header when the file does not exist", () => {
    const contents = renderAnchorFile(null, {
      since: NOW,
      until: NOW,
      adminActions: [],
      head: { seq: 3, entryHash: "b".repeat(64) },
      recipients: [],
    });

    expect(contents).toContain("# Log anchor");
    expect(contents).toContain("| #3 |");
  });

  it("appends to an existing table", () => {
    const first = renderAnchorFile(null, {
      since: NOW,
      until: NOW,
      adminActions: [],
      head: { seq: 1, entryHash: "a".repeat(64) },
      recipients: [],
    });
    const second = renderAnchorFile(first, {
      since: NOW,
      until: NOW,
      adminActions: [],
      head: { seq: 2, entryHash: "b".repeat(64) },
      recipients: [],
    });

    expect(second).toContain("| #1 |");
    expect(second).toContain("| #2 |");
    expect(second.match(/# Log anchor/g)).toHaveLength(1);
  });
});

describe("checking a hash from an old digest (SS7.3)", () => {
  it("confirms an entry that still matches", async () => {
    const { checkAnchoredHash } = await import("@/lib/audit/query");
    await addEntrant(db, "dana", 1);
    await weeklyDigest(context(), { mailer, anchor });

    const { getChainHead } = await import("@/lib/audit/writer");
    const head = (await getChainHead(db))!;

    expect(await checkAnchoredHash(db, head.seq, head.entryHash)).toMatchObject({
      status: "match",
      seq: head.seq,
    });
  });

  it("still confirms it once the head has moved on", async () => {
    // The realistic case: the email is a week old and plenty has happened since.
    const { checkAnchoredHash } = await import("@/lib/audit/query");
    const { getChainHead } = await import("@/lib/audit/writer");

    const dana = await addEntrant(db, "dana", 0);
    await weeklyDigest(context(), { mailer, anchor });
    const emailed = (await getChainHead(db))!;

    await setPicksPurchased(db, { userId: dana.user.id, picksPurchased: 4 }, actor(), createAuditRecorder(db));
    const nowHead = (await getChainHead(db))!;

    expect(nowHead.seq).toBeGreaterThan(emailed.seq);
    expect(await checkAnchoredHash(db, emailed.seq, emailed.entryHash)).toMatchObject({
      status: "match",
    });
  });

  it("reports a mismatch when the entry has been altered", async () => {
    const { checkAnchoredHash } = await import("@/lib/audit/query");
    await addEntrant(db, "dana", 1);
    await weeklyDigest(context(), { mailer, anchor });

    const { getChainHead } = await import("@/lib/audit/writer");
    const head = (await getChainHead(db))!;

    const result = await checkAnchoredHash(db, head.seq, "f".repeat(64));
    expect(result.status).toBe("mismatch");
  });

  it("reports an entry that has been removed entirely", async () => {
    const { checkAnchoredHash } = await import("@/lib/audit/query");
    expect(await checkAnchoredHash(db, 999, "a".repeat(64))).toEqual({ status: "missing", seq: 999 });
  });

  it("ignores casing and stray whitespace, since the hash is pasted from an email", async () => {
    const { checkAnchoredHash } = await import("@/lib/audit/query");
    await addEntrant(db, "dana", 1);
    await weeklyDigest(context(), { mailer, anchor });

    const { getChainHead } = await import("@/lib/audit/writer");
    const head = (await getChainHead(db))!;

    expect(
      await checkAnchoredHash(db, head.seq, `  ${head.entryHash.toUpperCase()}  `),
    ).toMatchObject({ status: "match" });
  });
});
