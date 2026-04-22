import { describe, it, expect } from "vitest";
import {
  buildRoutingPayload,
  validateNoForbiddenFields,
} from "../payload-builder.js";
import type { Repo, PullRequest, PayloadSource } from "../core/types.js";

const mockRepo: Repo = {
  owner: "test-owner",
  name: "test-repo",
};

const mockPullRequest: PullRequest = {
  number: 42,
  baseRef: "main",
  headRef: "feature-branch",
  headSha: "abc123",
  author: "test-author",
};

const mockSource: PayloadSource = {
  provider: "github-actions",
  version: "0.1.0",
};

describe("buildRoutingPayload", () => {
  it("should build payload from terraform plan", () => {
    const planJson = {
      resource_changes: [
        {
          address: "aws_instance.example",
          type: "aws_instance",
          change: {
            actions: ["create"],
          },
        },
        {
          address: "module.vpc.aws_vpc.main",
          module_address: "module.vpc",
          type: "aws_vpc",
          change: {
            actions: ["update"],
            action_reason: "replace_triggered_by",
          },
        },
      ],
    };

    const payload = buildRoutingPayload({
      requestId: "req-123",
      source: mockSource,
      repo: mockRepo,
      pullRequest: mockPullRequest,
      terraformRoot: "./terraform",
      workspace: "prod",
      environment: "production",
      changedFiles: ["main.tf", "variables.tf"],
      planJson,
    });

    expect(payload.requestId).toBe("req-123");
    expect(payload.repo).toEqual(mockRepo);
    expect(payload.pullRequest).toEqual(mockPullRequest);
    expect(payload.evaluationTarget).toEqual({
      terraformRoot: "./terraform",
      workspace: "prod",
      environment: "production",
    });
    expect(payload.changedFiles).toEqual(["main.tf", "variables.tf"]);
    expect(payload.resources).toHaveLength(2);
    expect(payload.summary.creates).toBe(1);
    expect(payload.summary.updates).toBe(1);
  });

  it("should include repoConfig snapshot when provided", () => {
    const payload = buildRoutingPayload({
      requestId: "req-123",
      source: mockSource,
      repo: mockRepo,
      pullRequest: mockPullRequest,
      terraformRoot: "./terraform",
      changedFiles: [".mergewire.yml"],
      repoConfig: {
        path: ".mergewire.yml",
        ref: "feature-branch",
        yaml: "version: 1\nrules: []\n",
      },
      planJson: { resource_changes: [] },
    });

    expect(payload.repoConfig).toEqual({
      path: ".mergewire.yml",
      ref: "feature-branch",
      yaml: "version: 1\nrules: []\n",
    });
  });

  it("should normalize replacement actions", () => {
    const planJson = {
      resource_changes: [
        {
          address: "aws_instance.example",
          type: "aws_instance",
          change: {
            actions: ["create", "delete"],
            replace_paths: [["attr1"], ["attr2"]],
          },
        },
      ],
    };

    const payload = buildRoutingPayload({
      requestId: "req-123",
      source: mockSource,
      repo: mockRepo,
      pullRequest: mockPullRequest,
      terraformRoot: "./terraform",
      changedFiles: [],
      planJson,
    });

    expect(payload.resources[0].actions).toEqual(["replace"]);
    expect(payload.resources[0].replacePaths).toEqual([["attr1"], ["attr2"]]);
    expect(payload.summary.replaces).toBe(1);
  });

  it("should handle import operations", () => {
    const planJson = {
      resource_changes: [
        {
          address: "aws_instance.example",
          type: "aws_instance",
          change: {
            actions: ["no-op"],
            importing: {
              id: "i-1234567890abcdef0",
            },
          },
        },
      ],
    };

    const payload = buildRoutingPayload({
      requestId: "req-123",
      source: mockSource,
      repo: mockRepo,
      pullRequest: mockPullRequest,
      terraformRoot: "./terraform",
      changedFiles: [],
      planJson,
    });

    expect(payload.resources[0].actions).toEqual(["import"]);
    expect(payload.resources[0].importingId).toBe("i-1234567890abcdef0");
    expect(payload.summary.imports).toBe(1);
  });

  it("should skip no-op resources without imports", () => {
    const planJson = {
      resource_changes: [
        {
          address: "aws_instance.example",
          type: "aws_instance",
          change: {
            actions: ["no-op"],
          },
        },
        {
          address: "aws_s3_bucket.data",
          type: "aws_s3_bucket",
          change: {
            actions: ["create"],
          },
        },
      ],
    };

    const payload = buildRoutingPayload({
      requestId: "req-123",
      source: mockSource,
      repo: mockRepo,
      pullRequest: mockPullRequest,
      terraformRoot: "./terraform",
      changedFiles: [],
      planJson,
    });

    expect(payload.resources).toHaveLength(1);
  });

  it("should handle empty plan", () => {
    const planJson = {
      resource_changes: [],
    };

    const payload = buildRoutingPayload({
      requestId: "req-123",
      source: mockSource,
      repo: mockRepo,
      pullRequest: mockPullRequest,
      terraformRoot: "./terraform",
      changedFiles: [],
      planJson,
    });

    expect(payload.resources).toHaveLength(0);
    expect(payload.summary).toEqual({
      creates: 0,
      updates: 0,
      deletes: 0,
      replaces: 0,
      imports: 0,
    });
  });

  it("should handle missing resource_changes", () => {
    const planJson = {};

    const payload = buildRoutingPayload({
      requestId: "req-123",
      source: mockSource,
      repo: mockRepo,
      pullRequest: mockPullRequest,
      terraformRoot: "./terraform",
      changedFiles: [],
      planJson,
    });

    expect(payload.resources).toHaveLength(0);
  });

  it("should NOT include forbidden fields in payload", () => {
    // Simulate a plan with sensitive data that should be excluded
    const planJson = {
      resource_changes: [
        {
          address: "aws_instance.example",
          type: "aws_instance",
          change: {
            actions: ["create"],
            before: { sensitive: "data" }, // Should be excluded
            after: { password: "secret" }, // Should be excluded
          },
          // These shouldn't be in our payload builder output
        },
      ],
      variables: { secret_key: "value" }, // Should be excluded
      configuration: { provider: {} }, // Should be excluded
    };

    const payload = buildRoutingPayload({
      requestId: "req-123",
      source: mockSource,
      repo: mockRepo,
      pullRequest: mockPullRequest,
      terraformRoot: "./terraform",
      changedFiles: [],
      planJson,
    });

    // Verify no forbidden fields in payload
    const violations = validateNoForbiddenFields(payload);
    expect(violations).toHaveLength(0);

    // Verify resource doesn't have before/after
    const resource = payload.resources[0] as Record<string, unknown>;
    expect(resource.before).toBeUndefined();
    expect(resource.after).toBeUndefined();
  });
});

describe("validateNoForbiddenFields", () => {
  it("should detect forbidden fields at root level", () => {
    const obj = {
      safe: "value",
      before: { sensitive: true },
      after: { data: true },
    };

    const violations = validateNoForbiddenFields(obj);
    expect(violations).toContain("before");
    expect(violations).toContain("after");
  });

  it("should detect forbidden fields in nested objects", () => {
    const obj = {
      level1: {
        level2: {
          variables: { secret: true },
        },
      },
    };

    const violations = validateNoForbiddenFields(obj);
    expect(violations).toContain("level1.level2.variables");
  });

  it("should detect forbidden fields in arrays", () => {
    const obj = {
      items: [{ safe: true }, { before: { data: true } }],
    };

    const violations = validateNoForbiddenFields(obj);
    expect(violations).toContain("items[1].before");
  });

  it("should return empty array when no forbidden fields", () => {
    const obj = {
      address: "aws_instance.example",
      type: "aws_instance",
      actions: ["create"],
    };

    const violations = validateNoForbiddenFields(obj);
    expect(violations).toHaveLength(0);
  });

  it("should handle null and primitive values", () => {
    expect(validateNoForbiddenFields(null)).toHaveLength(0);
    expect(validateNoForbiddenFields("string")).toHaveLength(0);
    expect(validateNoForbiddenFields(123)).toHaveLength(0);
  });
});
