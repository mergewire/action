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
    expect(payload.pricingResources).toHaveLength(1);
    expect(payload.pricingResources![0].address).toBe("aws_instance.example");
    expect(payload.pricingResources![0].unpricedReason).toBe(
      "missing_dimensions",
    );
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
    expect(payload.pricingResources).toHaveLength(1);
    expect(payload.pricingResources![0].address).toBe("aws_instance.example");
    expect(payload.pricingResources![0].action).toBe("replace");
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
    expect(payload.pricingResources).toHaveLength(1);
    expect(payload.pricingResources![0].address).toBe("aws_instance.example");
    expect(payload.pricingResources![0].action).toBe("import");
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
    expect(payload.resources[0].address).toBe("aws_s3_bucket.data");
    expect(payload.pricingResources).toHaveLength(0);
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
    expect(payload.pricingResources).toHaveLength(0);
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
    expect(payload.pricingResources).toHaveLength(0);
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

    // Pricing resource should be present but keep only normalized pricing-safe dimensions
    expect(payload.pricingResources).toHaveLength(1);
    const pricingResource = payload.pricingResources![0] as Record<
      string,
      unknown
    >;
    expect(pricingResource.before).toBeNull();
    expect(pricingResource.after).toBeNull();
  });

  it("should include pricing resources for supported families", () => {
    const planJson = {
      resource_changes: [
        {
          address: "aws_instance.web",
          type: "aws_instance",
          change: {
            actions: ["create"],
            after: { instance_type: "t3.medium", region: "us-east-1" },
          },
        },
        {
          address: "google_compute_instance.app",
          type: "google_compute_instance",
          change: {
            actions: ["update"],
            after: { machine_type: "n1-standard-2", zone: "us-central1-a" },
            before: { machine_type: "n1-standard-1", zone: "us-central1-a" },
          },
        },
        {
          address: "azurerm_linux_virtual_machine.db",
          type: "azurerm_linux_virtual_machine",
          change: {
            actions: ["delete"],
            before: { size: "Standard_B1s", location: "eastus" },
          },
        },
        {
          address: "aws_db_instance.main",
          type: "aws_db_instance",
          change: {
            actions: ["create"],
            after: {
              instance_class: "db.t3.micro",
              engine: "postgres",
              allocated_storage: 20,
              storage_type: "gp3",
              availability_zone: "us-east-1a",
            },
          },
        },
        {
          address: "aws_ebs_volume.data",
          type: "aws_ebs_volume",
          change: {
            actions: ["create"],
            after: {
              type: "gp3",
              size: 100,
              availability_zone: "us-east-1a",
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

    expect(payload.pricingResources).toHaveLength(5);

    const aws = payload.pricingResources![0];
    expect(aws.address).toBe("aws_instance.web");
    expect(aws.type).toBe("aws_instance");
    expect(aws.provider).toBe("aws");
    expect(aws.region).toBe("us-east-1");
    expect(aws.pricingFamily).toBe("vm_compute");
    expect(aws.after).toEqual({ sku: "t3.medium" });
    expect(aws.action).toBe("create");

    const gcp = payload.pricingResources![1];
    expect(gcp.address).toBe("google_compute_instance.app");
    expect(gcp.type).toBe("google_compute_instance");
    expect(gcp.provider).toBe("gcp");
    expect(gcp.region).toBe("us-central1");
    expect(gcp.pricingFamily).toBe("vm_compute");
    expect(gcp.before).toEqual({ sku: "n1-standard-1" });
    expect(gcp.after).toEqual({ sku: "n1-standard-2" });
    expect(gcp.action).toBe("update");

    const azure = payload.pricingResources![2];
    expect(azure.address).toBe("azurerm_linux_virtual_machine.db");
    expect(azure.type).toBe("azurerm_linux_virtual_machine");
    expect(azure.provider).toBe("azure");
    expect(azure.region).toBe("eastus");
    expect(azure.pricingFamily).toBe("vm_compute");
    expect(azure.before).toEqual({
      sku: "Standard_B1s",
      osDiscriminator: "linux",
    });
    expect(azure.action).toBe("delete");

    const rds = payload.pricingResources![3];
    expect(rds.pricingFamily).toBe("managed_db");
    expect(rds.after).toMatchObject({
      engine: "postgres",
      sku: "db.t3.micro",
      deploymentModel: "single_az",
      storage: {
        sizeGiB: 20,
        storageClass: "gp3",
      },
    });

    const ebs = payload.pricingResources![4];
    expect(ebs.pricingFamily).toBe("block_storage");
    expect(ebs.after).toEqual({
      sku: "gp3",
      sizeGiB: 100,
    });
  });

  it("should mark pricing resources as unpriced when dimensions are missing", () => {
    const planJson = {
      resource_changes: [
        {
          address: "aws_instance.example",
          type: "aws_instance",
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

    expect(payload.pricingResources).toHaveLength(1);
    expect(payload.pricingResources![0].unpricedReason).toBe(
      "missing_dimensions",
    );
    expect(payload.pricingResources![0].region).toBe("");
  });

  it("should NOT include forbidden fields in pricing resources", () => {
    const planJson = {
      resource_changes: [
        {
          address: "aws_instance.example",
          type: "aws_instance",
          change: {
            actions: ["create"],
            before: { instance_type: "t3.small", region: "us-east-1" },
            after: { instance_type: "t3.medium", region: "us-east-1" },
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

    const violations = validateNoForbiddenFields(payload);
    expect(violations).toHaveLength(0);

    expect(payload.pricingResources).toHaveLength(1);
    const pricingResource = payload.pricingResources![0] as Record<
      string,
      unknown
    >;
    expect(pricingResource.before).toBeNull();
    expect(pricingResource.after).toEqual({ sku: "t3.medium" });
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
