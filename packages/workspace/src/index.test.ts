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

  it("accepts absolute paths inside the root and rejects absolute paths outside it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-workspace-absolute-"));
    try {
      const resolver = new WorkspaceResolver(root); const inside = path.join(root, "inside.txt"); const outside = path.join(path.dirname(root), "outside.txt");
      expect(resolver.resolve(inside)).toBe(path.resolve(inside)); expect(() => resolver.resolve(outside)).toThrow(WorkspaceViolation);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects existing symlinks that escape the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-workspace-"));
    const outside = await mkdtemp(path.join(tmpdir(), "cra-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    const link = process.platform === "win32" ? path.join(root, "link") : path.join(root, "link.txt");
    await symlink(process.platform === "win32" ? outside : path.join(outside, "secret.txt"), link, process.platform === "win32" ? "junction" : "file");
    const resolver = new WorkspaceResolver(root);
    await expect(resolver.resolveExisting(process.platform === "win32" ? "link/secret.txt" : "link.txt")).rejects.toBeInstanceOf(WorkspaceViolation);
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  });
});
