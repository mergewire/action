/**
 * MergeWire - GitHub Action
 *
 * Main entry point for the GitHub Action that:
 * 1. Reads GitHub context (repo, PR, refs, SHA)
 * 2. Gets changed files in PR
 * 3. Runs terraform init and plan
 * 4. Parses plan JSON and builds RoutingPayload
 * 5. Signs payload with HMAC and sends to API
 * 6. Receives evaluation result and writes back to PR (comment + reviewers)
 * 7. Sets outputs based on response
 */

import * as core from "@actions/core";
import * as github from "@actions/github";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type {
  EvaluationResult,
  RepositoryConfigSnapshot,
} from "./core/types.js";
import { extractGitHubContext, getChangedFiles } from "./github-context.js";
import { runTerraform } from "./terraform.js";
import { buildRoutingPayload } from "./payload-builder.js";
import { sendPayload } from "./api-client.js";
import { assertSafePayload } from "./core/helpers.js";
import {
  parseSlackWebhooks,
  sendRuleSlackNotifications,
} from "./slack-sender.js";
import { parseWebhooks, sendRuleWebhooks } from "./webhook-sender.js";

const COMMENT_MARKER = "<!-- MergeWire Evaluation -->";
const REPO_CONFIG_PATH = ".mergewire.yml";

function loadRepoConfigSnapshot(
  headRef: string,
): RepositoryConfigSnapshot | undefined {
  const configPath = path.join(process.cwd(), REPO_CONFIG_PATH);
  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  const yaml = fs.readFileSync(configPath, "utf8").trim();
  if (!yaml) {
    return undefined;
  }

  return {
    path: REPO_CONFIG_PATH,
    ref: headRef,
    yaml,
  };
}

async function run(): Promise<void> {
  const startTime = Date.now();
  let requestId = "";

  try {
    // Get inputs
    const apiUrl = core.getInput("api-url", { required: true });
    const apiKey = core.getInput("api-key") || core.getInput("api-secret");
    const terraformRoot = core.getInput("terraform-root", { required: true });
    const workspace = core.getInput("workspace") || undefined;
    const environment = core.getInput("environment") || undefined;
    const failOnApiError = core.getBooleanInput("fail-on-api-error");
    const githubToken = core.getInput("github-token") || undefined;
    const postComment = core.getBooleanInput("post-comment");
    const requestReviewers = core.getBooleanInput("request-reviewers");
    const applyLabels = core.getBooleanInput("apply-labels");

    core.info("MergeWire - Starting...");
    core.info(`  Terraform root: ${terraformRoot}`);
    core.info(`  API URL: ${apiUrl}`);
    if (!apiKey) {
      throw new Error("A workspace API key is required. Provide api-key.");
    }
    if (!core.getInput("api-key") && core.getInput("api-secret")) {
      core.warning(
        "The api-secret input is deprecated. Use api-key for workspace-scoped auth.",
      );
    }
    if (workspace) core.info(`  Workspace: ${workspace}`);
    if (environment) core.info(`  Environment: ${environment}`);

    // Generate request ID for idempotency
    requestId = crypto.randomUUID();
    core.info(`  Request ID: ${requestId}`);

    // Extract GitHub context
    core.info("\n[1/5] Extracting GitHub context...");
    const githubContext = extractGitHubContext();
    core.info(
      `  Repository: ${githubContext.repo.owner}/${githubContext.repo.name}`,
    );
    core.info(`  PR #${githubContext.pullRequest.number}`);
    core.info(
      `  Base: ${githubContext.pullRequest.baseRef} → Head: ${githubContext.pullRequest.headRef}`,
    );

    // Get changed files
    core.info("\n[2/5] Getting changed files...");
    let changedFiles: string[] = [];
    if (githubToken) {
      try {
        changedFiles = await getChangedFiles(
          githubToken,
          githubContext.repo.owner,
          githubContext.repo.name,
          githubContext.pullRequest.number,
        );
        core.info(`  Found ${changedFiles.length} changed file(s)`);
      } catch (error) {
        core.warning(
          `Failed to get changed files: ${error instanceof Error ? error.message : String(error)}`,
        );
        changedFiles = [];
      }
    } else {
      core.warning(
        "No GitHub token provided, skipping changed files detection",
      );
    }

    // Run Terraform
    core.info("\n[3/5] Running Terraform...");
    const planResult = await runTerraform(terraformRoot, workspace);
    core.info(`  Plan captured: ${planResult.binarySize} bytes`);

    // Build routing payload
    core.info("\n[4/5] Building routing payload...");
    const repoConfig = loadRepoConfigSnapshot(
      githubContext.pullRequest.headRef,
    );
    if (repoConfig) {
      core.info(`  Included ${repoConfig.path} from ${repoConfig.ref}`);
    } else {
      core.info(`  No ${REPO_CONFIG_PATH} found in checkout`);
    }
    const payload = buildRoutingPayload({
      requestId,
      source: githubContext.source,
      repo: githubContext.repo,
      pullRequest: githubContext.pullRequest,
      terraformRoot,
      workspace,
      environment,
      changedFiles,
      repoConfig,
      planJson: planResult.planJson,
    });

    // Safety check: assert no sensitive data
    try {
      assertSafePayload(payload);
      core.info("  Payload passed safety checks");
    } catch (error) {
      core.setFailed(
        `Payload safety check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    core.info(`  Resources: ${payload.resources.length}`);
    core.info(
      `  Summary: ${payload.summary.creates} creates, ${payload.summary.updates} updates, ${payload.summary.deletes} deletes, ${payload.summary.replaces} replaces, ${payload.summary.imports} imports`,
    );

    // Send to API
    core.info("\n[5/5] Sending to API...");
    const result = await sendPayload(apiUrl, apiKey, payload);

    // Write-back to GitHub using GITHUB_TOKEN
    if (githubToken && result.evaluation) {
      core.info("\n[6/6] Writing back evaluation results...");
      await writeBackToGitHub({
        token: githubToken,
        owner: githubContext.repo.owner,
        repo: githubContext.repo.name,
        pullNumber: githubContext.pullRequest.number,
        evaluation: result.evaluation,
        postComment,
        requestReviewers,
        applyLabels,
      });
    } else if (
      !githubToken &&
      (postComment || requestReviewers || applyLabels)
    ) {
      core.warning(
        "No GitHub token provided, skipping write-back (comment/reviewers/labels)",
      );
    }

    // Send rule-based Slack notifications via user-provided webhooks
    const githubServerUrl = (
      core.getInput("github-server-url") ||
      process.env.GITHUB_SERVER_URL ||
      "https://github.com"
    ).replace(/\/$/, "");
    const slackWebhooksInput = core.getInput("slack-webhooks");
    if (slackWebhooksInput.trim() && result.evaluation) {
      core.info("\n[→] Sending rule-based Slack notifications...");
      await sendRuleSlackNotifications({
        webhookMap: parseSlackWebhooks(slackWebhooksInput),
        matchedRuleIds: result.evaluation.matchedRuleIds,
        configPath: path.join(process.cwd(), ".mergewire.yml"),
        evaluation: result.evaluation,
        repository: githubContext.repo,
        prNumber: githubContext.pullRequest.number,
        githubServerUrl,
      });
    }

    // Send generic webhooks
    const webhooksInput = core.getInput("webhooks");
    const webhookSecret = core.getInput("webhook-secret");
    if (webhooksInput.trim() && result.evaluation) {
      core.info("\n[→] Sending rule-based generic webhooks...");
      await sendRuleWebhooks({
        webhookMap: parseWebhooks(webhooksInput),
        matchedRuleIds: result.evaluation.matchedRuleIds,
        configPath: path.join(process.cwd(), ".mergewire.yml"),
        evaluation: result.evaluation,
        repository: githubContext.repo,
        prNumber: githubContext.pullRequest.number,
        webhookSecret,
        requestId,
        githubServerUrl,
      });
    }

    // Set outputs
    core.setOutput("request-id", requestId);
    core.setOutput("routing-status", result.status);
    core.setOutput(
      "summary-json",
      JSON.stringify({
        requestId,
        status: result.status,
        durationMs: Date.now() - startTime,
        resources: payload.resources.length,
        summary: payload.summary,
        evaluation: result.evaluation,
      }),
    );

    // Handle result
    switch (result.status) {
      case "accepted":
        core.info(`✅ Payload accepted by API`);
        break;
      case "duplicate":
        core.info(`⚠️ Duplicate delivery detected (already processed)`);
        break;
      case "skipped":
        core.warning(
          `⚠️ Payload skipped by API: ${result.message || "No changes to route"}`,
        );
        break;
      case "failed":
        if (failOnApiError) {
          core.setFailed(`❌ API error: ${result.message || "Unknown error"}`);
        } else {
          core.warning(
            `⚠️ API error (non-fatal): ${result.message || "Unknown error"}`,
          );
        }
        break;
    }

    core.info(`\nCompleted in ${Date.now() - startTime}ms`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`❌ Action failed: ${message}`);

    // Set minimal outputs on failure
    if (requestId) {
      core.setOutput("request-id", requestId);
    }
    core.setOutput("routing-status", "failed");
    core.setOutput(
      "summary-json",
      JSON.stringify({
        requestId,
        status: "failed",
        error: message,
        durationMs: Date.now() - startTime,
      }),
    );
  }
}

interface WriteBackOptions {
  token: string;
  owner: string;
  repo: string;
  pullNumber: number;
  evaluation: EvaluationResult;
  postComment: boolean;
  requestReviewers: boolean;
  applyLabels: boolean;
}

/**
 * Write evaluation results back to GitHub (PR comment + reviewer requests + labels)
 */
async function writeBackToGitHub(options: WriteBackOptions): Promise<void> {
  const {
    token,
    owner,
    repo,
    pullNumber,
    evaluation,
    postComment,
    requestReviewers,
    applyLabels,
  } = options;
  const octokit = github.getOctokit(token);

  // Post or update PR comment
  if (postComment) {
    try {
      const commentBody = buildCommentBody(evaluation);

      // Try to find existing comment
      const { data: comments } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: pullNumber,
      });

      const existingComment = comments.find((c) =>
        c.body?.includes(COMMENT_MARKER),
      );

      if (existingComment) {
        // Update existing comment
        await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existingComment.id,
          body: commentBody,
        });
        core.info("  Updated existing PR comment");
      } else {
        // Create new comment
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pullNumber,
          body: commentBody,
        });
        core.info("  Posted new PR comment");
      }
    } catch (error) {
      core.warning(
        `Failed to post comment: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Request reviewers
  if (requestReviewers) {
    const reviewers = evaluation.requestedReviewers;
    if (reviewers.users.length > 0 || reviewers.teams.length > 0) {
      try {
        await octokit.rest.pulls.requestReviewers({
          owner,
          repo,
          pull_number: pullNumber,
          reviewers: reviewers.users.length > 0 ? reviewers.users : undefined,
          team_reviewers:
            reviewers.teams.length > 0 ? reviewers.teams : undefined,
        });
        core.info(
          `  Requested reviewers: ${[...reviewers.users, ...reviewers.teams.map((t) => `team:${t}`)].join(", ")}`,
        );
      } catch (error) {
        core.warning(
          `Failed to request reviewers: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      core.info("  No reviewers to request");
    }
  }

  // Apply severity label
  if (applyLabels) {
    try {
      await applySeverityLabel(
        octokit,
        owner,
        repo,
        pullNumber,
        evaluation.severity,
      );
      core.info(`  Applied severity label for: ${evaluation.severity}`);
    } catch (error) {
      core.warning(
        `Failed to apply severity label: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Applies the appropriate severity label to the PR, creating it if it doesn't exist
 */
async function applySeverityLabel(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issue_number: number,
  severity: "low" | "medium" | "high",
): Promise<void> {
  const labelConfig = {
    low: {
      name: "mergewire: low-risk",
      color: "00FF00",
      description: "Low risk Terraform changes",
    },
    medium: {
      name: "mergewire: medium-risk",
      color: "FFFF00",
      description: "Medium risk Terraform changes",
    },
    high: {
      name: "mergewire: critical",
      color: "FF0000",
      description: "Critical Terraform changes requiring immediate attention",
    },
  };

  const { name, color, description } = labelConfig[severity];

  // Check if label exists, if not create it
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name });
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 404
    ) {
      core.info(`  Label '${name}' not found. Creating it...`);
      await octokit.rest.issues.createLabel({
        owner,
        repo,
        name,
        color,
        description,
      });
    } else {
      throw error;
    }
  }

  // Fetch current labels on the issue
  const { data: currentLabels } = await octokit.rest.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number,
  });

  const currentLabelNames = currentLabels.map((l) => l.name);
  const allSeverityLabelNames = Object.values(labelConfig).map(
    (config) => config.name,
  );

  // Remove conflicting severity labels
  for (const existingName of currentLabelNames) {
    if (allSeverityLabelNames.includes(existingName) && existingName !== name) {
      try {
        await octokit.rest.issues.removeLabel({
          owner,
          repo,
          issue_number,
          name: existingName,
        });
        core.info(`  Removed conflicting label: '${existingName}'`);
      } catch (error) {
        core.warning(
          `  Failed to remove conflicting label '${existingName}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Apply the new label if it's not already present
  if (!currentLabelNames.includes(name)) {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number,
      labels: [name],
    });
  }
}

/**
 * Build the markdown comment body from evaluation result
 */
function buildCommentBody(evaluation: EvaluationResult): string {
  const lines: string[] = [COMMENT_MARKER, "## MergeWire Evaluation", ""];

  // Aha Moment Summary
  const routingTo = [
    ...evaluation.requestedReviewers.teams.map((t) => `@${t}`),
    ...evaluation.requestedReviewers.users.map((u) => `@${u}`),
  ].join(", ");
  const routingMsg = routingTo ? ` Routing to ${routingTo}.` : "";

  if (evaluation.severity === "low") {
    lines.push(
      "✅ **Low Risk:** Auto-approved. No destructive changes detected.",
    );
  } else if (evaluation.severity === "high") {
    lines.push(`⚠️ **High Risk:** High impact changes detected.${routingMsg}`);
  } else {
    lines.push(
      `⚠️ **Medium Risk:** Moderate impact changes detected.${routingMsg}`,
    );
  }
  lines.push("");

  if (evaluation.evidence.length > 0) {
    lines.push("### Evidence");
    lines.push("");
    lines.push("| Rule | Title | Summary | Impacted Resources |");
    lines.push("|---|---|---|---|");
    for (const item of evaluation.evidence) {
      const title = item.title.replace(/\|/g, "&#124;").replace(/\n/g, "<br/>");
      const summary = item.summary
        .replace(/\|/g, "&#124;")
        .replace(/\n/g, "<br/>");
      const resources =
        item.resourceAddresses && item.resourceAddresses.length > 0
          ? item.resourceAddresses.map((r) => `\`${r}\``).join("<br/>")
          : "None";
      lines.push(
        `| \`${item.ruleId}\` | ${title} | ${summary} | ${resources} |`,
      );
    }
    lines.push("");
  }

  const reviewers = evaluation.requestedReviewers;
  if (reviewers.users.length > 0 || reviewers.teams.length > 0) {
    lines.push("### Requested Reviewers");
    lines.push("");
    lines.push("| Type | Reviewer |");
    lines.push("|---|---|");
    for (const user of reviewers.users) {
      lines.push(`| User | @${user} |`);
    }
    for (const team of reviewers.teams) {
      lines.push(`| Team | @${team} |`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "*View detailed evidence on the [MergeWire Dashboard](https://mergewire.com/dashboard)*",
  );

  return lines.join("\n");
}

// Run the action
void run();
