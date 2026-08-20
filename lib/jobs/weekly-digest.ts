import { and, desc, eq, gte } from "drizzle-orm";

import { ANCHOR_PATH, isAnchorConfigured, type AnchorPublisher } from "@/lib/anchor";
import {
  buildDigestData,
  DIGEST_PERIOD_MS,
  renderAnchorFile,
  renderDigestText,
  type DigestData,
} from "@/lib/audit/digest";
import { loadLeague } from "@/lib/config";
import { auditLog } from "@/lib/db/schema";
import { appendAuditEntry } from "@/lib/audit/writer";
import type { Mailer } from "@/lib/mail/types";

import type { JobContext, JobResult } from "./types";

/**
 * SS7.3 layer 3 -- the weekly digest and the log anchor.
 *
 * "Do not skip this. Without it the hash chain is decorative."
 *
 * The reason is worth restating: layers 1 and 2 stop everyone EXCEPT the admin,
 * who holds the database credentials and can recompute the entire chain after
 * altering it. What they cannot do is reach into eight inboxes and a git
 * history. This job is what puts the head hash there.
 */

export interface DigestJobDeps {
  mailer: Mailer;
  anchor: AnchorPublisher;
}

export async function weeklyDigest(
  ctx: JobContext,
  deps: DigestJobDeps,
  options: { force?: boolean; since?: Date } = {},
): Promise<JobResult> {
  const { db } = ctx;
  const { row: league } = await loadLeague(db);
  const warnings: string[] = [];

  // Don't send twice for the same week. The audit log is its own record of
  // having run, so no extra state is needed.
  if (!options.force) {
    const [recent] = await db
      .select({ occurredAt: auditLog.occurredAt })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "job.weekly_digest"),
          gte(auditLog.occurredAt, new Date(ctx.now.getTime() - DIGEST_PERIOD_MS)),
        ),
      )
      .orderBy(desc(auditLog.seq))
      .limit(1);

    if (recent) {
      return {
        job: "weeklyDigest",
        ok: true,
        summary: `Already sent on ${recent.occurredAt.toISOString()}; skipping.`,
        detail: { skipped: true },
        warnings: [],
      };
    }
  }

  const data = await buildDigestData(db, {
    now: ctx.now,
    ...(options.since ? { since: options.since } : {}),
  });

  if (data.recipients.length === 0) {
    warnings.push("No members with an email address; the digest reached nobody.");
  }

  /**
   * Record the digest BEFORE sending it, and anchor the entry it just created.
   *
   * The first version emailed the head as it stood, then logged the job -- which
   * advanced the head by one. A member following the instruction to "compare
   * this hash to the one shown on the League Board" therefore found a mismatch
   * and would have concluded the log had been tampered with. Anchoring the
   * digest's own entry makes the two agree at the moment it is sent.
   */
  const anchored = await appendAuditEntry(
    db,
    {
      actorUserId: null,
      actorRole: "system",
      action: "job.weekly_digest",
      targetType: "job",
      targetId: "weeklyDigest",
      targetLabel: `Weekly digest — ${data.adminActions.length} admin action(s)`,
      beforeJson: { previousHead: data.head?.seq ?? null },
      afterJson: {
        recipients: data.recipients.length,
        adminActions: data.adminActions.length,
      },
      reason: `Weekly log digest covering ${data.since.toISOString()} to ${data.until.toISOString()}`,
      selfAffecting: false,
    },
    { now: ctx.now },
  );

  const published: DigestData = {
    ...data,
    head: { seq: anchored.seq, entryHash: anchored.entryHash },
  };

  const body = renderDigestText(published, league.name);
  const subject =
    data.adminActions.length === 0
      ? `${league.name} — weekly log digest (no admin actions)`
      : `${league.name} — weekly log digest (${data.adminActions.length} admin action${data.adminActions.length === 1 ? "" : "s"})`;

  // Sent one at a time, deliberately: a single failed address must not silence
  // the whole league, and every member is meant to hold their own copy.
  let delivered = 0;
  for (const recipient of published.recipients) {
    try {
      await deps.mailer.send({ to: recipient.email, subject, text: body });
      delivered += 1;
    } catch (error) {
      warnings.push(
        `Could not email ${recipient.email}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let anchorLocation: string | null = null;
  try {
    const existing = await deps.anchor.read(ANCHOR_PATH);
    const next = renderAnchorFile(existing, published);
    const written = await deps.anchor.write(
      ANCHOR_PATH,
      next,
      `Log anchor: chain head #${anchored.seq} ${anchored.entryHash.slice(0, 12)}`,
    );
    anchorLocation = written.location;
  } catch (error) {
    warnings.push(
      `Could not write ${ANCHOR_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isAnchorConfigured()) {
    // SS7.3 is explicit that this trail matters, so its absence is said out
    // loud rather than left to be noticed.
    warnings.push(
      "GITHUB_TOKEN / GITHUB_REPOSITORY are not set, so the anchor was written locally only " +
        "and carries no independent timestamp.",
    );
  }

  const summary =
    `Digest for ${data.adminActions.length} admin action(s) sent to ${delivered}/${published.recipients.length} members. ` +
    `Anchored at chain head #${anchored.seq}.`;

  return {
    job: "weeklyDigest",
    ok: warnings.length === 0,
    summary,
    detail: {
      delivered,
      recipients: published.recipients.length,
      adminActions: published.adminActions.length,
      chainHead: published.head,
      anchorLocation,
    },
    warnings,
  };
}
