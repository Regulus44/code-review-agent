import { describe, expect, it } from "vitest";
import { FileObservationPolicy } from "./file-observation.js";

describe("FileObservationPolicy", () => {
  it("keeps present and absent observations isolated by session and target", () => {
    const policy = new FileObservationPolicy();
    policy.observe("session-a", "D:/workspace", "src/file.ts", { kind: "present", hash: "v1" });
    policy.observe("session-b", "D:/workspace", "src/file.ts", { kind: "absent" });

    expect(policy.get("session-a", "D:/workspace", "src/file.ts")).toEqual({ kind: "present", hash: "v1" });
    expect(policy.get("session-b", "D:/workspace", "src/file.ts")).toEqual({ kind: "absent" });
    expect(policy.get("session-a", "D:/workspace", "other.ts")).toBeUndefined();
  });

  it("normalizes slash variants and clears only the requested session", () => {
    const policy = new FileObservationPolicy();
    policy.observe("session-a", "D:/workspace", "src\\file.ts", { kind: "present", hash: "v1" });
    policy.observe("session-b", "D:/workspace", "src/file.ts", { kind: "present", hash: "v2" });

    expect(policy.get("session-a", "D:/workspace", "src/file.ts")).toEqual({ kind: "present", hash: "v1" });
    policy.clearSession("session-a");
    expect(policy.get("session-a", "D:/workspace", "src/file.ts")).toBeUndefined();
    expect(policy.get("session-b", "D:/workspace", "src/file.ts")).toEqual({ kind: "present", hash: "v2" });
  });
});
