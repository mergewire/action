import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendPayload } from "../api-client.js";
import type { RoutingPayload } from "../core/types.js";

// Mock fetch globally
global.fetch = vi.fn();

describe("sendPayload", () => {
  const mockPayload: RoutingPayload = {
    requestId: "test-request-id",
    source: { provider: "github-actions", version: "0.1.0" },
    repo: { owner: "test-owner", name: "test-repo" },
    pullRequest: {
      number: 42,
      baseRef: "main",
      headRef: "feature-branch",
      headSha: "abc123",
    },
    repoConfig: {
      path: ".mergewire.yml",
      ref: "feature-branch",
      yaml: "version: 1\nrules: []\n",
    },
    evaluationTarget: { terraformRoot: "./terraform" },
    changedFiles: ["main.tf"],
    summary: { creates: 1, updates: 0, deletes: 0, replaces: 0, imports: 0 },
    resources: [
      {
        address: "aws_instance.example",
        type: "aws_instance",
        actions: ["create"],
      },
    ],
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should send payload with correct headers", async () => {
    const mockFetch = vi.mocked(global.fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "accepted" }),
    } as Response);

    const result = await sendPayload(
      "https://api.example.com",
      "secret",
      mockPayload,
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/ingest",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-API-Key": "secret",
          "X-Request-Id": "test-request-id",
          "X-Source": "github-actions",
        }),
      }),
    );
    expect(result.status).toBe("accepted");
  });

  it("should handle accepted response", async () => {
    const mockFetch = vi.mocked(global.fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "accepted", message: "Success" }),
    } as Response);

    const result = await sendPayload(
      "https://api.example.com",
      "secret",
      mockPayload,
    );

    expect(result.status).toBe("accepted");
    expect(result.message).toBe("Success");
  });

  it("should handle duplicate response (409)", async () => {
    const mockFetch = vi.mocked(global.fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => "Conflict",
    } as Response);

    const result = await sendPayload(
      "https://api.example.com",
      "secret",
      mockPayload,
    );

    expect(result.status).toBe("duplicate");
  });

  it("should handle API error response", async () => {
    const mockFetch = vi.mocked(global.fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    } as Response);

    const result = await sendPayload(
      "https://api.example.com",
      "secret",
      mockPayload,
    );

    expect(result.status).toBe("failed");
    expect(result.message).toContain("500");
  });

  it("should handle skipped response", async () => {
    const mockFetch = vi.mocked(global.fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "skipped", message: "No changes" }),
    } as Response);

    const result = await sendPayload(
      "https://api.example.com",
      "secret",
      mockPayload,
    );

    expect(result.status).toBe("skipped");
    expect(result.message).toBe("No changes");
  });

  it("should handle API error status", async () => {
    const mockFetch = vi.mocked(global.fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "error", message: "Bad request" }),
    } as Response);

    const result = await sendPayload(
      "https://api.example.com",
      "secret",
      mockPayload,
    );

    expect(result.status).toBe("failed");
    expect(result.message).toBe("Bad request");
  });

  it("should handle non-JSON success response", async () => {
    const mockFetch = vi.mocked(global.fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Invalid JSON");
      },
    } as Response);

    const result = await sendPayload(
      "https://api.example.com",
      "secret",
      mockPayload,
    );

    expect(result.status).toBe("accepted");
  });

  it("should normalize API URL trailing slash", async () => {
    const mockFetch = vi.mocked(global.fetch);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: "accepted" }),
    } as Response);

    await sendPayload("https://api.example.com/", "secret", mockPayload);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/ingest",
      expect.any(Object),
    );
  });
});
