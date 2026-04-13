import { describe, it, expect } from "vitest";
import { isReplacementAction } from "../helpers.js";

describe("isReplacementAction", () => {
  it("should return true for actions indicating replacement (create, delete)", () => {
    expect(isReplacementAction(["create", "delete"])).toBe(true);
  });

  it("should return true when order is delete, create", () => {
    expect(isReplacementAction(["delete", "create"])).toBe(true);
  });

  it("should return false for empty array", () => {
    expect(isReplacementAction([])).toBe(false);
  });

  it("should return false for array with only one action", () => {
    expect(isReplacementAction(["create"])).toBe(false);
    expect(isReplacementAction(["delete"])).toBe(false);
    expect(isReplacementAction(["update"])).toBe(false);
  });

  it("should return false when extra actions are present", () => {
    expect(isReplacementAction(["create", "delete", "update"])).toBe(false);
    expect(isReplacementAction(["create", "delete", "read"])).toBe(false);
  });

  it("should return false for other combinations", () => {
    expect(isReplacementAction(["create", "update"])).toBe(false);
    expect(isReplacementAction(["delete", "update"])).toBe(false);
    expect(isReplacementAction(["read"])).toBe(false);
    expect(isReplacementAction(["no-op"])).toBe(false);
  });
});
