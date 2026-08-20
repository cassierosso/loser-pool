import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authorizeJobRequest } from "@/lib/jobs/auth";

/**
 * SS8: every job endpoint is protected by a shared CRON_SECRET bearer token.
 */

const ORIGINAL = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret-token";
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe("authorizeJobRequest", () => {
  it("accepts the configured token", () => {
    expect(authorizeJobRequest("Bearer s3cret-token")).toEqual({ ok: true });
  });

  it("rejects a wrong token", () => {
    const result = authorizeJobRequest("Bearer wrong-token!");
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects a missing header", () => {
    expect(authorizeJobRequest(null)).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects a token of the right value but the wrong scheme", () => {
    expect(authorizeJobRequest("Basic s3cret-token")).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects a token that merely starts with the secret", () => {
    expect(authorizeJobRequest("Bearer s3cret-token-plus-more")).toMatchObject({ ok: false });
  });

  it("fails closed when CRON_SECRET is not configured", () => {
    // A public URL that grades weeks is worse than a broken cron job.
    delete process.env.CRON_SECRET;
    expect(authorizeJobRequest("Bearer anything")).toMatchObject({ ok: false, status: 503 });
  });

  it("fails closed when CRON_SECRET is blank", () => {
    process.env.CRON_SECRET = "   ";
    expect(authorizeJobRequest("Bearer    ")).toMatchObject({ ok: false, status: 503 });
  });
});
