import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { brand, type AgentEvent, type EventStore, type SessionId, type SessionProjection, type ToolDefinition } from "@code-review-agent/contracts";
import { createBuiltinTools, TerminalManager } from "./builtin.js";
import { P0_TOOL_FIXTURES } from "./behavior-fixtures.js";
import { ToolDisabledError, ToolNotFoundError, ToolRegistry } from "./registry.js";
import { ToolRuntime } from "./runtime.js";
import { DefaultPermissionPolicy } from "./permissions.js";
import { assertValidInput, SchemaValidationError } from "./schema.js";

class MemoryStore implements EventStore {
  readonly events: AgentEvent[] = [];
  async append(input: Parameters<EventStore["append"]>[0]): Promise<AgentEvent> {
    const event: AgentEvent = { eventId: `evt_${this.events.length + 1}`, sequence: this.events.length + 1, schemaVersion: 1, sessionId: input.sessionId, ...(input.turnId === undefined ? {} : { turnId: input.turnId }), ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }), type: input.type, createdAt: new Date().toISOString(), payload: input.payload };
    this.events.push(event);
    return event;
  }
  async list(sessionId: SessionId, afterSequence = 0): Promise<readonly AgentEvent[]> { return this.events.filter((event) => event.sessionId === sessionId && event.sequence > afterSequence); }
  async project(): Promise<SessionProjection | undefined> { return undefined; }
  subscribe(): () => void { return () => undefined; }
}

describe("ToolRuntime", () => {
  it("validates schemas and rejects extra fields", () => {
    expect(() => assertValidInput({ type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, { path: "a", extra: true })).toThrow(SchemaValidationError);
  });

  it("fails closed when a shell is absent from the selected platform roster", () => {
    const windows = new ToolRegistry();
    windows.registerMany(createBuiltinTools({ platform: "win32" }));
    expect(windows.list().some((tool) => tool.name === "pwsh")).toBe(true);
    expect(windows.list().some((tool) => tool.name === "bash")).toBe(false);
    let error: unknown;
    try {
      windows.get("bash");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ToolNotFoundError);
    expect((error as ToolNotFoundError).code).toBe("TOOL_NOT_FOUND");

    const posix = new ToolRegistry();
    posix.registerMany(createBuiltinTools({ platform: "linux" }));
    expect(posix.list().some((tool) => tool.name === "bash")).toBe(true);
    expect(posix.list().some((tool) => tool.name === "pwsh")).toBe(false);
  });

  it("keeps the P0 behavior fixture matrix aligned with the TypeScript registry", () => {
    const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools());
    expect(P0_TOOL_FIXTURES).toHaveLength(9);
    for (const fixture of P0_TOOL_FIXTURES) {
      const definition = registry.get(fixture.name);
      expect(definition).toMatchObject({ name: fixture.name, riskLevel: fixture.riskLevel, executionMode: fixture.executionMode, approvalMode: fixture.approvalMode });
      expect(fixture.expectedOutput.length).toBeGreaterThan(0);
      expect(fixture.safety.length).toBeGreaterThan(0);
    }
  });

  it("executes read tools and emits progress/result events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-tools-"));
    try {
      await writeFile(path.join(root, "hello.txt"), "hello", "utf8");
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools());
      const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_test");
      const result = await runtime.execute({ sessionId, workspaceRoot: root, name: "read_file", input: { path: "hello.txt" } });
      expect(result.status).toBe("completed"); expect(result.result?.output).toMatchObject({ path: "hello.txt", lines: [{ number: 1, text: "hello" }], truncated: false });
      expect(store.events.map((event) => event.type)).toEqual(["tool/call", "tool/progress", "tool/result"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("returns line-numbered read ranges with continuation metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-read-contract-"));
    try {
      await writeFile(path.join(root, "sample.txt"), "zero\none\ntwo\nthree", "utf8");
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools());
      const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_read_contract");
      const result = await runtime.execute({ sessionId, workspaceRoot: root, name: "read_file", input: { path: "sample.txt", offset: 2, limit: 1 } });
      expect(result.result?.output).toMatchObject({ offset: 2, totalLines: 4, truncated: true, nextOffset: 3, lines: [{ number: 2, text: "one" }] });
      expect(String(result.result?.modelView)).toContain("Use offset=3 to continue");
      expect(store.events.find((event) => event.type === "tool/call")?.payload.presentation).toMatchObject({ kind: "tool", title: "read_file" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps glob and grep results bounded, deterministic, and contextual", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-search-contract-"));
    try {
      await mkdir(path.join(root, "nested"), { recursive: true });
      await writeFile(path.join(root, "root.ts"), "before\nNeedle\nafter", "utf8");
      await writeFile(path.join(root, "nested", "child.ts"), "child", "utf8");
      await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools());
      const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_search_contract");
      const glob = await runtime.execute({ sessionId, workspaceRoot: root, name: "glob", input: { pattern: "**/*.ts", maxResults: 10 } });
      expect(glob.result?.output).toMatchObject({ paths: ["nested/child.ts", "root.ts"], truncated: false });
      const grep = await runtime.execute({ sessionId, workspaceRoot: root, name: "grep", input: { pattern: "needle", path: ".", literal: true, ignoreCase: true, contextLines: 1, maxResults: 10 } });
      expect(grep.result?.output).toMatchObject({ truncated: false, skippedBinaryFiles: 1, matches: [{ path: "root.ts", lineNumber: 2, line: "Needle", before: ["before"], after: ["after"] }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("asks for write permission and resumes exactly once", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-tools-"));
    try {
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_test");
      const pending = await runtime.execute({ sessionId, workspaceRoot: root, name: "write_file", input: { path: "out.txt", content: "done" }, commandId: "cmd_write" });
      expect(pending.status).toBe("awaiting_permission"); expect(pending.permission).toBeDefined();
      const resolved = await runtime.resolvePermission(pending.permission!.id, "approved");
      expect(resolved.status).toBe("completed"); expect(await readFile(path.join(root, "out.txt"), "utf8")).toBe("done");
      expect(await runtime.resolvePermission(pending.permission!.id, "approved")).toEqual(resolved);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects path traversal before reading", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-tools-"));
    try {
      const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store: new MemoryStore(), registry });
      await expect(runtime.execute({ sessionId: brand<string, "SessionId">("ses_test"), workspaceRoot: root, name: "read_file", input: { path: "../secret.txt" } })).resolves.toMatchObject({ status: "failed", result: { ok: false } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("enforces timeout, cancellation, output budget, and command allowlist", async () => {
    const sessionId = brand<string, "SessionId">("ses_test");
    const slow: ToolDefinition = { name: "slow", description: "slow", inputSchema: { type: "object" }, executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel", execute: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 100)); return { ok: true }; } };
    const huge: ToolDefinition = { name: "huge", description: "huge", inputSchema: { type: "object" }, executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel", execute: async () => ({ ok: true, output: "x".repeat(100) }) };
    const registry = new ToolRegistry(); registry.register(slow); registry.register(huge); registry.registerMany(createBuiltinTools());
    const timeout = await new ToolRuntime({ store: new MemoryStore(), registry, defaultTimeoutMs: 10 }).execute({ sessionId, workspaceRoot: ".", name: "slow", input: {} });
    expect(timeout.status).toBe("failed"); expect(timeout.result?.error?.code).toBe("TOOL_TIMEOUT");
    const bounded = await new ToolRuntime({ store: new MemoryStore(), registry, outputBudgetBytes: 16 }).execute({ sessionId, workspaceRoot: ".", name: "huge", input: {} });
    expect(bounded.result?.usage?.truncated).toBe(true); expect(bounded.result?.output).toBe("x".repeat(100)); expect(bounded.result?.audit).toBe("x".repeat(100)); expect(String(bounded.result?.modelView)).toContain("…");
    const commandRuntime = new ToolRuntime({ store: new MemoryStore(), registry }); const command = await commandRuntime.execute({ sessionId, workspaceRoot: ".", name: "run_command", input: { executable: "node;echo", args: [] } });
    expect(command.status).toBe("awaiting_permission");
    const denied = await commandRuntime.resolvePermission(command.permission!.id, "approved"); expect(denied.status).toBe("failed"); expect(denied.result?.error?.code).toBe("COMMAND_NOT_ALLOWED");
    const cancellable: ToolDefinition = { name: "cancellable", description: "cancellable", inputSchema: { type: "object" }, executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel", execute: async (_input, context) => await new Promise((resolve, reject) => { context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }); }) };
    registry.register(cancellable); const controller = new AbortController(); const running = new ToolRuntime({ store: new MemoryStore(), registry }).execute({ sessionId, workspaceRoot: ".", name: "cancellable", input: {}, signal: controller.signal }); controller.abort(new Error("user cancel"));
    expect((await running).status).toBe("cancelled");
  });

  it("allows the Django test runner command in a full-access session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-django-tests-"));
    try {
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools());
      const runtime = new ToolRuntime({ store, registry, policy: new DefaultPermissionPolicy({ preset: "workspace-full-access" }) });
      const sessionId = brand<string, "SessionId">("ses_django_allowlist");
      const result = await runtime.execute({
        sessionId,
        workspaceRoot: root,
        name: "run_tests",
        input: { command: "python", args: ["-c", "print('django-test-command-allowed')"] },
      });
      expect(result.status).toBe("completed");
      expect(result.result?.output).toBe("django-test-command-allowed\r\n");
      expect(result.result?.audit).toMatchObject({ stdout: "django-test-command-allowed\r\n", exitCode: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("restores pending approvals from durable events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-tools-"));
    try {
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const sessionId = brand<string, "SessionId">("ses_test");
      const first = new ToolRuntime({ store, registry }); const pending = await first.execute({ sessionId, workspaceRoot: root, name: "write_file", input: { path: "recovered.txt", content: "recovered" } });
      const restored = new ToolRuntime({ store, registry }); await restored.restorePending(sessionId, root, store.events); const result = await restored.resolvePermission(pending.permission!.id, "approved");
      expect(result.status).toBe("completed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("denies a restored approval when its tool has been disabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-tools-"));
    try {
      const store = new MemoryStore(); const sourceRegistry = new ToolRegistry(); sourceRegistry.registerMany(createBuiltinTools()); const sessionId = brand<string, "SessionId">("ses_disabled_restore"); await new ToolRuntime({ store, registry: sourceRegistry }).execute({ sessionId, workspaceRoot: root, name: "write_file", input: { path: "disabled.txt", content: "no" } });
      const restoredRegistry = new ToolRegistry(); restoredRegistry.registerMany(createBuiltinTools()); restoredRegistry.disable("write_file"); const restored = new ToolRuntime({ store, registry: restoredRegistry }); await restored.restorePending(sessionId, root, store.events);
      expect(restored.pendingPermissions()).toHaveLength(0); expect(store.events.at(-2)?.payload.status).toBe("denied"); expect((store.events.at(-1)?.payload.result as { error?: { code?: string } }).error?.code).toBe("TOOL_DISABLED");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("can disable tools without unregistering their definitions", () => {
    const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools());
    expect(registry.disable("read_file")).toBe(true); expect(registry.has("read_file")).toBe(true); expect(registry.isEnabled("read_file")).toBe(false); expect(registry.list().some((tool) => tool.name === "read_file")).toBe(false);
    expect(() => registry.get("read_file")).toThrow(ToolDisabledError); expect(registry.enable("read_file")).toBe(true); expect(registry.get("read_file").name).toBe("read_file");
  });

  it("refuses implicit overwrite and returns a diff for explicit overwrite", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-tools-"));
    try {
      await writeFile(path.join(root, "existing.txt"), "before", "utf8"); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store: new MemoryStore(), registry }); const sessionId = brand<string, "SessionId">("ses_test");
      const refused = await runtime.execute({ sessionId, workspaceRoot: root, name: "write_file", input: { path: "existing.txt", content: "after" } }); const refusedResult = await runtime.resolvePermission(refused.permission!.id, "approved");
      expect(refusedResult.result?.error?.code).toBe("WRITE_TARGET_EXISTS"); expect(await readFile(path.join(root, "existing.txt"), "utf8")).toBe("before");
      const explicit = await runtime.execute({ sessionId, workspaceRoot: root, name: "write_file", input: { path: "existing.txt", content: "after", overwrite: true } }); const explicitResult = await runtime.resolvePermission(explicit.permission!.id, "approved");
      expect(explicitResult.status).toBe("completed"); expect(explicitResult.result?.diff).toMatchObject({ before: "before", after: "after" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("requires a prior read and refreshes the observed version after a successful edit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-edit-observation-"));
    try {
      await writeFile(path.join(root, "observed.txt"), "before", "utf8");
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_edit_observation");
      const unread = await runtime.execute({ sessionId, workspaceRoot: root, name: "edit_file", input: { path: "observed.txt", oldText: "before", newText: "after" } });
      const unreadResult = await runtime.resolvePermission(unread.permission!.id, "approved");
      expect(unreadResult.result?.error).toMatchObject({ code: "EDIT_NOT_OBSERVED" });
      expect(await readFile(path.join(root, "observed.txt"), "utf8")).toBe("before");

      const read = await runtime.execute({ sessionId, workspaceRoot: root, name: "read_file", input: { path: "observed.txt", offset: 1, limit: 1 } });
      expect(read.result?.ok).toBe(true);
      const firstEdit = await runtime.execute({ sessionId, workspaceRoot: root, name: "edit_file", input: { path: "observed.txt", oldText: "before", newText: "after" } });
      const firstEditResult = await runtime.resolvePermission(firstEdit.permission!.id, "approved");
      expect(firstEditResult.status).toBe("completed");

      const secondEdit = await runtime.execute({ sessionId, workspaceRoot: root, name: "edit_file", input: { path: "observed.txt", oldText: "after", newText: "final" } });
      const secondEditResult = await runtime.resolvePermission(secondEdit.permission!.id, "approved");
      expect(secondEditResult.status).toBe("completed");
      expect(await readFile(path.join(root, "observed.txt"), "utf8")).toBe("final");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects an edit against an externally changed observed file until it is reread", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-edit-observation-stale-"));
    try {
      await writeFile(path.join(root, "stale.txt"), "before", "utf8");
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_edit_observation_stale");
      await runtime.execute({ sessionId, workspaceRoot: root, name: "read_file", input: { path: "stale.txt" } });
      await writeFile(path.join(root, "stale.txt"), "changed", "utf8");
      const currentHash = createHash("sha256").update("changed", "utf8").digest("hex");
      const stale = await runtime.execute({ sessionId, workspaceRoot: root, name: "edit_file", input: { path: "stale.txt", expectedHash: currentHash, oldText: "changed", newText: "edited" } });
      const staleResult = await runtime.resolvePermission(stale.permission!.id, "approved");
      expect(staleResult.result?.error).toMatchObject({ code: "EDIT_STALE" });
      expect(await readFile(path.join(root, "stale.txt"), "utf8")).toBe("changed");

      await runtime.execute({ sessionId, workspaceRoot: root, name: "read_file", input: { path: "stale.txt" } });
      const retried = await runtime.execute({ sessionId, workspaceRoot: root, name: "edit_file", input: { path: "stale.txt", oldText: "changed", newText: "edited" } });
      const retriedResult = await runtime.resolvePermission(retried.permission!.id, "approved");
      expect(retriedResult.status).toBe("completed");
      expect(await readFile(path.join(root, "stale.txt"), "utf8")).toBe("edited");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("applies structured edits only against the expected current version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-edit-contract-"));
    try {
      const before = "alpha\nbeta\ngamma";
      await writeFile(path.join(root, "multi.txt"), before, "utf8");
      const expectedHash = createHash("sha256").update(before, "utf8").digest("hex");
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_edit_contract");
      await runtime.execute({ sessionId, workspaceRoot: root, name: "read_file", input: { path: "multi.txt" } });
      const pending = await runtime.execute({ sessionId, workspaceRoot: root, name: "edit_file", input: { path: "multi.txt", expectedHash, edits: [{ oldText: "alpha", newText: "ALPHA" }, { oldText: "gamma", newText: "GAMMA" }] } });
      const result = await runtime.resolvePermission(pending.permission!.id, "approved");
      expect(result.status).toBe("completed");
      expect(result.result?.output).toMatchObject({ changed: true, operations: [{ status: "applied" }, { status: "applied" }] });
      expect(String(result.result?.output && (result.result.output as { unifiedDiff?: string }).unifiedDiff)).toContain("-alpha");
      expect(await readFile(path.join(root, "multi.txt"), "utf8")).toBe("ALPHA\nbeta\nGAMMA");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("stops instead of overwriting a file changed after approval was requested", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-edit-conflict-"));
    try {
      const before = "before";
      await writeFile(path.join(root, "conflict.txt"), before, "utf8");
      const expectedHash = createHash("sha256").update(before, "utf8").digest("hex");
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_edit_conflict");
      await runtime.execute({ sessionId, workspaceRoot: root, name: "read_file", input: { path: "conflict.txt" } });
      const pending = await runtime.execute({ sessionId, workspaceRoot: root, name: "edit_file", input: { path: "conflict.txt", expectedHash, oldText: "before", newText: "after" } });
      await writeFile(path.join(root, "conflict.txt"), "user change", "utf8");
      const result = await runtime.resolvePermission(pending.permission!.id, "approved");
      expect(result.result?.error?.code).toBe("EDIT_STALE");
      expect(await readFile(path.join(root, "conflict.txt"), "utf8")).toBe("user change");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("returns structured context when an edit target is not found", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-edit-not-found-"));
    try {
      const before = "alpha\nbeta\ngamma";
      await writeFile(path.join(root, "missing.txt"), before, "utf8");
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_edit_not_found");
      await runtime.execute({ sessionId, workspaceRoot: root, name: "read_file", input: { path: "missing.txt" } });
      const pending = await runtime.execute({ sessionId, workspaceRoot: root, name: "edit_file", input: { path: "missing.txt", oldText: "delta", newText: "DELTA" } });
      const result = await runtime.resolvePermission(pending.permission!.id, "approved");
      const toolResult = result.result!;
      expect(result.status).toBe("failed");
      expect(toolResult.error).toMatchObject({ code: "TEXT_NOT_FOUND", remedy: expect.stringContaining("Reread the current file") });
      expect(toolResult.presentation?.data).toMatchObject({ path: "missing.txt", matchCount: 0, matchLines: [], currentHash: createHash("sha256").update(before, "utf8").digest("hex"), totalLines: 3 });
      expect(String(toolResult.presentation?.data && (toolResult.presentation.data as { context?: string }).context)).toContain("1: alpha");
      expect(await readFile(path.join(root, "missing.txt"), "utf8")).toBe(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reports all match line numbers without changing an ambiguous edit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-edit-ambiguous-"));
    try {
      const before = "same\nmiddle\nsame";
      await writeFile(path.join(root, "ambiguous.txt"), before, "utf8");
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_edit_ambiguous");
      await runtime.execute({ sessionId, workspaceRoot: root, name: "read_file", input: { path: "ambiguous.txt" } });
      const pending = await runtime.execute({ sessionId, workspaceRoot: root, name: "edit_file", input: { path: "ambiguous.txt", oldText: "same", newText: "changed" } });
      const result = await runtime.resolvePermission(pending.permission!.id, "approved");
      expect(result.status).toBe("failed");
      expect(result.result?.error).toMatchObject({ code: "TEXT_NOT_UNIQUE", remedy: expect.stringContaining("Reread the current file") });
      expect(result.result?.presentation?.data).toMatchObject({ path: "ambiguous.txt", matchCount: 2, matchLines: [1, 3], totalLines: 3 });
      expect(await readFile(path.join(root, "ambiguous.txt"), "utf8")).toBe(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("matches LF edit text against CRLF files while preserving the file line endings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-edit-crlf-"));
    try {
      const before = "before\r\nmiddle\r\n";
      await writeFile(path.join(root, "crlf.txt"), before, "utf8");
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_edit_crlf");
      await runtime.execute({ sessionId, workspaceRoot: root, name: "read_file", input: { path: "crlf.txt" } });
      const pending = await runtime.execute({ sessionId, workspaceRoot: root, name: "edit_file", input: { path: "crlf.txt", oldText: "before\nmiddle", newText: "after\nmiddle" } });
      const result = await runtime.resolvePermission(pending.permission!.id, "approved");
      expect(result.status).toBe("completed");
      expect(await readFile(path.join(root, "crlf.txt"), "utf8")).toBe("after\r\nmiddle\r\n");
      expect(result.result?.output).toMatchObject({ changed: true, operations: [{ status: "applied", matchCount: 1 }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("supports explicit append mode without weakening create protection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-write-modes-"));
    try {
      await writeFile(path.join(root, "append.txt"), "before", "utf8");
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_write_modes");
      const pending = await runtime.execute({ sessionId, workspaceRoot: root, name: "write_file", input: { path: "append.txt", content: " after", mode: "append" } });
      const result = await runtime.resolvePermission(pending.permission!.id, "approved");
      expect(result.status).toBe("completed"); expect((result.result?.output as { mode?: string }).mode).toBe("append"); expect(await readFile(path.join(root, "append.txt"), "utf8")).toBe("before after");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("records cancellation for a pending permission", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-tools-"));
    try {
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry }); const pending = await runtime.execute({ sessionId: brand<string, "SessionId">("ses_test"), workspaceRoot: root, name: "write_file", input: { path: "cancelled.txt", content: "no" } });
      expect(await runtime.cancel(pending.toolCallId)).toBe(true); expect(store.events.slice(-2).map((event) => event.type)).toEqual(["permission/resolved", "tool/result"]); expect(store.events.at(-2)?.payload.status).toBe("cancelled");
      expect((await runtime.resolvePermission(pending.permission!.id, "approved")).status).toBe("cancelled");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("records a denied permission without executing the side effect", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-tools-"));
    try {
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry }); const pending = await runtime.execute({ sessionId: brand<string, "SessionId">("ses_denied"), workspaceRoot: root, name: "write_file", input: { path: "denied.txt", content: "no" } });
      const denied = await runtime.resolvePermission(pending.permission!.id, "denied"); expect(denied.status).toBe("denied"); expect(denied.result?.error?.code).toBe("PERMISSION_DENIED"); await expect(readFile(path.join(root, "denied.txt"), "utf8")).rejects.toThrow(); expect(await runtime.resolvePermission(pending.permission!.id, "denied")).toEqual(denied);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("expires stale approvals and makes repeated resolution idempotent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-tools-"));
    try {
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry, permissionTtlMs: 1 }); const pending = await runtime.execute({ sessionId: brand<string, "SessionId">("ses_test"), workspaceRoot: root, name: "write_file", input: { path: "expired.txt", content: "no" } }); await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(store.events.find((event) => event.type === "permission/resolved")?.payload.status).toBe("expired"); const expired = await runtime.resolvePermission(pending.permission!.id, "approved"); expect(expired.status).toBe("denied"); expect(expired.result?.error?.code).toBe("PERMISSION_EXPIRED"); expect(await runtime.resolvePermission(pending.permission!.id, "approved")).toEqual(expired);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("terminates an approved process when its signal is cancelled", async () => {
    const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store: new MemoryStore(), registry, defaultTimeoutMs: 5_000 }); const controller = new AbortController(); const pending = await runtime.execute({ sessionId: brand<string, "SessionId">("ses_test"), workspaceRoot: ".", name: "run_command", input: { executable: "node", args: ["-e", "setInterval(() => {}, 1000)"] }, signal: controller.signal });
    const running = runtime.resolvePermission(pending.permission!.id, "approved"); setTimeout(() => controller.abort(new Error("cancel test")), 50); const result = await running; expect(result.status).toBe("cancelled"); expect(result.result?.error?.code).toBe("TOOL_CANCELLED");
  });

  it("keeps complete stdout, stderr, and exit metadata in the audit result", async () => {
    const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store: new MemoryStore(), registry }); const pending = await runtime.execute({ sessionId: brand<string, "SessionId">("ses_test"), workspaceRoot: ".", name: "run_command", input: { executable: "node", args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"] } });
    const result = await runtime.resolvePermission(pending.permission!.id, "approved"); expect(result.status).toBe("completed"); expect(result.result?.audit).toMatchObject({ stdout: "out", stderr: "err", exitCode: 0 });
  });

  it("returns structured git status while retaining raw command audit", async () => {
    const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const result = await new ToolRuntime({ store: new MemoryStore(), registry }).execute({ sessionId: brand<string, "SessionId">("ses_git"), workspaceRoot: process.cwd(), name: "git_status", input: {} });
    expect(result.status).toBe("completed"); expect(result.result?.output).toMatchObject({ branch: expect.any(Object), entries: expect.any(Array) }); expect(result.result?.audit).toMatchObject({ exitCode: 0, stdout: expect.any(String) });
  });

  it("serializes exclusive tools, permits parallel tools, and cancels failed siblings", async () => {
    const registry = new ToolRegistry(); let exclusiveActive = 0; let exclusiveMax = 0; let parallelActive = 0; let parallelMax = 0;
    const timedTool = (name: string, executionMode: "parallel" | "exclusive", enter: () => void, leave: () => void): ToolDefinition => ({ name, description: name, inputSchema: { type: "object" }, executionMode, riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel", execute: async () => { enter(); await new Promise<void>((resolve) => setTimeout(resolve, 30)); leave(); return { ok: true }; } });
    registry.register(timedTool("exclusive_test", "exclusive", () => { exclusiveActive += 1; exclusiveMax = Math.max(exclusiveMax, exclusiveActive); }, () => { exclusiveActive -= 1; }));
    registry.register(timedTool("parallel_test", "parallel", () => { parallelActive += 1; parallelMax = Math.max(parallelMax, parallelActive); }, () => { parallelActive -= 1; }));
    registry.register({ name: "fail_test", description: "fail", inputSchema: { type: "object" }, executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel", execute: async () => ({ ok: false, error: { code: "EXPECTED_FAILURE", message: "fail" } }) });
    registry.register({ name: "wait_test", description: "wait", inputSchema: { type: "object" }, executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel", execute: async (_input, context) => await new Promise((resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true })) });
    const runtime = new ToolRuntime({ store: new MemoryStore(), registry }); const sessionId = brand<string, "SessionId">("ses_scheduler"); const base = { sessionId, workspaceRoot: ".", input: {} };
    await Promise.all([runtime.execute({ ...base, name: "exclusive_test" }), runtime.execute({ ...base, name: "exclusive_test" })]); expect(exclusiveMax).toBe(1);
    await Promise.all([runtime.execute({ ...base, name: "parallel_test" }), runtime.execute({ ...base, name: "parallel_test" })]); expect(parallelMax).toBe(2);
    const batch = await runtime.executeMany([{ ...base, name: "wait_test" }, { ...base, name: "fail_test" }]); expect(batch.map((result) => result.status).sort()).toEqual(["cancelled", "failed"]);
  });

  it("registers the P1 coding-agent tool closure and records plan/todo events", async () => {
    const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools());
    const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_p1_state");
    const names = runtime.listTools().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["terminal_open", "terminal_send", "terminal_read", "terminal_signal", "terminal_close", "terminal_list", "delete_file", "git_log", "git_show", "ask_user", "plan", "todo_write"]));
    expect((await runtime.execute({ sessionId, workspaceRoot: process.cwd(), name: "plan", input: { content: "Inspect, edit, test", status: "active" } })).status).toBe("completed");
    expect((await runtime.execute({ sessionId, workspaceRoot: process.cwd(), name: "todo_write", input: { todos: [{ content: "Inspect", status: "completed" }, { content: "Test", status: "pending" }] } })).status).toBe("completed");
    expect(store.events.map((event) => event.type)).toContain("plan/updated"); expect(store.events.map((event) => event.type)).toContain("todo/updated");
  });

  it("applies permission presets to both model visibility and execution", async () => {
    const sessionId = brand<string, "SessionId">("ses_policy"); const root = process.cwd();
    const readOnlyRegistry = new ToolRegistry(); readOnlyRegistry.registerMany(createBuiltinTools()); const readOnly = new ToolRuntime({ store: new MemoryStore(), registry: readOnlyRegistry, policy: new DefaultPermissionPolicy({ preset: "read-only" }) });
    expect(readOnly.listTools().map((tool) => tool.name)).toContain("read_file"); expect(readOnly.listTools().map((tool) => tool.name)).not.toContain("edit_file");
    expect((await readOnly.execute({ sessionId, workspaceRoot: root, name: "edit_file", input: { path: "missing.txt", oldText: "a", newText: "b" } })).status).toBe("denied");
    const workspaceWriteRegistry = new ToolRegistry(); workspaceWriteRegistry.registerMany(createBuiltinTools()); const workspaceWrite = new ToolRuntime({ store: new MemoryStore(), registry: workspaceWriteRegistry, policy: new DefaultPermissionPolicy({ preset: "workspace-write" }) });
    const write = await workspaceWrite.execute({ sessionId, workspaceRoot: root, name: "write_file", input: { path: `.phase-policy-${Date.now()}.txt`, content: "ok" } }); expect(write.status).toBe("completed"); const written = (write.result?.output as { path?: string }).path; if (written !== undefined) await rm(path.join(root, written), { force: true });
    const execute = await workspaceWrite.execute({ sessionId, workspaceRoot: root, name: "run_command", input: { executable: "node", args: ["-e", "process.stdout.write('ok')"] } }); expect(execute.status).toBe("awaiting_permission");
  });

  it("keeps a terminal process alive across send/read calls and closes it", async () => {
    const root = process.cwd();
    try {
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_terminal");
      const opened = await runtime.execute({ sessionId, workspaceRoot: root, name: "terminal_open", input: { executable: "node", args: ["-e", "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write(d));"] } });
      expect(opened.status).toBe("awaiting_permission"); const approved = await runtime.resolvePermission(opened.permission!.id, "approved"); expect(approved.status).toBe("completed");
      const terminalId = (approved.result?.output as { terminalId?: string }).terminalId; expect(terminalId).toEqual(expect.any(String));
      const sent = await runtime.execute({ sessionId, workspaceRoot: root, name: "terminal_send", input: { terminalId, text: "persistent-output" } }); const sentResult = sent.status === "awaiting_permission" ? await runtime.resolvePermission(sent.permission!.id, "approved") : sent; expect(sentResult.status).toBe("completed");
      const read = await runtime.execute({ sessionId, workspaceRoot: root, name: "terminal_read", input: { terminalId, waitMs: 500 } }); expect(read.status).toBe("completed"); expect((read.result?.output as { output?: string }).output).toContain("persistent-output");
      const close = await runtime.execute({ sessionId, workspaceRoot: root, name: "terminal_close", input: { terminalId } }); expect(close.status).toBe("awaiting_permission"); expect((await runtime.resolvePermission(close.permission!.id, "approved")).status).toBe("completed");
    } finally { /* terminal cleanup is asserted by terminal_close; the repository cwd must not be removed */ }
  });

  it("replays a running terminal as interrupted without fabricating a child process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-terminal-replay-"));
    try {
      const store = new MemoryStore(); const sessionId = brand<string, "SessionId">("ses_terminal_replay");
      await store.append({ sessionId, type: "terminal/session", payload: { terminalId: "terminal_old", workspaceRoot: root, cwd: root, command: "node -e long-running", status: "running", bufferedBytes: 12 } });
      const manager = new TerminalManager(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools({ terminalManager: manager }));
      const runtime = new ToolRuntime({ store, registry, terminalManager: manager }); await runtime.restorePending(sessionId, root, store.events);
      const listed = await runtime.execute({ sessionId, workspaceRoot: root, name: "terminal_list", input: {} });
      expect(listed.result?.output).toMatchObject([{ terminalId: "terminal_old", status: "interrupted", command: "node -e long-running" }]);
      const interruptedEvent = [...store.events].reverse().find((event) => event.type === "terminal/session");
      expect(interruptedEvent?.payload).toMatchObject({ action: "interrupted", status: "interrupted" });
      const send = await runtime.execute({ sessionId, workspaceRoot: root, name: "terminal_send", input: { terminalId: "terminal_old", text: "cannot resume" } });
      expect(send.status).toBe("awaiting_permission"); const sendResult = await runtime.resolvePermission(send.permission!.id, "approved");
      expect(sendResult.status).toBe("failed"); expect(sendResult.result?.error?.code).toBe("TERMINAL_INTERRUPTED");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("moves deleted paths to workspace trash and exposes bounded git history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-delete-"));
    try {
      await writeFile(path.join(root, "remove.txt"), "remove", "utf8"); const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_delete");
      const pending = await runtime.execute({ sessionId, workspaceRoot: root, name: "delete_file", input: { path: "remove.txt" } }); const deleted = await runtime.resolvePermission(pending.permission!.id, "approved"); expect(deleted.status).toBe("completed"); expect(deleted.result?.output).toMatchObject({ permanent: false, trashedTo: expect.stringContaining(".agent-trash") }); await expect(readFile(path.join(root, "remove.txt"), "utf8")).rejects.toThrow();
      const history = await new ToolRuntime({ store: new MemoryStore(), registry }).execute({ sessionId, workspaceRoot: process.cwd(), name: "git_log", input: { maxCount: 1 } }); expect(history.status).toBe("completed"); expect((history.result?.output as { commits?: unknown[] }).commits).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("pauses ask_user until an answer is resolved and then returns the answer", async () => {
    const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const runtime = new ToolRuntime({ store, registry, permissionTtlMs: 5_000 }); const sessionId = brand<string, "SessionId">("ses_interaction");
    const running = runtime.execute({ sessionId, workspaceRoot: process.cwd(), name: "ask_user", input: { question: "Continue?", options: [{ label: "Yes", value: "yes" }] } });
    let interactionId: string | undefined;
    for (let attempt = 0; attempt < 100 && interactionId === undefined; attempt += 1) { interactionId = store.events.find((event) => event.type === "interaction/requested")?.payload["interactionId"] as string | undefined; if (interactionId === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
    expect(interactionId).toEqual(expect.any(String)); const answer = await runtime.resolveInteraction(brand<string, "InteractionId">(interactionId!), "answered", "yes"); expect(answer).toMatchObject({ status: "answered", answer: "yes" }); expect((await running).result?.output).toMatchObject({ answer: "yes" }); expect(store.events.map((event) => event.type)).toEqual(expect.arrayContaining(["interaction/requested", "interaction/resolved"]));
  });

  it("restores a pending ask_user interaction after a runtime restart", async () => {
    const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const sessionId = brand<string, "SessionId">("ses_interaction_restore");
    const first = new ToolRuntime({ store, registry, permissionTtlMs: 5_000 });
    void first.execute({ sessionId, workspaceRoot: process.cwd(), name: "ask_user", input: { question: "Continue after restart?", options: [{ label: "Yes", value: "yes" }] } });
    let interactionId: string | undefined;
    for (let attempt = 0; attempt < 100 && interactionId === undefined; attempt += 1) { interactionId = store.events.find((event) => event.type === "interaction/requested")?.payload["interactionId"] as string | undefined; if (interactionId === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
    expect(interactionId).toEqual(expect.any(String));
    const restored = new ToolRuntime({ store, registry, permissionTtlMs: 5_000 });
    await restored.restorePending(sessionId, process.cwd(), store.events);
    expect(restored.pendingUserInteractions()).toHaveLength(1);
    const answer = await restored.resolveInteraction(brand<string, "InteractionId">(interactionId!), "answered", "yes");
    expect(answer).toMatchObject({ status: "answered", answer: "yes" });
    const toolCallId = store.events.find((event) => event.type === "tool/call")?.payload["toolCallId"];
    expect(store.events.at(-1)?.type).toBe("tool/result");
    expect(store.events.at(-1)?.payload).toMatchObject({ toolCallId: toolCallId, status: "completed" });
  });

  it("settles an already expired restored interaction without exposing an answer action", async () => {
    const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools()); const sessionId = brand<string, "SessionId">("ses_interaction_expired_restore");
    const now = new Date().toISOString(); const expired = new Date(Date.now() - 1).toISOString();
    await store.append({ sessionId, turnId: brand<string, "TurnId">("turn_expired_interaction"), type: "tool/call", payload: { toolCallId: "tool_expired_interaction", name: "ask_user", input: { question: "Too late" }, riskLevel: "read", approvalMode: "auto", caller: "agent", workspaceRoot: process.cwd() } });
    await store.append({ sessionId, turnId: brand<string, "TurnId">("turn_expired_interaction"), type: "interaction/requested", payload: { interactionId: "interaction_expired_restore", toolCallId: "tool_expired_interaction", question: "Too late", createdAt: now, expiresAt: expired } });
    const restored = new ToolRuntime({ store, registry }); await restored.restorePending(sessionId, process.cwd(), store.events);
    expect(restored.pendingUserInteractions()).toHaveLength(0);
    expect(store.events.at(-2)?.payload).toMatchObject({ interactionId: "interaction_expired_restore", status: "expired" });
    expect(store.events.at(-1)?.payload).toMatchObject({ toolCallId: "tool_expired_interaction", status: "cancelled" });
  });
});
