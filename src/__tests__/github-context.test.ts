import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractGitHubContext,
  getChangedFiles,
  isGitHubActions,
  getRunId,
  getRunUrl,
} from "../github-context.js";

// Mock @actions/github
vi.mock("@actions/github", () => ({
  default: {
    context: {
      repo: {
        owner: "test-owner",
        repo: "test-repo",
      },
      payload: {
        pull_request: {
          number: 42,
          base: { ref: "main" },
          head: { ref: "feature-branch", sha: "abc123def456" },
        },
      },
    },
    getOctokit: vi.fn(),
  },
  context: {
    repo: {
      owner: "test-owner",
      repo: "test-repo",
    },
    payload: {
      pull_request: {
        number: 42,
        base: { ref: "main" },
        head: { ref: "feature-branch", sha: "abc123def456" },
      },
    },
  },
  getOctokit: vi.fn(),
}));

// Mock @actions/core
vi.mock("@actions/core", () => ({
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

describe("extractGitHubContext", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("should extract context from GitHub Actions environment", () => {
    const context = extractGitHubContext();

    expect(context.repo).toEqual({
      owner: "test-owner",
      name: "test-repo",
    });
    expect(context.pullRequest).toEqual({
      number: 42,
      baseRef: "main",
      headRef: "feature-branch",
      headSha: "abc123def456",
    });
    expect(context.source.provider).toBe("github-actions");
    expect(context.source.version).toBeDefined();
  });

  it("should throw error when not in PR context", async () => {
    const github = await import("@actions/github");
    const originalPayload = github.context.payload;

    // @ts-expect-error - modifying mock
    github.context.payload = {};

    expect(() => extractGitHubContext()).toThrow("pull request context");

    // Restore
    // @ts-expect-error - modifying mock
    github.context.payload = originalPayload;
  });
});

describe("getChangedFiles", () => {
  it("should fetch changed files from GitHub API", async () => {
    const mockPaginate = {
      async *iterator() {
        yield {
          data: [{ filename: "src/main.tf" }, { filename: "src/variables.tf" }],
        };
      },
    };

    const github = await import("@actions/github");
    const mockOctokit = {
      paginate: { iterator: mockPaginate.iterator },
      rest: {
        pulls: {
          listFiles: vi.fn(),
        },
      },
    };
    // @ts-expect-error - mocking
    github.getOctokit = vi.fn(() => mockOctokit);

    const files = await getChangedFiles("token", "owner", "repo", 42);

    expect(files).toEqual(["src/main.tf", "src/variables.tf"]);
    expect(github.getOctokit).toHaveBeenCalledWith("token");
  });
});

describe("isGitHubActions", () => {
  it("should return true when GITHUB_ACTIONS is true", () => {
    const original = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = "true";

    expect(isGitHubActions()).toBe(true);

    process.env.GITHUB_ACTIONS = original;
  });

  it("should return false when GITHUB_ACTIONS is not set", () => {
    const original = process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_ACTIONS;

    expect(isGitHubActions()).toBe(false);

    process.env.GITHUB_ACTIONS = original;
  });
});

describe("getRunId", () => {
  it("should return the run ID from environment", () => {
    const original = process.env.GITHUB_RUN_ID;
    process.env.GITHUB_RUN_ID = "12345";

    expect(getRunId()).toBe(12345);

    process.env.GITHUB_RUN_ID = original;
  });

  it("should return 0 when run ID is not set", () => {
    const original = process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ID;

    expect(getRunId()).toBe(0);

    process.env.GITHUB_RUN_ID = original;
  });
});

describe("getRunUrl", () => {
  it("should construct the run URL", () => {
    const originalEnv = { ...process.env };
    process.env.GITHUB_SERVER_URL = "https://github.com";
    process.env.GITHUB_REPOSITORY = "owner/repo";
    process.env.GITHUB_RUN_ID = "12345";

    expect(getRunUrl()).toBe(
      "https://github.com/owner/repo/actions/runs/12345",
    );

    process.env = originalEnv;
  });
});
