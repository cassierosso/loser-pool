import type { AnchorPublisher } from "./types";

/**
 * Commits LOG_ANCHOR.md through the GitHub contents API.
 *
 * The point is not the file, it is the commit: git records a timestamp and an
 * author that live outside the application's database entirely. An admin who
 * rewrites the audit log still has to explain why the repository's history
 * disagrees with it.
 *
 * Calls the REST API directly rather than adding a dependency for two requests.
 */
export function createGitHubAnchorPublisher(options: {
  token: string;
  /** "owner/repo" */
  repository: string;
  branch?: string;
  committer?: { name: string; email: string };
}): AnchorPublisher {
  const base = `https://api.github.com/repos/${options.repository}/contents`;
  const branch = options.branch ?? "main";

  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "loser-survivor-anchor",
    "x-github-api-version": "2022-11-28",
  };

  async function fetchFile(path: string): Promise<{ content: string; sha: string } | null> {
    const response = await fetch(`${base}/${path}?ref=${encodeURIComponent(branch)}`, { headers });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status} reading ${path}: ${await response.text()}`);
    }

    const payload = (await response.json()) as { content?: string; sha?: string };
    if (!payload.content || !payload.sha) throw new Error(`GitHub returned no content for ${path}`);

    return {
      content: Buffer.from(payload.content, "base64").toString("utf8"),
      sha: payload.sha,
    };
  }

  return {
    name: "github",

    async read(path) {
      return (await fetchFile(path))?.content ?? null;
    },

    async write(path, contents, message) {
      // The sha is required to update an existing file, and omitting it is how
      // you create one; fetching first covers both cases.
      const existing = await fetchFile(path);

      const response = await fetch(`${base}/${path}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          message,
          content: Buffer.from(contents, "utf8").toString("base64"),
          branch,
          ...(existing ? { sha: existing.sha } : {}),
          ...(options.committer ? { committer: options.committer } : {}),
        }),
      });

      if (!response.ok) {
        throw new Error(`GitHub returned ${response.status} writing ${path}: ${await response.text()}`);
      }

      const payload = (await response.json()) as { commit?: { html_url?: string } };
      return { location: payload.commit?.html_url ?? `${options.repository}/${path}` };
    },
  };
}
