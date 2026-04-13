/**
 * Payload Builder
 *
 * Converts Terraform plan JSON into a routing-safe RoutingPayload.
 *
 * CRITICAL: This module must NEVER include:
 * - before/after values
 * - variable values
 * - provider attribute payloads
 * - full plan JSON
 *
 * Only routing-safe metadata is extracted.
 */

import * as core from "@actions/core";
import type {
  RoutingPayload,
  Repo,
  PullRequest,
  PayloadSource,
  Resource,
  RepositoryConfigSnapshot,
} from "./core/types.js";
import { calculateSummary, normalizeActions } from "./core/helpers.js";
import { extractPricingResources } from "./pricing-extractor.js";

interface BuildPayloadOptions {
  requestId: string;
  source: PayloadSource;
  repo: Repo;
  pullRequest: PullRequest;
  terraformRoot: string;
  workspace?: string;
  environment?: string;
  changedFiles: string[];
  repoConfig?: RepositoryConfigSnapshot;
  planJson: unknown;
}

/**
 * Build a RoutingPayload from Terraform plan output
 */
export function buildRoutingPayload(
  options: BuildPayloadOptions,
): RoutingPayload {
  const { planJson, ...payloadOptions } = options;

  // Parse the plan JSON
  const parsedPlan = parsePlanJson(planJson);

  // Extract resources from the plan
  const resources = extractResources(parsedPlan);

  // Calculate summary
  const summary = calculateSummary(resources);

  // Extract pricing resources
  const pricingResources = extractPricingResources(planJson);

  return {
    requestId: payloadOptions.requestId,
    source: payloadOptions.source,
    repo: payloadOptions.repo,
    pullRequest: payloadOptions.pullRequest,
    repoConfig: payloadOptions.repoConfig,
    evaluationTarget: {
      terraformRoot: payloadOptions.terraformRoot,
      workspace: payloadOptions.workspace,
      environment: payloadOptions.environment,
    },
    changedFiles: payloadOptions.changedFiles,
    summary,
    resources,
    pricingResources,
  };
}

/**
 * Parse and validate the Terraform plan JSON structure
 */
function parsePlanJson(planJson: unknown): TerraformPlan {
  if (!planJson || typeof planJson !== "object") {
    throw new Error("Invalid plan JSON: not an object");
  }

  const plan = planJson as Record<string, unknown>;

  return {
    resourceChanges: plan.resource_changes,
    outputChanges: plan.output_changes,
    terraformVersion: plan.terraform_version as string | undefined,
    formatVersion: plan.format_version as string | undefined,
  };
}

interface TerraformPlan {
  resourceChanges?: unknown;
  outputChanges?: unknown;
  terraformVersion?: string;
  formatVersion?: string;
}

/**
 * Extract resources from the Terraform plan
 *
 * Only extracts routing-safe fields:
 * - address
 * - module_address
 * - type
 * - change.actions
 * - action_reason
 * - change.replace_paths
 * - change.importing.id
 */
function extractResources(plan: TerraformPlan): Resource[] {
  const resources: Resource[] = [];

  if (!plan.resourceChanges || !Array.isArray(plan.resourceChanges)) {
    core.debug("No resource_changes found in plan");
    return resources;
  }

  for (const change of plan.resourceChanges) {
    if (!change || typeof change !== "object") {
      continue;
    }

    const resourceChange = change as Record<string, unknown>;

    // Skip if no change information
    const changeData = resourceChange.change as
      | Record<string, unknown>
      | undefined;
    if (!changeData) {
      continue;
    }

    // Get actions
    const actions = changeData.actions as string[] | undefined;
    if (!actions || !Array.isArray(actions) || actions.length === 0) {
      continue;
    }

    // Skip no-op resources that aren't imports
    const importing = changeData.importing as
      | Record<string, unknown>
      | undefined;
    const importingId = importing?.id as string | undefined;

    if (actions.length === 1 && actions[0] === "no-op" && !importingId) {
      continue;
    }

    // Extract routing-safe fields only
    const address = resourceChange.address as string;
    if (!address) {
      core.debug("Skipping resource without address");
      continue;
    }

    const moduleAddress = resourceChange.module_address as string | undefined;
    const type = resourceChange.type as string;
    const actionReason = resourceChange.action_reason as string | undefined;

    // Extract replace_paths if present
    const replacePaths = changeData.replace_paths as string[][] | undefined;

    // Normalize actions
    const normalizedActions = normalizeActions(actions, importingId);

    // Build resource object with ONLY routing-safe fields
    const resource: Resource = {
      address,
      type: type || "unknown",
      actions: normalizedActions,
    };

    // Add optional fields only if present
    if (moduleAddress) {
      resource.moduleAddress = moduleAddress;
    }

    if (actionReason) {
      resource.actionReason = actionReason;
    }

    if (
      replacePaths &&
      Array.isArray(replacePaths) &&
      replacePaths.length > 0
    ) {
      resource.replacePaths = replacePaths;
    }

    if (importingId) {
      resource.importingId = importingId;
    }

    resources.push(resource);
  }

  return resources;
}

/**
 * Validate that no forbidden fields are present
 * This is a safety check to ensure we're not leaking sensitive data
 */
export function validateNoForbiddenFields(obj: unknown, path = ""): string[] {
  const forbiddenFields = [
    "before",
    "after",
    "variables",
    "values",
    "planned_values",
    "prior_state",
    "configuration",
  ];
  const violations: string[] = [];

  if (obj === null || typeof obj !== "object") {
    return violations;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      violations.push(...validateNoForbiddenFields(obj[i], `${path}[${i}]`));
    }
    return violations;
  }

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;

    if (
      forbiddenFields.includes(key) &&
      !isAllowedPricingDimensionsPath(currentPath)
    ) {
      violations.push(currentPath);
    }

    if (typeof value === "object" && value !== null) {
      violations.push(...validateNoForbiddenFields(value, currentPath));
    }
  }

  return violations;
}

function isAllowedPricingDimensionsPath(path: string): boolean {
  return /^pricingResources\[\d+\]\.(before|after)$/.test(path);
}
