import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FileProjectMemoryStore } from "./project-memory-fs.js";
import { validateProjectMemoryTopic } from "./project-memory.js";
import type { ProjectMemoryScope } from "./project-memory.js";

const scope: ProjectMemoryScope = { sessionId: "ses", workspaceRoot: "D:/workspace", tenantId: "tenant-a", scopeKey: "pm_scope_a" };

describe("FileProjectMemoryStore", () => {
  it("writes and reads bounded MEMORY.md and typed topics atomically", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "project-memory-"));
    const store = new FileProjectMemoryStore({ rootDir: root });
    await store.writeEntrypoint(scope, "- [Deploy](topics/deploy.md) — release");
    const topic = await store.writeTopic(scope, { id: "deploy", title: "Deploy", description: "release", type: "project", content: "Use the staging gate.", references: [{ kind: "path", value: "deploy.ts" }] });
    expect(topic.references?.[0]?.value).toBe("deploy.ts");
    expect((await store.getEntrypoint(scope))?.content).toContain("Deploy");
    expect((await store.listTopics(scope)).map((item) => item.id)).toEqual(["deploy"]);
  });

  it("fails closed for traversal, symlink and malformed files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "project-memory-"));
    try {
      const store = new FileProjectMemoryStore({ rootDir: root });
      await expect(store.readTopic({ ...scope, scopeKey: "../escape" }, "x")).rejects.toThrow("PROJECT_MEMORY_SCOPE_INVALID");
      await store.writeTopic(scope, { id: "safe", title: "Safe", content: "ok" });
      const topicDir = path.join(root, scope.scopeKey, "topics");
      const outside = path.join(root, "outside.md");
      await writeFile(outside, "secret", "utf8");
      try { await symlink(outside, path.join(topicDir, "link.md")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
      await expect(store.readTopic(scope, "link")).rejects.toThrow("PROJECT_MEMORY_SYMLINK_DENIED");
      await writeFile(path.join(topicDir, "bad.md"), "---\nversion: 999\nname: bad\n---\ntext\n", "utf8");
      expect((await store.listTopics(scope)).map((item) => item.id)).toEqual(["safe"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("serializes concurrent writes and enforces entrypoint bound", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "project-memory-"));
    const store = new FileProjectMemoryStore({ rootDir: root, maxEntrypointBytes: 32 });
    await expect(store.writeEntrypoint(scope, "x".repeat(40))).rejects.toThrow("PROJECT_MEMORY_ENTRYPOINT_TOO_LARGE");
    await Promise.all([
      store.writeTopic(scope, { id: "same", title: "One", content: "one" }),
      store.writeTopic(scope, { id: "same", title: "Two", content: "two" }),
    ]);
    expect((await store.readTopic(scope, "same"))?.content).toMatch(/one|two/);
  });

  it("preserves references for stale validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "project-memory-"));
    try {
      const store = new FileProjectMemoryStore({ rootDir: root });
      const topic = await store.writeTopic(scope, { id: "ref", title: "Ref", content: "check", references: [{ kind: "path", value: "missing.ts" }] });
      const validation = await validateProjectMemoryTopic(topic, { pathExists: async (value) => value !== "missing.ts" }, scope);
      expect(validation.status).toBe("stale");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps tenant/workspace scopes in separate directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "project-memory-"));
    try {
      const store = new FileProjectMemoryStore({ rootDir: root });
      const other = { ...scope, tenantId: "tenant-b", scopeKey: "pm_scope_b" };
      await store.writeTopic(scope, { id: "same", title: "A", content: "tenant a" });
      await store.writeTopic(other, { id: "same", title: "B", content: "tenant b" });
      expect((await store.readTopic(scope, "same"))?.content).toBe("tenant a");
      expect((await store.readTopic(other, "same"))?.content).toBe("tenant b");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
