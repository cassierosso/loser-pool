import { describe, expect, it } from "vitest";

import { canonicalJson, canonicalPayload, computeEntryHash, GENESIS_PREV_HASH } from "@/lib/audit/hash";

/**
 * SS7.2 -- deterministic serialisation. A member who kept last week's export
 * has to be able to recompute today's head hash and get the same string.
 */

const entry = {
  seq: 1,
  occurredAt: new Date("2024-09-05T23:15:00.000Z"),
  actorUserId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  action: "user.picks_purchased.change",
  targetType: "user",
  targetId: "u1",
  beforeJson: { picksPurchased: 0 },
  afterJson: { picksPurchased: 10 },
  reason: "Paid $100",
};

describe("canonicalJson", () => {
  it("sorts object keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("gives the same string whatever order the keys arrive in", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("preserves array order, which carries meaning", () => {
    expect(canonicalJson(["b", "a"])).toBe('["b","a"]');
  });

  it("ignores undefined members, since JSON has none", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("writes dates as ISO-8601 UTC", () => {
    expect(canonicalJson(new Date("2024-09-05T23:15:00Z"))).toBe('"2024-09-05T23:15:00.000Z"');
  });
});

describe("computeEntryHash", () => {
  it("is reproducible", () => {
    expect(computeEntryHash(entry, GENESIS_PREV_HASH)).toBe(
      computeEntryHash({ ...entry }, GENESIS_PREV_HASH),
    );
  });

  it("does not depend on the key order of the payloads", () => {
    const reordered = { ...entry, afterJson: { picksPurchased: 10 } };
    expect(computeEntryHash(reordered, GENESIS_PREV_HASH)).toBe(
      computeEntryHash(entry, GENESIS_PREV_HASH),
    );
  });

  it("changes when any hashed field changes", () => {
    const baseline = computeEntryHash(entry, GENESIS_PREV_HASH);

    expect(computeEntryHash({ ...entry, seq: 2 }, GENESIS_PREV_HASH)).not.toBe(baseline);
    expect(computeEntryHash({ ...entry, reason: "Paid $101" }, GENESIS_PREV_HASH)).not.toBe(baseline);
    expect(
      computeEntryHash({ ...entry, afterJson: { picksPurchased: 9 } }, GENESIS_PREV_HASH),
    ).not.toBe(baseline);
    expect(computeEntryHash({ ...entry, actorUserId: null }, GENESIS_PREV_HASH)).not.toBe(baseline);
  });

  it("changes when the previous hash changes, which is what chains it", () => {
    expect(computeEntryHash(entry, "a".repeat(64))).not.toBe(
      computeEntryHash(entry, GENESIS_PREV_HASH),
    );
  });

  it("cannot be forged by shifting text between adjacent fields", () => {
    // Bare concatenation would make these two identical. The separator is why
    // they are not.
    const left = { ...entry, action: "a", targetType: "user", targetId: "bc" };
    const right = { ...entry, action: "ab", targetType: "user", targetId: "c" };

    expect(computeEntryHash(left, GENESIS_PREV_HASH)).not.toBe(
      computeEntryHash(right, GENESIS_PREV_HASH),
    );
  });

  it("produces a 64-character hex digest", () => {
    expect(computeEntryHash(entry, GENESIS_PREV_HASH)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("shows its work, so a verifier can be written independently", () => {
    const payload = canonicalPayload(entry, GENESIS_PREV_HASH);
    expect(payload.split("\n")).toHaveLength(10);
    expect(payload.startsWith(GENESIS_PREV_HASH)).toBe(true);
  });
});
