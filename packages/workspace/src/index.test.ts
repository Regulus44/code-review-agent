import { describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

  it.skipIf(process.platform === "win32")("rejects existing symlinks that escape the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-workspace-"));
    const outside = await mkdtemp(path.join(tmpdir(), "cra-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    const resolver = new WorkspaceResolver(root);
    await expect(resolver.resolveExisting("link.txt")).rejects.toBeInstanceOf(WorkspaceViolation);
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  });
});
