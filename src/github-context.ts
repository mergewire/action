/**
 * GitHub Context Extraction
 *
 * Extracts PR info and repository details from the GitHub Actions environment.
 */

import * as core from "@actions/core";
import * as github from "@actions/github";
import type { Repo, PullRequest, PayloadSource } from "./core/types.js";

const ACTION_VERSION = "0.1.0";

export interface GitHubContext {
  source: PayloadSource;
  repo: Repo;
  pullRequest: PullRequest;
}

/**
 * Extract GitHub context from the Actions environment
 * @throws Error if required context is missing
 */
export function extractGitHubContext(): GitHubContext {
  const context = github.context;

  // Validate we're in a PR context
  if (!context.payload.pull_request) {
    throw new Error(
      "This action must be run in a pull request context. " +
        "Please ensure this workflow is triggered by a pull_request event.",
    );
  }

  const pr = context.payload.pull_request;

  // Extract repo info
  const repo: Repo = {
    owner: context.repo.owner,
    name: context.repo.repo,
  };

  // Validate repo info
  if (!repo.owner || !repo.name) {
    throw new Error("Unable to determine repository from GitHub context");
  }

  // Extract PR info with runtime validation
  const baseRef =
    typeof pr.base === "object" && pr.base !== null
      ? (pr.base as { ref?: string }).ref
      : undefined;
  const headRef =
    typeof pr.head === "object" && pr.head !== null
      ? (pr.head as { ref?: string }).ref
      : undefined;
  const headSha =
    typeof pr.head === "object" && pr.head !== null
      ? (pr.head as { sha?: string }).sha
      : undefined;

  const user =
    typeof pr.user === "object" && pr.user !== null
      ? (pr.user as { login?: string; type?: string })
      : undefined;
  const author = user?.login;
  const authorType = user?.type;

  if (author) {
    core.debug(`PR author: ${author} (type: ${authorType ?? "unknown"})`);
  }

  const pullRequest: PullRequest = {
    number: pr.number,
    baseRef: baseRef ?? "",
    headRef: headRef ?? "",
    headSha: headSha ?? "",
    ...(author ? { author } : {}),
  };

  // Validate PR info
  if (
    !pullRequest.number ||
    !pullRequest.baseRef ||
    !pullRequest.headRef ||
    !pullRequest.headSha
  ) {
    throw new Error(
      "Unable to determine pull request information from GitHub context",
    );
  }

  const source: PayloadSource = {
    provider: "github-actions",
    version: ACTION_VERSION,
  };

  return {
    source,
    repo,
    pullRequest,
  };
}

/**
 * Get the list of changed files in a pull request
 */
export async function getChangedFiles(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string[]> {
  const octokit = github.getOctokit(token);
  const files: string[] = [];

  // Paginate through all changed files
  for await (const response of octokit.paginate.iterator(
    octokit.rest.pulls.listFiles,
    {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    },
  )) {
    for (const file of response.data) {
      files.push(file.filename);
    }
  }

  return files;
}

/**
 * Check if we're running in a GitHub Actions environment
 */
export function isGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === "true";
}

/**
 * Get the GitHub Actions run ID
 */
export function getRunId(): number {
  return parseInt(process.env.GITHUB_RUN_ID || "0", 10);
}

/**
 * Get the GitHub Actions run URL
 */
export function getRunUrl(): string {
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY || "";
  const runId = process.env.GITHUB_RUN_ID || "";
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}
