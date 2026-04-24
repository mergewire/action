import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  parseSlackWebhooks,
  resolveSlackChannels,
  sendRuleSlackNotifications,
} from "../slack-sender.js";
import type { EvaluationResult } from "../core/types.js";

// Mock @actions/core to capture warnings
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
}));

// Mock fetch globally
global.fetch = vi.fn();

const mockEvaluation: EvaluationResult = {
  severity: "high",
  matchedRuleIds: ["prod-destructive"],
  requestedReviewers: { users: ["alice"], teams: ["sre-team"] },
  evidence: [
    {
      ruleId: "prod-destructive",
      title: "Destructive changes in production",
      summary: "2 resources being deleted",
      resourceAddresses: ["aws_instance.web"],
    },
  ],
  notifications: { githubCheck: "failure", postComment: true, sendSlack: true },
};

// ============================================================================
// parseSlackWebhooks
// ============================================================================

describe("parseSlackWebhooks", () => {
  it("should parse a simple name=url pair", () => {
    const input = "alerts=https://hooks.slack.com/services/T1/B1/xxx";
    const result = parseSlackWebhooks(input);
    expect(result.size).toBe(1);
    expect(result.get("alerts")).toBe(
      "https://hooks.slack.com/services/T1/B1/xxx",
    );
  });

  it("should parse multiple channels", () => {
    const input = [
      "alerts=https://hooks.slack.com/services/T1/B1/xxx",
      "security=https://hooks.slack.com/services/T2/B2/yyy",
      "infra=https://hooks.slack.com/services/T3/B3/zzz",
    ].join("\n");
    const result = parseSlackWebhooks(input);
    expect(result.size).toBe(3);
    expect(result.get("security")).toBe(
      "https://hooks.slack.com/services/T2/B2/yyy",
    );
  });

  it("should ignore blank lines", () => {
    const input = "\nalerts=https://hooks.slack.com/services/T1/B1/xxx\n\n";
    const result = parseSlackWebhooks(input);
    expect(result.size).toBe(1);
  });

  it("should ignore comment lines starting with #", () => {
    const input = [
      "# This is a comment",
      "alerts=https://hooks.slack.com/services/T1/B1/xxx",
    ].join("\n");
    const result = parseSlackWebhooks(input);
    expect(result.size).toBe(1);
    expect(result.has("alerts")).toBe(true);
  });

  it("should ignore lines with no = separator", () => {
    const input = [
      "not-a-valid-line",
      "alerts=https://hooks.slack.com/services/T1/B1/xxx",
    ].join("\n");
    const result = parseSlackWebhooks(input);
    expect(result.size).toBe(1);
  });

  it("should reject non-HTTPS URLs and not add them to the map", () => {
    const input = "bad=http://hooks.slack.com/services/T1/B1/xxx";
    const result = parseSlackWebhooks(input);
    expect(result.size).toBe(0);
  });

  it("should return empty map for empty input", () => {
    expect(parseSlackWebhooks("").size).toBe(0);
    expect(parseSlackWebhooks("   ").size).toBe(0);
  });

  it("should handle URL with = in the value", () => {
    const input = "alerts=https://hooks.slack.com/services/T1/B1/xxx=extra";
    const result = parseSlackWebhooks(input);
    // Only the first = splits name from URL
    expect(result.get("alerts")).toBe(
      "https://hooks.slack.com/services/T1/B1/xxx=extra",
    );
  });
});

// ============================================================================
// resolveSlackChannels
// ============================================================================

describe("resolveSlackChannels", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await os.tmpdir();
    tmpDir = path.join(tmpDir, `mergewire-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should resolve channel names from matched rules in config", async () => {
    const configPath = path.join(tmpDir, ".mergewire.yml");
    await writeFile(
      configPath,
      `
version: 1
defaults:
  reviewers:
    teams: []
    users: []
rules:
  - id: prod-destructive
    description: Destructive changes
    when:
      actions: [delete, replace]
    severity: high
    notify:
      slack: alerts
  - id: iam-changes
    description: IAM changes
    when:
      categories: [iam]
    severity: high
    notify:
      slack: security
`.trim(),
    );

    const channels = await resolveSlackChannels(configPath, [
      "prod-destructive",
    ]);
    expect(channels).toEqual(["alerts"]);
  });

  it("should return multiple channels when multiple matched rules have notify.slack", async () => {
    const configPath = path.join(tmpDir, ".mergewire.yml");
    await writeFile(
      configPath,
      `
version: 1
defaults:
  reviewers:
    teams: []
    users: []
rules:
  - id: rule-a
    description: Rule A
    when:
      actions: [delete]
    severity: high
    notify:
      slack: alerts
  - id: rule-b
    description: Rule B
    when:
      actions: [delete]
    severity: high
    notify:
      slack: security
`.trim(),
    );

    const channels = await resolveSlackChannels(configPath, [
      "rule-a",
      "rule-b",
    ]);
    expect(channels).toHaveLength(2);
    expect(channels).toContain("alerts");
    expect(channels).toContain("security");
  });

  it("should deduplicate channels when multiple rules share the same channel", async () => {
    const configPath = path.join(tmpDir, ".mergewire.yml");
    await writeFile(
      configPath,
      `
version: 1
defaults:
  reviewers:
    teams: []
    users: []
rules:
  - id: rule-a
    description: Rule A
    when: {}
    severity: high
    notify:
      slack: alerts
  - id: rule-b
    description: Rule B
    when: {}
    severity: high
    notify:
      slack: alerts
`.trim(),
    );

    const channels = await resolveSlackChannels(configPath, [
      "rule-a",
      "rule-b",
    ]);
    expect(channels).toHaveLength(1);
    expect(channels).toEqual(["alerts"]);
  });

  it("should return empty array when config file does not exist", async () => {
    const channels = await resolveSlackChannels("/nonexistent/.mergewire.yml", [
      "rule-a",
    ]);
    expect(channels).toEqual([]);
  });

  it("should return empty array when matched rules have no notify.slack", async () => {
    const configPath = path.join(tmpDir, ".mergewire.yml");
    await writeFile(
      configPath,
      `
version: 1
defaults:
  reviewers:
    teams: []
    users: []
rules:
  - id: rule-a
    description: Rule A
    when: {}
    severity: high
`.trim(),
    );

    const channels = await resolveSlackChannels(configPath, ["rule-a"]);
    expect(channels).toEqual([]);
  });

  it("should return empty array for empty matchedRuleIds", async () => {
    const configPath = path.join(tmpDir, ".mergewire.yml");
    await writeFile(
      configPath,
      "version: 1\ndefaults:\n  reviewers:\n    teams: []\n    users: []\nrules: []\n",
    );
    const channels = await resolveSlackChannels(configPath, []);
    expect(channels).toEqual([]);
  });
});

// ============================================================================
// sendRuleSlackNotifications
// ============================================================================

describe("sendRuleSlackNotifications", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `mergewire-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    vi.mocked(fetch).mockReset();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("should send to correct webhook when channel name matches", async () => {
    const configPath = path.join(tmpDir, ".mergewire.yml");
    await writeFile(
      configPath,
      `
version: 1
defaults:
  reviewers:
    teams: []
    users: []
rules:
  - id: prod-destructive
    description: Test
    when: {}
    severity: high
    notify:
      slack: alerts
`.trim(),
    );

    vi.mocked(fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const webhookMap = new Map([
      ["alerts", "https://hooks.slack.com/services/T1/B1/xxx"],
    ]);
    await sendRuleSlackNotifications({
      webhookMap,
      matchedRuleIds: ["prod-destructive"],
      configPath,
      evaluation: mockEvaluation,
      repository: { owner: "acme", name: "infra" },
      prNumber: 42,
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "https://hooks.slack.com/services/T1/B1/xxx",
    );
  });

  it("should format critical severity explicitly", async () => {
    const configPath = path.join(tmpDir, ".mergewire.yml");
    await writeFile(
      configPath,
      `
version: 1
defaults:
  reviewers:
    teams: []
    users: []
rules:
  - id: prod-destructive
    description: Test
    when: {}
    severity: critical
    notify:
      slack: alerts
`.trim(),
    );

    vi.mocked(fetch).mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await sendRuleSlackNotifications({
      webhookMap: new Map([
        ["alerts", "https://hooks.slack.com/services/T1/B1/xxx"],
      ]),
      matchedRuleIds: ["prod-destructive"],
      configPath,
      evaluation: { ...mockEvaluation, severity: "critical" },
      repository: { owner: "acme", name: "infra" },
      prNumber: 42,
    });

    const body = JSON.parse(
      vi.mocked(fetch).mock.calls[0]?.[1]?.body as string,
    );
    expect(body.text).toContain("🚨 Critical severity alert");
    expect(JSON.stringify(body.blocks)).toContain("🚨 *Critical Severity*");
  });

  it("should log warning and not throw when channel name has no webhook", async () => {
    const core = await import("@actions/core");
    vi.mocked(core.warning).mockReset();
    const configPath = path.join(tmpDir, ".mergewire.yml");
    await writeFile(
      configPath,
      `
version: 1
defaults:
  reviewers:
    teams: []
    users: []
rules:
  - id: rule-a
    description: Test
    when: {}
    severity: high
    notify:
      slack: missing-channel
`.trim(),
    );

    // Has a webhook defined, but not for the channel the rule targets
    const webhookMap = new Map([
      ["other-channel", "https://hooks.slack.com/services/T1/B1/xxx"],
    ]);
    await sendRuleSlackNotifications({
      webhookMap,
      matchedRuleIds: ["rule-a"],
      configPath,
      evaluation: mockEvaluation,
      repository: { owner: "acme", name: "infra" },
      prNumber: 42,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("missing-channel"),
    );
  });

  it("should log warning and not throw when webhook returns error", async () => {
    const core = await import("@actions/core");
    vi.mocked(core.warning).mockReset();
    const configPath = path.join(tmpDir, ".mergewire.yml");
    await writeFile(
      configPath,
      `
version: 1
defaults:
  reviewers:
    teams: []
    users: []
rules:
  - id: rule-a
    description: Test
    when: {}
    severity: high
    notify:
      slack: alerts
`.trim(),
    );

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("invalid_payload", { status: 400 }),
    );

    const webhookMap = new Map([
      ["alerts", "https://hooks.slack.com/services/T1/B1/xxx"],
    ]);
    await sendRuleSlackNotifications({
      webhookMap,
      matchedRuleIds: ["rule-a"],
      configPath,
      evaluation: mockEvaluation,
      repository: { owner: "acme", name: "infra" },
      prNumber: 42,
    });

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("alerts"),
    );
  });

  it("should do nothing when webhookMap is empty", async () => {
    await sendRuleSlackNotifications({
      webhookMap: new Map(),
      matchedRuleIds: ["rule-a"],
      configPath: "/some/path/.mergewire.yml",
      evaluation: mockEvaluation,
      repository: { owner: "acme", name: "infra" },
      prNumber: 42,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
