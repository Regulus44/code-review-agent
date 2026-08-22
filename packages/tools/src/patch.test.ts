import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { brand, type AgentEvent, type EventStore, type SessionId, type SessionProjection } from "@code-review-agent/contracts";
import { applyPreview, parseUnifiedPatch, previewUnifiedPatch } from "./patch.js";
import { createBuiltinTools } from "./builtin.js";
import { ToolRegistry } from "./registry.js";
import { ToolRuntime } from "./runtime.js";

class MemoryStore implements EventStore {
  readonly events: AgentEvent[] = [];
  async append(input: Parameters<EventStore["append"]>[0]): Promise<AgentEvent> {
    const event: AgentEvent = { eventId: `evt_${this.events.length + 1}`, sequence: this.events.length + 1, schemaVersion: 1, sessionId: input.sessionId, ...(input.turnId === undefined ? {} : { turnId: input.turnId }), type: input.type, createdAt: new Date().toISOString(), payload: input.payload };
    this.events.push(event);
    return event;
  }
  async list(sessionId: SessionId, afterSequence = 0): Promise<readonly AgentEvent[]> { return this.events.filter((event) => event.sessionId === sessionId && event.sequence > afterSequence); }
  async project(): Promise<SessionProjection | undefined> { return undefined; }
  subscribe(): () => void { return () => undefined; }
}

describe("unified patch contract", () => {
  it("parses and applies a multi-file patch with create, update, and delete semantics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-patch-"));
    try {
      await writeFile(path.join(root, "update.txt"), "one\ntwo\n", "utf8");
      await writeFile(path.join(root, "delete.txt"), "remove\n", "utf8");
      const patch = [
        "--- a/update.txt",
        "+++ b/update.txt",
        "@@ -1,2 +1,2 @@",
        " one",
        "-two",
        "+TWO",
        "--- a/delete.txt",
        "+++ /dev/null",
        "@@ -1,1 +0,0 @@",
        "-remove",
        "--- /dev/null",
        "+++ b/create.txt",
        "@@ -0,0 +1,2 @@",
        "+created",
        "+file",
        "",
      ].join("\n");
      expect(parseUnifiedPatch(patch)).toHaveLength(3);
      const preview = await previewUnifiedPatch(root, patch);
      expect(preview.files.map((file) => [file.path, file.operation])).toEqual([["update.txt", "update"], ["delete.txt", "delete"], ["create.txt", "create"]]);
      await applyPreview(root, preview);
      expect(await readFile(path.join(root, "update.txt"), "utf8")).toBe("one\nTWO\n");
      await expect(readFile(path.join(root, "delete.txt"), "utf8")).rejects.toThrow();
      expect(await readFile(path.join(root, "create.txt"), "utf8")).toBe("created\nfile");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects stale bases and hunk/context conflicts before writing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-patch-conflict-"));
    try {
      await writeFile(path.join(root, "target.txt"), "before\n", "utf8");
      const patch = "--- a/target.txt\n+++ b/target.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n";
      await expect(previewUnifiedPatch(root, patch, { "target.txt": "not-current" })).rejects.toMatchObject({ code: "PATCH_CONFLICT" });
      await writeFile(path.join(root, "target.txt"), "changed\n", "utf8");
      await expect(previewUnifiedPatch(root, patch)).rejects.toMatchObject({ code: "PATCH_CONFLICT" });
      expect(await readFile(path.join(root, "target.txt"), "utf8")).toBe("changed\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("routes preview, apply, reject, and rollback through approval and audit events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-patch-runtime-"));
    try {
      await writeFile(path.join(root, "target.txt"), "before\n", "utf8");
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools());
      const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_patch_runtime");
      const patch = "--- a/target.txt\n+++ b/target.txt\n@@ -1,1 +1,1 @@\n-before\n+after\n";
      const previewPending = await runtime.execute({ sessionId, workspaceRoot: root, name: "apply_patch", input: { patch, dryRun: true } });
      expect(previewPending.status).toBe("awaiting_permission");
      const preview = await runtime.resolvePermission(previewPending.permission!.id, "approved");
      const previewId = (preview.result?.output as { patchId: string }).patchId;
      expect(preview.result?.output).toMatchObject({ status: "preview", dryRun: true });
      const rejected = await runtime.execute({ sessionId, workspaceRoot: root, name: "reject_patch", input: { patchId: previewId, reason: "reviewer rejected" } });
      expect(rejected.status).toBe("completed");
      expect(await readFile(path.join(root, "target.txt"), "utf8")).toBe("before\n");

      const appliedPending = await runtime.execute({ sessionId, workspaceRoot: root, name: "apply_patch", input: { patch } });
      const applied = await runtime.resolvePermission(appliedPending.permission!.id, "approved");
      const appliedId = (applied.result?.output as { patchId: string }).patchId;
      expect(applied.status).toBe("completed"); expect(await readFile(path.join(root, "target.txt"), "utf8")).toBe("after\n");
      const rollbackPending = await runtime.execute({ sessionId, workspaceRoot: root, name: "rollback_patch", input: { patchId: appliedId } });
      const rolledBack = await runtime.resolvePermission(rollbackPending.permission!.id, "approved");
      expect(rolledBack.status).toBe("completed"); expect(await readFile(path.join(root, "target.txt"), "utf8")).toBe("before\n");
      expect(store.events.map((event) => event.type)).toEqual(expect.arrayContaining(["patch/preview", "patch/rejected", "patch/applied", "patch/rolled_back"]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
