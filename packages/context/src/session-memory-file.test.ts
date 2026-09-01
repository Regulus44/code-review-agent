import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileSessionMemoryStore, createDefaultSessionMemoryExtractor } from "./session-memory-file.js";

describe("FileSessionMemoryStore", () => {
  it("round-trips bounded Markdown with an integrity receipt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "coding-agent-memory-"));
    try {
      const store = new FileSessionMemoryStore({ rootDir: root, maxMemoryChars: 200, maxMemoryBytes: 2_000 });
      await store.save("ses_roundtrip", { content: "# Goal\nKeep the review plan", lastSummarizedMessageId: "m2", updatedAt: "2026-09-01T00:00:00.000Z" });
      expect(await store.get("ses_roundtrip")).toMatchObject({ content: "# Goal\nKeep the review plan", lastSummarizedMessageId: "m2", updatedAt: "2026-09-01T00:00:00.000Z", etag: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      const raw = await readFile(path.join(root, "ses_roundtrip.md"), "utf8");
      expect(raw).toContain("version: 1");
      expect(raw).toContain("etag:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal, oversized content, and malformed files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "coding-agent-memory-"));
    try {
      const store = new FileSessionMemoryStore({ rootDir: root, maxMemoryChars: 20, maxMemoryBytes: 200 });
      await expect(store.get("../escape")).rejects.toThrow("SESSION_MEMORY_SESSION_ID_INVALID");
      await expect(store.save("ses_too_large", { content: "x".repeat(21) })).rejects.toThrow("SESSION_MEMORY_CONTENT_TOO_LARGE");
      await writeFile(path.join(root, "ses_bad.md"), "not frontmatter", "utf8");
      await expect(store.get("ses_bad")).rejects.toThrow("SESSION_MEMORY_CORRUPT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses atomic idempotent writes and serializes concurrent saves", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "coding-agent-memory-"));
    try {
      const store = new FileSessionMemoryStore({ rootDir: root });
      const snapshot = { content: "same", lastSummarizedMessageId: "m1", updatedAt: "2026-09-01T00:00:00.000Z" };
      await Promise.all([store.save("ses_same", snapshot), store.save("ses_same", snapshot)]);
      const names = await readdir(root);
      expect(names.filter((name) => name.includes(".tmp-")).length).toBe(0);
      expect((await store.get("ses_same"))?.content).toBe("same");
      await store.save("ses_same", { ...snapshot, content: "new" });
      expect((await store.get("ses_same"))?.content).toBe("new");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on a symlink target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "coding-agent-memory-"));
    const outside = await mkdtemp(path.join(tmpdir(), "coding-agent-memory-outside-"));
    try {
      await writeFile(path.join(outside, "memory.md"), "secret", "utf8");
      try {
        await symlink(path.join(outside, "memory.md"), path.join(root, "ses_link.md"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
      const store = new FileSessionMemoryStore({ rootDir: root });
      await expect(store.get("ses_link")).rejects.toThrow("SESSION_MEMORY_SYMLINK_DENIED");
      await expect(store.save("ses_link", { content: "overwrite" })).rejects.toThrow("SESSION_MEMORY_SYMLINK_DENIED");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("fails closed when the configured root is a symlink", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "coding-agent-memory-root-"));
    const actual = path.join(parent, "actual");
    const linked = path.join(parent, "linked");
    try {
      await mkdir(actual);
      try {
        await symlink(actual, linked, "junction");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
      const store = new FileSessionMemoryStore({ rootDir: linked });
      await expect(store.get("ses_root_link")).rejects.toThrow("SESSION_MEMORY_ROOT_SYMLINK_DENIED");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("default session memory extractor", () => {
  it("emits bounded model-free context and honors cancellation", async () => {
    const extractor = createDefaultSessionMemoryExtractor({ maxChars: 120 });
    const result = await extractor.extract({
      sessionId: "ses_default",
      sourceSequence: 1,
      messages: [{ role: "user", content: "Remember this goal", messageId: "m1" }, { role: "assistant", content: "Done", messageId: "m2" }],
      trigger: "initialization",
      estimatedTokens: 10,
      toolCallsSinceLastExtraction: 0,
      signal: new AbortController().signal,
      capabilities: { canReadSessionMemory: true, canWriteSessionMemory: true, canUseParentTools: false, canWriteWorkspace: false, canExecute: false },
    });
    expect(result.snapshot?.content).toContain("Remember this goal");
    expect(result.lastSummarizedMessageId).toBe("m2");
    const controller = new AbortController();
    controller.abort(new Error("cancel"));
    await expect(extractor.extract({ sessionId: "ses_default", sourceSequence: 1, messages: [], trigger: "threshold", estimatedTokens: 1, toolCallsSinceLastExtraction: 0, signal: controller.signal, capabilities: { canReadSessionMemory: true, canWriteSessionMemory: true, canUseParentTools: false, canWriteWorkspace: false, canExecute: false } })).rejects.toThrow("cancel");
  });
});
