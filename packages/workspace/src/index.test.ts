import { describe, expect, it } from "vitest";
import { WorkspaceResolver, WorkspaceViolation } from "./index.js";

describe("WorkspaceResolver", () => {
  it("keeps paths inside the workspace", () => {
    const resolver = new WorkspaceResolver("D:/workspace");
    expect(resolver.resolve("src/index.ts")).toMatch(/workspace[\\/]src[\\/]index\.ts$/u);
  });

  it("rejects traversal", () => {
    const resolver = new WorkspaceResolver("D:/workspace");
    expect(() => resolver.resolve("../secrets.txt")).toThrow(WorkspaceViolation);
  });
});
