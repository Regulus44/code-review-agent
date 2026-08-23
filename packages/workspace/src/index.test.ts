import { describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitWorktreeManager, WorktreeDirtyError, WorkspaceResolver, WorkspaceViolation } from "./index.js";

const execFileAsync = promisify(execFile);

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

  it("creates, inspects, protects dirty state, and cleans a Git worktree", async () => {
    try { await execFileAsync("git", ["--version"]); } catch { return; }
    const parent = await mkdtemp(path.join(tmpdir(), "cra-worktree-parent-"));
    const repo = path.join(parent, "repo");
    const worktree = path.join(parent, "repo-worktree");
    await execFileAsync("git", ["init", "-q", repo]);
    await execFileAsync("git", ["-C", repo, "config", "user.email", "agent@example.test"]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Coding Agent"]);
    await writeFile(path.join(repo, "README.md"), "initial\n");
    await execFileAsync("git", ["-C", repo, "add", "README.md"]);
    await execFileAsync("git", ["-C", repo, "commit", "-qm", "initial"]);
    try {
      const manager = new GitWorktreeManager(repo);
      const created = await manager.create({ id: "feature-one", branch: "feature/one", path: worktree });
      expect(created.path).toBe(path.resolve(worktree));
      expect(created.branch).toBe("feature/one");
      expect(created.status).toBe("clean");
      await writeFile(path.join(worktree, "dirty.txt"), "dirty\n");
      await expect(manager.cleanup(worktree)).rejects.toBeInstanceOf(WorktreeDirtyError);
      const removed = await manager.cleanup(worktree, true);
      expect(removed.status).toBe("removed");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("resolves linked worktree operations back to the main repository", async () => {
    try { await execFileAsync("git", ["--version"]); } catch { return; }
    const parent = await mkdtemp(path.join(tmpdir(), "cra-worktree-linked-"));
    const repo = path.join(parent, "repo");
    const linked = path.join(parent, "linked");
    try {
      await execFileAsync("git", ["init", "-q", repo]);
      await execFileAsync("git", ["-C", repo, "config", "user.email", "agent@example.test"]);
      await execFileAsync("git", ["-C", repo, "config", "user.name", "Coding Agent"]);
      await writeFile(path.join(repo, "README.md"), "initial\n", "utf8");
      await execFileAsync("git", ["-C", repo, "add", "README.md"]);
      await execFileAsync("git", ["-C", repo, "commit", "-qm", "initial"]);

      const mainManager = new GitWorktreeManager(repo);
      const created = await mainManager.create({ id: "linked-one", branch: "feature/linked", path: linked });
      const linkedManager = new GitWorktreeManager(linked);
      expect((await linkedManager.assertRepository())).toBe(path.resolve(repo));
      expect((await linkedManager.inspect(linked)).repoRoot).toBe(path.resolve(repo));
      const listed = await linkedManager.list();
      expect(listed.map((item) => item.path)).toEqual(expect.arrayContaining([path.resolve(repo), path.resolve(linked)]));
      expect(await linkedManager.cleanup(created.path)).toMatchObject({ status: "removed", repoRoot: path.resolve(repo) });
      await expect(mainManager.cleanup(repo)).rejects.toThrow("main repository");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
