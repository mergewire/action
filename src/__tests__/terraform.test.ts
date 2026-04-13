import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runTerraform,
  isTerraformInstalled,
  validateTerraform,
} from "../terraform.js";
import * as exec from "@actions/exec";
import * as fs from "fs";

// Mock dependencies
vi.mock("@actions/exec");
vi.mock("@actions/core");

vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

describe("runTerraform", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should run terraform init, plan, and show", async () => {
    const mockExec = vi.mocked(exec.exec);
    const mockExistsSync = vi.mocked(fs.existsSync);
    const mockStatSync = vi.mocked(fs.statSync);
    const mockUnlinkSync = vi.mocked(fs.unlinkSync);

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 1024 } as fs.Stats);
    mockUnlinkSync.mockReturnValue(undefined);

    // Mock terraform commands
    mockExec.mockImplementation(async (cmd, args, options) => {
      if (cmd === "terraform" && args?.includes("show")) {
        // Simulate JSON output
        if (options?.listeners?.stdout) {
          options.listeners.stdout(
            Buffer.from(
              JSON.stringify({
                resource_changes: [],
              }),
            ),
          );
        }
      }
      return 0;
    });

    const result = await runTerraform("./terraform", "dev");

    expect(mockExec).toHaveBeenCalledWith(
      "terraform",
      ["init", "-no-color"],
      expect.any(Object),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "terraform",
      ["workspace", "select", "dev"],
      expect.any(Object),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "terraform",
      [
        "plan",
        "-out",
        expect.stringContaining("tfplan.bin"),
        "-no-color",
        "-input=false",
      ],
      expect.any(Object),
    );
    expect(result.binarySize).toBe(1024);
    expect(result.planJson).toEqual({ resource_changes: [] });
  });

  it("should create workspace if it does not exist", async () => {
    const mockExec = vi.mocked(exec.exec);
    const mockExistsSync = vi.mocked(fs.existsSync);
    const mockStatSync = vi.mocked(fs.statSync);

    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 1024 } as fs.Stats);

    // Track which command we're executing
    let callIndex = 0;
    mockExec.mockImplementation(async (cmd, args, options) => {
      callIndex++;

      // Simulate workspace select failing on first attempt
      if (
        callIndex === 2 &&
        args?.includes("workspace") &&
        args?.includes("select")
      ) {
        throw new Error("workspace not found");
      }

      // Return JSON for terraform show
      if (cmd === "terraform" && args?.includes("show")) {
        if (options?.listeners?.stdout) {
          options.listeners.stdout(
            Buffer.from(JSON.stringify({ resource_changes: [] })),
          );
        }
      }
      return 0;
    });

    await runTerraform("./terraform", "dev");

    // Should have tried to create the workspace after select failed
    expect(mockExec).toHaveBeenCalledWith(
      "terraform",
      ["workspace", "new", "dev"],
      expect.any(Object),
    );
  });

  it("should throw error if directory does not exist", async () => {
    const mockExistsSync = vi.mocked(fs.existsSync);
    mockExistsSync.mockReturnValue(false);

    await expect(runTerraform("./nonexistent")).rejects.toThrow(
      "does not exist",
    );
  });

  it("should throw error if terraform command fails", async () => {
    const mockExec = vi.mocked(exec.exec);
    const mockExistsSync = vi.mocked(fs.existsSync);

    mockExistsSync.mockReturnValue(true);
    mockExec.mockRejectedValue(new Error("terraform init failed"));

    await expect(runTerraform("./terraform")).rejects.toThrow();
  });
});

describe("isTerraformInstalled", () => {
  it("should return true when terraform is available", async () => {
    const mockExec = vi.mocked(exec.exec);
    mockExec.mockResolvedValue(0);

    const result = await isTerraformInstalled();
    expect(result).toBe(true);
  });

  it("should return false when terraform is not available", async () => {
    const mockExec = vi.mocked(exec.exec);
    mockExec.mockRejectedValue(new Error("command not found"));

    const result = await isTerraformInstalled();
    expect(result).toBe(false);
  });
});

describe("validateTerraform", () => {
  it("should run terraform validate", async () => {
    const mockExec = vi.mocked(exec.exec);
    mockExec.mockResolvedValue(0);

    await validateTerraform("./terraform");

    expect(mockExec).toHaveBeenCalledWith(
      "terraform",
      ["validate", "-no-color"],
      expect.any(Object),
    );
  });
});
