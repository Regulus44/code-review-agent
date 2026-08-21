import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brand, type AgentEvent, type EventStore, type SessionId, type SessionProjection, type ToolDefinition } from "@code-review-agent/contracts";
import { createBuiltinTools } from "./builtin.js";
import { ToolRegistry } from "./registry.js";
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
      await expect(runtime.resolvePermission(pending.permission!.id, "approved")).rejects.toThrow();
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
    expect(bounded.result?.usage?.truncated).toBe(true);
    const command = await new ToolRuntime({ store: new MemoryStore(), registry }).execute({ sessionId, workspaceRoot: ".", name: "run_command", input: { executable: "node;echo", args: [] } });
    expect(command.status).toBe("awaiting_permission");
    const denied = await new ToolRuntime({ store: new MemoryStore(), registry }).execute({ sessionId, workspaceRoot: ".", name: "run_command", input: { executable: "node;echo", args: [] } });
    expect(denied.status).toBe("awaiting_permission");
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
});
