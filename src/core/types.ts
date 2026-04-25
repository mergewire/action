/**
 * Core types vendored from the MergeWire internal package.
 *
 * This file exists so that apps/action has zero private dependencies
 * and can be published as a standalone open-source GitHub Action.
 */

// ============================================================================
// Base Types
// ============================================================================

export type Severity = "low" | "medium" | "high" | "critical";

export const VALID_ACTIONS = [
  "create",
  "update",
  "delete",
  "read",
  "no-op",
  "replace",
  "import",
] as const;

export type ResourceAction = (typeof VALID_ACTIONS)[number];

// ============================================================================
// Supporting Interfaces
// ============================================================================

export interface PayloadSource {
  provider: "github-actions";
  version: string;
}

export interface Repo {
  owner: string;
  name: string;
}

export interface PullRequest {
  number: number;
  baseRef: string;
  headRef: string;
  headSha: string;
  author?: string;
}

export interface RepositoryConfigSnapshot {
  path?: string;
  ref?: string;
  yaml: string;
}

export interface EvaluationTarget {
  terraformRoot: string;
  workspace?: string;
  environment?: string;
}

export interface Summary {
  creates: number;
  updates: number;
  deletes: number;
  replaces: number;
  imports: number;
}

export interface Resource {
  address: string;
  moduleAddress?: string;
  type: string;
  actions: ResourceAction[];
  actionReason?: string;
  replacePaths?: string[][];
  importingId?: string;
}

// ============================================================================
// Main Interfaces
// ============================================================================

export interface RoutingPayload {
  requestId: string;
  source: PayloadSource;
  repo: Repo;
  pullRequest: PullRequest;
  repoConfig?: RepositoryConfigSnapshot;
  evaluationTarget: EvaluationTarget;
  changedFiles: string[];
  summary: Summary;
  resources: Resource[];
}

export interface EvidenceItem {
  ruleId: string;
  title: string;
  summary: string;
  resourceAddresses?: string[];
  filePaths?: string[];
}

export interface RequestedReviewers {
  users: string[];
  teams: string[];
}

export interface NotificationDecisions {
  githubCheck: "neutral" | "success" | "failure";
  postComment: boolean;
  sendSlack: boolean;
}

export interface EvaluationResult {
  severity: Severity;
  matchedRuleIds: string[];
  requestedReviewers: RequestedReviewers;
  evidence: EvidenceItem[];
  notifications: NotificationDecisions;

  notifySlackChannels?: string[];
}

// ============================================================================
// Constants
// ============================================================================

export const FORBIDDEN_PAYLOAD_FIELDS = [
  "before",
  "after",
  "variables",
  "values",
  "planned_values",
  "prior_state",
  "configuration",
] as const;

export type ForbiddenField = (typeof FORBIDDEN_PAYLOAD_FIELDS)[number];
