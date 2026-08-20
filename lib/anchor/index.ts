import { createFileAnchorPublisher } from "./file";
import { createGitHubAnchorPublisher } from "./github";
import type { AnchorPublisher } from "./types";

export * from "./types";
export * from "./file";
export * from "./github";

export const ANCHOR_PATH = "LOG_ANCHOR.md";

/**
 * GitHub when it is configured, the working tree otherwise. Deployments that
 * set neither still get the digest emails, and the job says loudly that the
 * second trail is missing.
 */
export function createAnchorPublisher(): AnchorPublisher {
  const token = process.env.GITHUB_TOKEN?.trim();
  const repository = process.env.GITHUB_REPOSITORY?.trim();

  if (token && repository) {
    return createGitHubAnchorPublisher({
      token,
      repository,
      ...(process.env.GITHUB_BRANCH?.trim() ? { branch: process.env.GITHUB_BRANCH.trim() } : {}),
    });
  }

  return createFileAnchorPublisher();
}

export function isAnchorConfigured(): boolean {
  return Boolean(process.env.GITHUB_TOKEN?.trim() && process.env.GITHUB_REPOSITORY?.trim());
}
