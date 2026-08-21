import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brand, type AgentEvent, type EventStore, type SessionId, type SessionProjection, type ToolDefinition } from "@code-review-agent/contracts";
import { createBuiltinTools } from "./builtin.js";
import { ToolDisabledError, ToolRegistry } from "./registry.js";
import { ToolRuntime } from "./runtime.js";
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

  it("executes read tools and emits progress/result events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-tools-"));
    try {
      await writeFile(path.join(root, "hello.txt"), "hello", "utf8");
      const store = new MemoryStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools());
      const runtime = new ToolRuntime({ store, registry }); const sessionId = brand<string, "SessionId">("ses_test");
      const result = await runtime.execute({ sessionId, workspaceRoot: root, name: "read_file", input: { path: "hello.txt" } });
      expect(result.status).toBe("completed"); expect(result.result?.output).toBe("hello");
      expect(store.events.map((event) => event.type)).toEqual(["tool/call", "tool/progress", "tool/result"]);
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
});
