import { describe, expect, it } from "vitest";
import { formatJoinCode, normalizeJoinCode } from "../src/core/join-codes";

describe("join code presentation", () => {
  it("groups the original 12-character code in fours", () => {
    expect(formatJoinCode("abcdef123456")).toBe("ABCD-EF12-3456");
  });
  it("accepts both grouped and legacy ungrouped input", () => {
    expect(normalizeJoinCode(" abcd-ef12-3456 ")).toBe("ABCDEF123456");
    expect(normalizeJoinCode("abcdef123456")).toBe("ABCDEF123456");
  });
  it("does not double-group an already formatted code", () => {
    expect(formatJoinCode("ABCD-EF12-3456")).toBe("ABCD-EF12-3456");
  });
  it("formats partial input without trailing separators", () => {
    expect(formatJoinCode("")).toBe("");
    expect(formatJoinCode("abcd")).toBe("ABCD");
    expect(formatJoinCode("abcde")).toBe("ABCD-E");
  });
});
