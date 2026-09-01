import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { brand, type AttachmentReceipt, type ChatModel, type InteractionId, type ModelRequest, type ModelStreamPart, type PermissionId, type ToolDefinition } from "@coding-agent/contracts";
import { InMemoryEventStore, SqliteEventStore } from "@coding-agent/storage";
import { ContextRecoveryGuard } from "@coding-agent/context";
import { createBuiltinTools, DefaultPermissionPolicy, ToolRegistry, ToolRuntime } from "@coding-agent/tools";
import { GitWorktreeManager } from "@coding-agent/workspace";
import { AgentHost } from "./index.js";

const execFileAsync = promisify(execFile);

describe("AgentHost", () => {
  it("keeps the legacy maxSteps option non-enforcing", () => {
    expect(() => new AgentHost({ store: new InMemoryEventStore() })).not.toThrow();
    expect(() => new AgentHost({ store: new InMemoryEventStore(), maxSteps: 512 })).not.toThrow();
    expect(() => new AgentHost({ store: new InMemoryEventStore(), maxSteps: 513 })).not.toThrow();
    expect(() => new AgentHost({ store: new InMemoryEventStore(), maxSteps: 0 })).not.toThrow();
  });

  it("continues a tool loop beyond a legacy maxSteps value", async () => {
    const store = new InMemoryEventStore();
    const registry = new ToolRegistry();
    registry.register({ name: "legacy_step_fixture", description: "fixture", inputSchema: { type: "object" }, executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel", execute: async () => ({ ok: true, output: "fixture output" }) });
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        if (request.messages.some((message) => message.role === "tool")) yield { type: "text_delta", text: "completed after tool" };
        else {
          yield { type: "tool_call_start", index: 0, id: "call_legacy_step_fixture", name: "legacy_step_fixture" };
          yield { type: "tool_call_delta", index: 0, arguments: "{}" };
          yield { type: "tool_call_end", index: 0 };
        }
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model, maxSteps: 1, toolRuntime: new ToolRuntime({ store, registry }) });
    const session = await host.createSession("D:/legacy-max-steps-fixture");
    const turn = await host.sendMessage(session.id, "run the fixture");
    await host.waitForTurn(turn);
    expect((await host.getSession(session.id))?.status).toBe("idle");
    expect((await host.events(session.id)).filter((event) => event.type === "step/started")).toHaveLength(2);
  });

  it("uses a ten-call parallel default and validates the host-owned scheduler cap", () => {
    expect(new AgentHost({ store: new InMemoryEventStore() }).toolExecutionSettings()).toEqual({ maxParallelToolCalls: 10 });
    expect(new AgentHost({ store: new InMemoryEventStore(), maxParallelToolCalls: 3 }).toolExecutionSettings()).toEqual({ maxParallelToolCalls: 3 });
    expect(() => new AgentHost({ store: new InMemoryEventStore(), maxParallelToolCalls: 0 })).toThrow("maxParallelToolCalls must be an integer between 1 and 512");
    expect(() => new AgentHost({ store: new InMemoryEventStore(), maxParallelToolCalls: 513 })).toThrow("maxParallelToolCalls must be an integer between 1 and 512");
  });

  it("exposes the 200K/64K/32K fallback through the Host context budget", () => {
    const host = new AgentHost({ store: new InMemoryEventStore() });
    expect(host.contextBudgetSnapshot()).toMatchObject({
      capability: { maxInputTokens: 200_000, maxOutputTokens: 64_000, defaultMaxOutputTokens: 32_000, source: "estimate" },
      reservedOutputTokens: 20_000,
      effectiveWindowTokens: 180_000,
    });
  });

  it("enforces tenant session and turn quotas without affecting unowned local sessions", async () => {
    const store = new InMemoryEventStore();
    const host = new AgentHost({ store, quota: { maxSessionsPerTenant: 1, maxTurnsPerTenant: 1 } });
    const ownership = { principalId: brand<string, "PrincipalId">("user-a"), tenantId: brand<string, "TenantId">("tenant-a") };
    const first = await host.createSession("D:/tenant-a", undefined, undefined, ownership);
    await expect(host.createSession("D:/tenant-a-two", undefined, undefined, ownership)).rejects.toMatchObject({ code: "SESSION_QUOTA_EXCEEDED" });
    const turn = await host.sendMessage(first.id, "one");
    expect(turn).toMatch(/^turn_/u);
    await expect(host.sendMessage(first.id, "two")).rejects.toMatchObject({ code: "TURN_QUOTA_EXCEEDED" });
    await expect(host.createSession("D:/local")).resolves.toMatchObject({ workspaceRoot: "D:/local" });
  });

  it("exposes an explicit deferred productization boundary", () => {
    const host = new AgentHost({ store: new InMemoryEventStore() });
    expect(host.productizationSettings()).toMatchObject({
      version: 1,
      enabled: false,
      status: "deferred",
      auth: { status: "deferred", mode: "disabled", required: false },
      multiUser: { status: "deferred" },
      tenantIsolation: { status: "deferred" },
      quota: { status: "disabled", enforcement: "disabled" },
      routing: { status: "available", modelSelector: "host-local" },
      credentials: { status: "configured", secretStore: "host-only", redaction: "required" },
      operations: { status: "deferred" },
    });
  });

  it("exposes whole-log stats separately from the history window", async () => {
    const host = new AgentHost({ store: new InMemoryEventStore() });
    const session = await host.createSession("D:/stats-runtime");
    expect(await host.getSessionStats(session.id)).toMatchObject({ version: 1, complete: true, sourceSequence: session.lastSequence, turnCount: 0, stepCount: 0 });
  });

  it("exposes configured backup and migration operations without claiming upgrade support", () => {
    const host = new AgentHost({ store: new InMemoryEventStore(), operations: { backup: "available", migration: "available", upgrade: "deferred" } });
    expect(host.productizationSettings().operations).toEqual({ status: "configured", backup: "available", migration: "available", upgrade: "deferred" });
  });

  it("routes turns by tenant ownership and records only the selected route metadata", async () => {
    const store = new InMemoryEventStore();
    const makeModel = (text: string): ChatModel => ({
      async *stream(): AsyncIterable<ModelStreamPart> {
        yield { type: "text_delta", text };
        yield { type: "done" };
      },
    });
    const host = new AgentHost({ store, model: makeModel("host-model") });
    const tenantA = { principalId: brand<string, "PrincipalId">("user-a"), tenantId: brand<string, "TenantId">("tenant-a") };
    const tenantB = { principalId: brand<string, "PrincipalId">("user-b"), tenantId: brand<string, "TenantId">("tenant-b") };
    host.setTenantModel("tenant-a", makeModel("tenant-a-model"), {
      provider: "deepseek",
      model: "tenant-model-a",
      baseUrl: "https://tenant-a.example.test",
      credentialRef: { id: "cred-tenant-a", kind: "header", label: "Tenant A" },
    });
    const sessionA = await host.createSession("D:/tenant-a", undefined, undefined, tenantA);
    const sessionB = await host.createSession("D:/tenant-b", undefined, undefined, tenantB);
    const turnA = await host.sendMessage(sessionA.id, "route A");
    const turnB = await host.sendMessage(sessionB.id, "route B");
    await Promise.all([host.waitForTurn(turnA), host.waitForTurn(turnB)]);

    const eventsA = await host.events(sessionA.id);
    const eventsB = await host.events(sessionB.id);
    expect(eventsA.find((event) => event.type === "turn/started")?.payload).toMatchObject({ provider: "deepseek", model: "tenant-model-a", baseUrl: "https://tenant-a.example.test", credentialRef: { id: "cred-tenant-a" } });
    expect(eventsB.find((event) => event.type === "turn/started")?.payload).not.toHaveProperty("provider");
    expect((await host.getSession(sessionA.id))?.messages.at(-1)?.content).toBe("tenant-a-model");
    expect((await host.getSession(sessionB.id))?.messages.at(-1)?.content).toBe("host-model");
    expect(JSON.stringify(eventsA)).not.toContain("secret");
    expect(host.productizationSettings("tenant-a").routing).toMatchObject({ status: "configured", modelSelector: "tenant-scoped", providerCount: 1 });
    expect(host.productizationSettings("tenant-b").routing).toMatchObject({ status: "available", modelSelector: "host-local" });
  });

  it("keeps a session model selection durable and snapshots the route for an in-flight turn", async () => {
    const store = new InMemoryEventStore();
    let releaseFirst!: () => void;
    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first: ChatModel = {
      async *stream(): AsyncIterable<ModelStreamPart> {
        startedFirst();
        await firstGate;
        yield { type: "text_delta", text: "first-model" };
        yield { type: "done" };
      },
    };
    const second: ChatModel = {
      async *stream(): AsyncIterable<ModelStreamPart> {
        yield { type: "text_delta", text: "second-model" };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model: first, compactionEnabled: false });
    const session = await host.createSession("D:/session-selection");
    const turn = await host.sendMessage(session.id, "in flight");
    await firstStarted;
    await host.selectSessionModel(session.id, { provider: "fixture", model: "second" }, second, { provider: "fixture", model: "second" }, "select-second");
    await host.selectSessionModel(session.id, { provider: "fixture", model: "second" }, second, { provider: "fixture", model: "second" }, "select-second");
    releaseFirst();
    await host.waitForTurn(turn);
    expect((await host.getSession(session.id))?.messages.at(-1)?.content).toBe("first-model");
    const firstEvents = await host.events(session.id);
    expect(firstEvents.filter((event) => event.type === "session/model_selected")).toHaveLength(1);
    expect((await host.getSession(session.id))?.modelSelection).toEqual({ provider: "fixture", model: "second" });

    const nextTurn = await host.sendMessage(session.id, "next turn");
    await host.waitForTurn(nextTurn);
    expect((await host.getSession(session.id))?.messages.at(-1)?.content).toBe("second-model");
    const forkedId = await host.forkSession(session.id);
    expect((await host.getSession(forkedId))?.modelSelection).toEqual({ provider: "fixture", model: "second" });
  });

  it("gives the model an explicit workspace and tool-use contract", async () => {
    const requests: ModelRequest[] = [];
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        yield { type: "text_delta", text: "Inspected." };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store: new InMemoryEventStore(), model });
    const session = await host.createSession("D:/repository-under-review");
    const turn = await host.sendMessage(session.id, "review this repository");
    await host.waitForTurn(turn);
    const system = requests[0]?.messages.find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain("D:/repository-under-review");
    expect(system).toContain("Use the tools proactively");
    expect(system).toContain("Do not ask the user to run shell commands");
    expect(system).toContain("Visible tools for this turn");
    expect(system).toContain("read_file");
    expect(system).toContain("# Tool guidance");
    expect(system).toContain("Purpose:");
    expect(system).toContain("Active permission preset: ask-on-write");
    expect(system).toContain("Before editing, read the current file");
  });

  it("publishes the platform-selected shell roster through model tools and prompt guidance", async () => {
    const capture = async (platform: "win32" | "linux") => {
      const requests: ModelRequest[] = [];
      const model: ChatModel = {
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
          requests.push(request);
          yield { type: "text_delta", text: "roster-checked" };
          yield { type: "done" };
        },
      };
      const store = new InMemoryEventStore();
      const registry = new ToolRegistry();
      registry.registerMany(createBuiltinTools({ platform }));
      const host = new AgentHost({ store, model, toolRegistry: registry });
      const session = await host.createSession("D:/platform-roster-" + platform);
      const turn = await host.sendMessage(session.id, "inspect the available shell");
      await host.waitForTurn(turn);
      const request = requests[0];
      const system = request?.messages.find((message) => message.role === "system")?.content ?? "";
      return {
        toolNames: request?.tools?.map((tool) => tool.name) ?? [],
        system,
      };
    };

    const windows = await capture("win32");
    expect(windows.toolNames).toContain("pwsh");
    expect(windows.toolNames).not.toContain("bash");
    expect(windows.system).toContain("## pwsh");
    expect(windows.system).not.toContain("## bash");

    const posix = await capture("linux");
    expect(posix.toolNames).toContain("bash");
    expect(posix.toolNames).not.toContain("pwsh");
    expect(posix.system).toContain("## bash");
    expect(posix.system).not.toContain("## pwsh");
  });

  it("records the canonical M03 context assembly fingerprint and stable section metadata", async () => {
    const store = new InMemoryEventStore();
    const model: ChatModel = {
      async *stream(): AsyncIterable<ModelStreamPart> {
        yield { type: "text_delta", text: "assembled" };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model });
    const session = await host.createSession("D:/m03-assembly-fixture");
    const turn = await host.sendMessage(session.id, "inspect assembly");
    await host.waitForTurn(turn);
    const step = (await host.events(session.id)).find((event) => event.type === "step/started");
    expect(step?.payload["contextAssembly"]).toMatchObject({
      fingerprint: expect.stringMatching(/^ctx_[0-9a-f]{8}$/u),
      sectionIds: ["identity", "task_execution", "safety", "verification", "communication", "tool_use", "tool_guidance", "workspace", "permissions"],
      staticSectionIds: ["identity", "task_execution", "safety", "verification", "communication"],
      dynamicSectionIds: ["tool_use", "tool_guidance", "workspace", "permissions"],
      attachmentIds: [],
    });
  });

  it("rebuilds the assembly after a tool loop so the model-visible history gets a new fingerprint", async () => {
    const store = new InMemoryEventStore();
    const registry = new ToolRegistry();
    registry.register({ name: "assembly_fixture", description: "fixture", inputSchema: { type: "object" }, executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel", execute: async () => ({ ok: true, output: "tool output" }) });
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        if (request.messages.some((message) => message.role === "tool")) {
          yield { type: "text_delta", text: "finished" };
        } else {
          yield { type: "tool_call_start", index: 0, id: "call_assembly", name: "assembly_fixture" };
          yield { type: "tool_call_delta", index: 0, arguments: "{}" };
          yield { type: "tool_call_end", index: 0 };
        }
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model, toolRuntime: new ToolRuntime({ store, registry }) });
    const session = await host.createSession("D:/m03-tool-loop-fixture");
    const turn = await host.sendMessage(session.id, "run the fixture");
    await host.waitForTurn(turn);
    const assemblies = (await host.events(session.id))
      .filter((event) => event.type === "step/started")
      .map((event) => event.payload["contextAssembly"] as { readonly fingerprint?: string });
    expect(assemblies).toHaveLength(2);
    expect(assemblies[0]?.fingerprint).not.toBe(assemblies[1]?.fingerprint);
  });

  it("adds a DSH-style advisory notice after an exact repeated tool call without blocking it", async () => {
    const store = new InMemoryEventStore();
    const registry = new ToolRegistry();
    registry.register({ name: "probe", description: "fixture", inputSchema: { type: "object" }, executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel", execute: async () => ({ ok: true, output: "ok" }) });
    const requests: ModelRequest[] = [];
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        const toolResults = request.messages.filter((message) => message.role === "tool").length;
        if (toolResults < 3) {
          const argumentsValue = toolResults === 1 ? '{"a":1,"b":2}' : '{"b":2,"a":1}';
          yield { type: "tool_call_start", index: 0, id: `call_probe_${toolResults + 1}`, name: "probe" };
          yield { type: "tool_call_delta", index: 0, arguments: argumentsValue };
          yield { type: "tool_call_end", index: 0 };
        } else {
          yield { type: "text_delta", text: "finished" };
        }
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model, toolRuntime: new ToolRuntime({ store, registry }) });
    const session = await host.createSession("D:/repeat-reminder-fixture");
    const turn = await host.sendMessage(session.id, "repeat the probe");
    await host.waitForTurn(turn);

    const events = await host.events(session.id);
    const notice = events.find((event) => event.type === "user/message" && event.payload["source"] !== undefined);
    expect(notice?.payload).toMatchObject({ source: { kind: "plugin", plugin: "repeat-tool-reminder", form: "notice" } });
    const noticeSequence = notice?.sequence ?? 0;
    const toolResultSequences = events.filter((event) => event.type === "tool/result").map((event) => event.sequence);
    expect(toolResultSequences).toHaveLength(3);
    expect(noticeSequence).toBeGreaterThan(toolResultSequences.at(-1) ?? 0);
    expect(requests.at(-1)?.messages.some((message) => message.role === "user" && message.content.includes("repeating the exact same tool call"))).toBe(true);
    expect(events.some((event) => event.type === "turn/ended" && event.payload["status"] === "completed")).toBe(true);
  });

  it("records M04 request/response identities and message validation metadata", async () => {
    const requests: ModelRequest[] = [];
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        yield { type: "text_delta", text: "validated" };
        yield { type: "done" };
      },
    };
    const store = new InMemoryEventStore();
    const host = new AgentHost({ store, model });
    const session = await host.createSession("D:/m04-identities-fixture");
    const turn = await host.sendMessage(session.id, "check message gate");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    const step = events.find((event) => event.type === "step/started");
    const assistant = events.find((event) => event.type === "assistant/message");
    expect(step?.payload["modelRequestId"]).toMatch(/^request_/u);
    expect(step?.payload["messageValidation"]).toMatchObject({ mode: "repair", apiRoundCount: 1, pairingValid: true, pairingRepaired: false });
    expect(assistant?.payload["requestId"]).toBe(step?.payload["modelRequestId"]);
    expect(assistant?.payload["responseId"]).toMatch(/^response_/u);
    expect(requests[0]?.messages[0]?.role).toBe("system");
  });

  it("supports strict message validation as a fail-closed request gate", async () => {
    const store = new InMemoryEventStore();
    const model: ChatModel = {
      async *stream(): AsyncIterable<ModelStreamPart> {
        yield { type: "text_delta", text: "should not run" };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model, messageValidationMode: "strict" });
    const session = await host.createSession("D:/m04-strict-fixture");
    await store.append({ sessionId: session.id, type: "assistant/message", payload: { content: "invalid", toolCalls: [{ id: "", name: "read", arguments: "{}" }] } });
    const turn = await host.sendMessage(session.id, "continue");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(events.some((event) => event.type === "agent/error" && String(event.payload["message"]).includes("MODEL_MESSAGE_VALIDATION_FAILED"))).toBe(true);
    expect(events.some((event) => event.type === "assistant/message" && event.payload["content"] === "should not run")).toBe(false);
  });

  it("falls back to the next model before any partial output and records the recovery event", async () => {
    const store = new InMemoryEventStore();
    const failing: ChatModel = { async *stream(): AsyncIterable<ModelStreamPart> { throw new Error("PRIMARY_UNAVAILABLE"); } };
    const fallback: ChatModel = { async *stream(): AsyncIterable<ModelStreamPart> { yield { type: "text_delta", text: "fallback-ok" }; yield { type: "done" }; } };
    const host = new AgentHost({ store, model: failing, fallbackModels: [fallback] });
    const session = await host.createSession("D:/fallback-fixture");
    const turn = await host.sendMessage(session.id, "continue safely");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(events.some((event) => event.type === "agent/error" && event.payload["code"] === "MODEL_FALLBACK")).toBe(true);
    expect(events.some((event) => event.type === "assistant/message" && event.payload["content"] === "fallback-ok")).toBe(true);
    expect(events.find((event) => event.type === "turn/ended")?.payload["status"]).toBe("completed");
    expect(events.find((event) => event.type === "turn/started")?.payload["traceId"]).toMatch(/^trace_/u);
    expect(events.find((event) => event.type === "turn/ended")?.payload["traceId"]).toBe(events.find((event) => event.type === "turn/started")?.payload["traceId"]);
    expect(host.metrics()).toMatchObject({ turnsStarted: 1, turnsCompleted: 1, modelFallbacks: 1 });
  });

  it("does not fall back after a tool-call delta has been emitted", async () => {
    const store = new InMemoryEventStore();
    const primary: ChatModel = {
      async *stream(): AsyncIterable<ModelStreamPart> {
        yield { type: "tool_call_start", index: 0, id: "call_partial", name: "read_file" };
        yield { type: "tool_call_delta", index: 0, arguments: "{\"path\":\"README.md\"}" };
        throw Object.assign(new Error("stream interrupted"), { code: "STREAM_CLOSED" });
      },
    };
    const fallback: ChatModel = { async *stream(): AsyncIterable<ModelStreamPart> { yield { type: "text_delta", text: "must-not-run" }; yield { type: "done" }; } };
    const host = new AgentHost({ store, model: primary, fallbackModels: [fallback] });
    const session = await host.createSession("D:/partial-tool-fallback-fixture");
    const turn = await host.sendMessage(session.id, "read safely");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(events.some((event) => event.type === "assistant/message" && event.payload["content"] === "must-not-run")).toBe(false);
    expect(events.find((event) => event.type === "agent/error")?.payload).toMatchObject({ partialOutput: true, failureCode: "STREAM_CLOSED" });
    expect(host.metrics()).toMatchObject({ modelFallbacks: 0, turnsFailed: 1 });
  });

  it("claims background job cancellation commands so repeated actions do not repeat the side effect", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-runtime-job-command-"));
    const store = new InMemoryEventStore();
    const host = new AgentHost({ store });
    try {
      const session = await host.createSession(root, "danger-full-access");
      const started = await host.executeTool(session.id, "pwsh", {
        command: "Start-Sleep -Seconds 10",
        description: "runtime job command fixture",
        run_in_background: true,
      }, undefined, "runtime-job-start", undefined, "system");
      const output = started.result?.output;
      const jobId = typeof output === "object" && output !== null && typeof (output as { readonly jobId?: unknown }).jobId === "string"
        ? (output as { readonly jobId: string }).jobId
        : undefined;
      if (jobId === undefined) return;

      const cancelled = await host.killJob(session.id, jobId, "runtime-job-cancel");
      const repeated = await host.killJob(session.id, jobId, "runtime-job-cancel");
      expect(cancelled.ok).toBe(true);
      expect(repeated.output).toMatchObject({ jobId, status: "idempotent_replay" });
      expect((await store.getCommand(session.id, "runtime-job-cancel"))?.kind).toBe("cancel_job");
    } finally {
      await host.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renames a session through an idempotent session/updated event", async () => {
    const store = new InMemoryEventStore();
    const host = new AgentHost({ store });
    const session = await host.createSession("D:/rename-fixture");

    const renamed = await host.renameSession(session.id, "  Review queue  ", "rename-command-1");
    const repeated = await host.renameSession(session.id, "  Review queue  ", "rename-command-1");

    expect(renamed.title).toBe("Review queue");
    expect(repeated.title).toBe("Review queue");
    expect((await host.events(session.id)).filter((event) => event.type === "session/updated")).toHaveLength(1);
    await expect(host.renameSession(session.id, " ")).rejects.toThrow("Session title cannot be empty");
  });

  it("updates Goal, Plan and Todo through durable idempotent CAS commands", async () => {
    const store = new InMemoryEventStore();
    const host = new AgentHost({ store });
    const session = await host.createSession("D:/planning-command-fixture");
    await store.append({ sessionId: session.id, type: "goal/created", payload: { goalId: "goal_one", title: "Ship", successCriteria: ["Tests pass"], status: "active" } });
    const before = await host.getSession(session.id);
    const paused = await host.updateGoal(session.id, "goal_one", { status: "paused", title: "Ship safely" }, before!.goals[0]!.lastSequence, "goal-command-1");
    const repeatedGoal = await host.updateGoal(session.id, "goal_one", { status: "paused", title: "Ship safely" }, before!.goals[0]!.lastSequence, "goal-command-1");
    expect(paused.goals[0]).toMatchObject({ status: "paused", title: "Ship safely" });
    expect(repeatedGoal.goals[0]).toMatchObject({ status: "paused", title: "Ship safely" });
    await expect(host.updateGoal(session.id, "goal_one", { status: "active" }, before!.goals[0]!.lastSequence, "goal-command-stale")).rejects.toMatchObject({ code: "COMMAND_CONFLICT" });

    const drafted = await host.updatePlan(session.id, "Inspect then test", "draft", paused.plan.lastSequence, "plan-command-1");
    const approved = await host.updatePlan(session.id, "Inspect then test", "approved", drafted.plan.lastSequence, "plan-command-2");
    expect(approved.plan).toMatchObject({ content: "Inspect then test", status: "approved" });

    const todos = await host.updateTodos(session.id, [{ id: "todo_one", content: "Test", status: "in_progress", activeForm: "Testing" }], approved.lastSequence, "todo-command-1");
    expect(todos.todos).toEqual([{ id: "todo_one", content: "Test", status: "in_progress", activeForm: "Testing" }]);
    expect((await host.events(session.id)).filter((event) => event.type === "goal/updated")).toHaveLength(1);
    expect((await store.getCommand(session.id, "plan-command-2"))?.kind).toBe("update_plan");
  });

  it("compacts long conversation context before the model request and records replay metadata", async () => {
    const store = new InMemoryEventStore();
    const requests: ModelRequest[] = [];
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        yield { type: "text_delta", text: "done" };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model, contextBudget: { maxTokens: 120, recentMessageTokens: 40, maxSummaryChars: 300 } });
    const session = await host.createSession("D:/compaction-fixture");
    await store.append({ sessionId: session.id, type: "user/message", payload: { content: "old context " + "x".repeat(500) } });
    await store.append({ sessionId: session.id, type: "assistant/message", payload: { content: "old answer " + "x".repeat(500) } });
    const turn = await host.sendMessage(session.id, "current request");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(events.some((event) => event.type === "context/compacted")).toBe(true);
    expect((await host.getSession(session.id))?.contextCompaction).toMatchObject({ status: "completed", droppedMessages: expect.any(Number) });
    expect((await host.getSession(session.id))?.contextDiagnostics).toMatchObject({ tokenSource: "estimate", tokenConfidence: "medium", effectiveWindowTokens: expect.any(Number), lastCompaction: { status: "completed", preCompactTokens: expect.any(Number), postCompactTokens: expect.any(Number), tokensSaved: expect.any(Number) } });
    expect(events.find((event) => event.type === "context/compacted")?.payload).toMatchObject({ preCompactTokens: expect.any(Number), postCompactTokens: expect.any(Number), tokensSaved: expect.any(Number) });
    expect(requests[0]?.messages.some((message) => message.content.includes("Compacted context"))).toBe(true);
  });

  it("records compaction failure and continues with the original context", async () => {
    const store = new InMemoryEventStore();
    const model: ChatModel = {
      async *stream(): AsyncIterable<ModelStreamPart> {
        yield { type: "text_delta", text: "continued" };
        yield { type: "done" };
      },
    };
    const explodingBudget = {} as Partial<import("@coding-agent/compaction").ContextBudget>;
    Object.defineProperty(explodingBudget, "maxTokens", { enumerable: true, get: () => { throw new Error("budget fixture unavailable"); } });
    const host = new AgentHost({ store, model, contextBudget: explodingBudget, contextPolicy: { contextWindowTokens: 30_000 } });
    const session = await host.createSession("D:/compaction-failure-fixture");
    await store.append({ sessionId: session.id, type: "user/message", payload: { content: "history " + "x".repeat(500) } });
    const turn = await host.sendMessage(session.id, "continue despite compaction failure");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(events.some((event) => event.type === "context/compaction_failed" && event.payload["error"] === "budget fixture unavailable")).toBe(true);
    expect((await host.getSession(session.id))?.status).toBe("idle");
    expect((await host.getSession(session.id))?.messages.at(-1)?.content).toBe("continued");
  });

  it("records a model-aware M01 budget snapshot on every model step", async () => {
    const store = new InMemoryEventStore();
    const model: ChatModel = {
      contextCapability: {
        provider: "fixture-provider",
        model: "fixture-128k",
        maxInputTokens: 128_000,
        maxOutputTokens: 32_000,
        supportsExactCount: false,
        supportsPromptCache: false,
        source: "provider",
      },
      async *stream(): AsyncIterable<ModelStreamPart> {
        yield { type: "text_delta", text: "budget recorded" };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model });
    const session = await host.createSession("D:/context-budget-fixture");
    const turn = await host.sendMessage(session.id, "inspect budget");
    await host.waitForTurn(turn);
    const step = (await host.events(session.id)).find((event) => event.type === "step/started");
    expect(step?.payload["contextBudget"]).toMatchObject({
      capability: { provider: "fixture-provider", model: "fixture-128k", maxInputTokens: 128_000 },
      reservedOutputTokens: 20_000,
      effectiveWindowTokens: 108_000,
      autoCompactThreshold: 95_000,
      blockingThreshold: 105_000,
      source: "provider",
    });
    expect(step?.payload["contextWarning"]).toMatchObject({ isAboveAutoCompactThreshold: false });
    expect((await host.getSession(session.id))?.contextDiagnostics).toMatchObject({ tokenSource: "estimate", tokenConfidence: "medium", effectiveWindowTokens: 108_000, level: "healthy", lastStep: 1 });
  });

  it("uses an exact model counter near the boundary and records its provenance", async () => {
    const store = new InMemoryEventStore();
    const model: ChatModel = {
      contextCapability: {
        provider: "exact-fixture",
        model: "exact-model",
        maxInputTokens: 2_000,
        maxOutputTokens: 0,
        supportsExactCount: true,
        supportsPromptCache: false,
        source: "provider",
      },
      countTokens: async () => 123,
      async *stream(): AsyncIterable<ModelStreamPart> {
        yield { type: "text_delta", text: "exact count recorded" };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model, contextPolicy: { autoCompactEnabled: false, warningBufferTokens: 100, errorBufferTokens: 100, blockingBufferTokens: 10, predictiveGrowthTokens: 1 } });
    const session = await host.createSession("D:/exact-count-fixture");
    const turn = await host.sendMessage(session.id, "x".repeat(12_000));
    await host.waitForTurn(turn);
    const step = (await host.events(session.id)).find((event) => event.type === "step/started");
    expect(step?.payload["tokenCount"]).toMatchObject({ value: 123, source: "provider", confidence: "exact", exactAttempted: true });
    expect((await host.getSession(session.id))?.contextDiagnostics).toMatchObject({ tokenUsage: 123, tokenSource: "provider", tokenConfidence: "exact", effectiveWindowTokens: expect.any(Number) });
  });

  it("exposes Context Collapse as an explicit deferred capability", () => {
    const host = new AgentHost({ store: new InMemoryEventStore() });
    expect(host.contextSettings().collapse).toEqual({
      version: 1,
      enabled: false,
      status: "deferred",
      reason: expect.stringContaining("M01-M13"),
      features: { readTimeProjection: false, backgroundCollapse: false, overflowDrain: false, snip: false },
    });
  });

  it("reports Memory adapter readiness and the stable Project Memory scope strategy", () => {
    const unavailable = new AgentHost({ store: new InMemoryEventStore() });
    expect(unavailable.memorySettings()).toEqual({
      version: 1,
      session: { version: 1, configured: false, enabled: false, status: "unavailable", reason: "Session Memory adapter is not configured." },
      project: { version: 1, configured: false, enabled: false, status: "unavailable", reason: "Project Memory adapter is not configured." },
      scope: { strategy: "workspace-tenant-sha256", keyPrefix: "pm_", digestHexLength: 24 },
    });

    const disabled = new AgentHost({
      store: new InMemoryEventStore(),
      sessionMemory: { get: async () => undefined },
      projectMemory: { getEntrypoint: async () => undefined, listTopics: async () => [], readTopic: async () => undefined },
      sessionMemoryEnabled: false,
      projectMemoryEnabled: false,
    });
    expect(disabled.memorySettings()).toMatchObject({
      session: { configured: true, enabled: false, status: "disabled" },
      project: { configured: true, enabled: false, status: "disabled" },
    });

    const available = new AgentHost({
      store: new InMemoryEventStore(),
      sessionMemory: { get: async () => undefined },
      projectMemory: { getEntrypoint: async () => undefined, listTopics: async () => [], readTopic: async () => undefined },
    });
    expect(available.memorySettings()).toMatchObject({
      session: { configured: true, enabled: true, status: "available" },
      project: { configured: true, enabled: true, status: "available" },
    });
  });

  it("builds the prompt from the permission-filtered tool set and preserves custom instructions", async () => {
    const requests: ModelRequest[] = [];
    const store = new InMemoryEventStore();
    const registry = new ToolRegistry();
    registry.register({ name: "visible_read", description: "read", inputSchema: { type: "object" }, executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel", execute: async () => ({ ok: true, output: "ok" }) });
    registry.register({ name: "hidden_write", description: "write", inputSchema: { type: "object" }, executionMode: "exclusive", riskLevel: "write", approvalMode: "ask", interruptBehavior: "cancel", execute: async () => ({ ok: true, output: "ok" }) });
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        yield { type: "text_delta", text: "done" };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({
      store,
      model,
      systemPrompt: "Prefer the repository's existing naming conventions.",
      permissionPreset: "read-only",
      toolRuntime: new ToolRuntime({ store, registry, policy: new DefaultPermissionPolicy({ preset: "read-only" }) }),
    });
    const session = await host.createSession("D:/filtered");
    const turn = await host.sendMessage(session.id, "inspect");
    await host.waitForTurn(turn);
    const system = requests[0]?.messages.find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain("visible_read");
    expect(system).not.toContain("hidden_write");
    expect(system).not.toContain("## hidden_write");
    expect(system).toContain("Prefer the repository's existing naming conventions.");
    expect(system).toContain("Active permission preset: read-only");
  });

  it("applies the selected work mode to a session instead of the host default", async () => {
    const store = new InMemoryEventStore();
    const registry = new ToolRegistry();
    registry.register({ name: "write_fixture", description: "write", inputSchema: { type: "object" }, executionMode: "exclusive", riskLevel: "write", approvalMode: "ask", interruptBehavior: "cancel", execute: async () => ({ ok: true, output: "written" }) });
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        if (request.messages.some((message) => message.role === "tool")) yield { type: "text_delta", text: "done" };
        else { yield { type: "tool_call_start", index: 0, id: "call_write_mode", name: "write_fixture" }; yield { type: "tool_call_delta", index: 0, arguments: "{}" }; yield { type: "tool_call_end", index: 0 }; }
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model, permissionPreset: "read-only", toolRuntime: new ToolRuntime({ store, registry }) });
    const session = await host.createSession("D:/workspace", "workspace-write");
    expect(session.permissionPreset).toBe("workspace-write");
    const turn = await host.sendMessage(session.id, "write the fixture");
    await host.waitForTurn(turn);
    expect((await host.getSession(session.id))?.permissions).toHaveLength(0);
    expect((await host.getSession(session.id))?.toolCalls.at(-1)?.status).toBe("completed");
  });

  it("runs a streaming turn and persists every visible event", async () => {
    const host = new AgentHost({ store: new InMemoryEventStore() });
    const session = await host.createSession("D:/workspace");
    const turn = await host.sendMessage(session.id, "inspect this repository");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(events.map((event) => event.type)).toContain("assistant/chunk");
    expect(events.at(-1)?.type).toBe("turn/ended");
    expect((await host.getSession(session.id))?.messages.at(-1)?.content).toBe("Echo: inspect this repository");
  });

  it("persists provider-reported model usage on the assistant message", async () => {
    const store = new InMemoryEventStore();
    const model: ChatModel = {
      async *stream(): AsyncIterable<ModelStreamPart> {
        yield { type: "text_delta", text: "Measured." };
        yield { type: "usage", usage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 3 } };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model });
    const session = await host.createSession("D:/workspace");
    const turn = await host.sendMessage(session.id, "measure usage");
    await host.waitForTurn(turn);
    const event = (await host.events(session.id)).find((item) => item.type === "assistant/message");
    expect(event?.payload).toMatchObject({ usage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 3 } });
  });

  it("runs a model tool call, executes the tool, and continues with the tool result", async () => {
    const store = new InMemoryEventStore();
    const registry = new ToolRegistry();
    registry.register({
      name: "read_fixture",
      description: "Read a deterministic fixture.",
      inputSchema: { type: "object", additionalProperties: false },
      executionMode: "parallel",
      riskLevel: "read",
      approvalMode: "auto",
      interruptBehavior: "cancel",
      execute: async () => ({ ok: true, output: { content: "fixture content" }, modelView: "fixture content" }),
    });
    const requests: ModelRequest[] = [];
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "tool_call_start", index: 0, id: "call_fixture", name: "read_fixture" };
          yield { type: "tool_call_delta", index: 0, arguments: "{}" };
          yield { type: "tool_call_end", index: 0 };
        } else {
          yield { type: "text_delta", text: "The fixture is available." };
        }
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model, toolRuntime: new ToolRuntime({ store, registry }) });
    const session = await host.createSession("D:/workspace");
    const turn = await host.sendMessage(session.id, "read the fixture");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(requests[0]?.tools?.some((tool) => tool.name === "read_fixture")).toBe(true);
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call_fixture", content: "fixture content" });
    expect(events.filter((event) => event.type === "tool/call")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool/result")).toHaveLength(1);
    expect(events.filter((event) => event.type === "step/started")).toHaveLength(2);
    expect((await host.getSession(session.id))?.messages.at(-1)?.content).toBe("The fixture is available.");
    const secondTurn = await host.sendMessage(session.id, "repeat the result");
    await host.waitForTurn(secondTurn);
    expect(requests[2]?.messages.some((message) => message.role === "assistant" && message.toolCalls?.some((toolCall) => toolCall.id === "call_fixture"))).toBe(true);
    expect(requests[2]?.messages.some((message) => message.role === "tool" && message.toolCallId === "call_fixture")).toBe(true);
  });

  it("applies M05 tool-result budget to the model view while preserving durable tool output", async () => {
    const store = new InMemoryEventStore();
    const requests: ModelRequest[] = [];
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        yield { type: "text_delta", text: "budgeted" };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model, compactionEnabled: false, toolResultBudget: { maxResultChars: 8_000, microcompactTriggerToolCount: 6, keepRecentResults: 2 } });
    const session = await host.createSession("D:/m05-budget-fixture");
    for (let index = 0; index < 6; index += 1) {
      const toolCallId = `old-call-${index}`;
      await store.append({ sessionId: session.id, type: "assistant/message", payload: { content: "", toolCalls: [{ id: toolCallId, name: "read_file", arguments: "{}" }] } });
      await store.append({ sessionId: session.id, type: "tool/result", payload: { toolCallId, status: "completed", result: { content: `durable-${index}-${"x".repeat(100)}` } } });
    }
    const turn = await host.sendMessage(session.id, "inspect the recent results");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    const toolMessages = requests[0]?.messages.filter((message) => message.role === "tool") ?? [];
    expect(toolMessages.slice(0, 4).every((message) => message.content === "[Old tool result content cleared]")).toBe(true);
    expect(toolMessages.slice(4).every((message) => message.content.includes("durable-"))).toBe(true);
    expect(events.some((event) => event.type === "context/tool_results_budgeted")).toBe(true);
    expect(events.some((event) => event.type === "context/microcompacted")).toBe(true);
    const step = events.find((event) => event.type === "step/started" && (event.payload["toolResultBudget"] as { readonly clearedCount?: unknown } | undefined)?.clearedCount === 4);
    expect(step?.payload["toolResultBudget"]).toMatchObject({ trigger: "count", clearedCount: 4, tokensSaved: expect.any(Number) });
    const durable = events.filter((event) => event.type === "tool/result");
    expect(durable).toHaveLength(6);
    expect(JSON.stringify(durable)).toContain("durable-0-");
  });

  it("enforces the message-level aggregate budget for parallel fresh results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-runtime-message-budget-"));
    try {
      const store = new InMemoryEventStore();
      const registry = new ToolRegistry();
      const content = "x".repeat(40_000);
      registry.register({
        name: "parallel_fixture",
        description: "Return a large deterministic result for aggregate-budget testing.",
        inputSchema: { type: "object", additionalProperties: false },
        executionMode: "parallel",
        riskLevel: "read",
        approvalMode: "auto",
        interruptBehavior: "cancel",
        execute: async () => ({ ok: true, output: content, modelView: content }),
      });
      const requests: ModelRequest[] = [];
      const model: ChatModel = {
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
          requests.push(request);
          if (requests.length === 1) {
            for (let index = 0; index < 10; index += 1) {
              yield { type: "tool_call_start", index, id: `parallel-call-${index}`, name: "parallel_fixture" };
              yield { type: "tool_call_delta", index, arguments: "{}" };
              yield { type: "tool_call_end", index };
            }
          } else {
            yield { type: "text_delta", text: "parallel results compacted" };
          }
          yield { type: "done" };
        },
      };
      const host = new AgentHost({
        store,
        model,
        compactionEnabled: false,
        toolRuntime: new ToolRuntime({ store, registry }),
        toolResultBudget: {
          maxToolResultsPerMessageChars: 200_000,
          microcompactTriggerToolCount: 99,
          microcompactTriggerTokens: 99_999,
        },
      });
      const session = await host.createSession(root);
      const turn = await host.sendMessage(session.id, "run ten parallel fixtures");
      await host.waitForTurn(turn);

      const secondToolMessages = requests[1]?.messages.filter((message) => message.role === "tool") ?? [];
      const totalChars = secondToolMessages.reduce((sum, message) => sum + message.content.length, 0);
      expect(secondToolMessages).toHaveLength(10);
      expect(totalChars).toBeLessThanOrEqual(200_000);
      expect(secondToolMessages.some((message) => message.content.startsWith("<persisted-tool-result"))).toBe(true);
      const events = await host.events(session.id);
      expect(events.filter((event) => event.type === "context/tool_result_persisted").length).toBeGreaterThanOrEqual(5);
      const step = events.find((event) => event.type === "step/started" && (event.payload["toolResultBudget"] as { readonly trigger?: unknown } | undefined)?.trigger === "message");
      expect(step?.payload["toolResultBudget"]).toMatchObject({
        trigger: "message",
        messageBudgetChars: 200_000,
        messageBudgetMessagesOverBudget: 1,
        messageBudgetReplacedToolCallIds: expect.any(Array),
      });

      const restartedRequests: ModelRequest[] = [];
      const restarted = new AgentHost({
        store,
        model: {
          async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
            restartedRequests.push(request);
            yield { type: "text_delta", text: "replayed aggregate" };
            yield { type: "done" };
          },
        },
        compactionEnabled: false,
        toolResultBudget: {
          maxToolResultsPerMessageChars: 200_000,
          microcompactTriggerToolCount: 99,
          microcompactTriggerTokens: 99_999,
        },
      });
      const replayTurn = await restarted.sendMessage(session.id, "replay aggregate results");
      await restarted.waitForTurn(replayTurn);
      const originalToolViews = secondToolMessages.map((message) => message.content);
      const replayedToolViews = restartedRequests[0]?.messages.filter((message) => message.role === "tool").slice(-10).map((message) => message.content) ?? [];
      expect(replayedToolViews).toEqual(originalToolViews);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("limits parallel tool execution to ten and preserves model call order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-runtime-tool-scheduler-"));
    try {
      const store = new InMemoryEventStore();
      const registry = new ToolRegistry();
      let active = 0;
      let maximum = 0;
      registry.register({
        name: "scheduler_fixture",
        description: "Return a deterministic scheduler fixture.",
        inputSchema: { type: "object", additionalProperties: false },
        executionMode: "parallel",
        riskLevel: "read",
        approvalMode: "auto",
        interruptBehavior: "cancel",
        execute: async (input) => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return { ok: true, output: input };
        },
      });
      const requests: ModelRequest[] = [];
      const model: ChatModel = {
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
          requests.push(request);
          if (requests.length === 1) {
            for (let index = 0; index < 25; index += 1) {
              yield { type: "tool_call_start", index, id: `scheduler-call-${index}`, name: "scheduler_fixture" };
              yield { type: "tool_call_delta", index, arguments: JSON.stringify({ index }) };
              yield { type: "tool_call_end", index };
            }
          } else {
            yield { type: "text_delta", text: "scheduler complete" };
          }
          yield { type: "done" };
        },
      };
      const host = new AgentHost({ store, model, compactionEnabled: false, toolRuntime: new ToolRuntime({ store, registry }) });
      const session = await host.createSession(root);
      const turn = await host.sendMessage(session.id, "run scheduler fixtures");
      await host.waitForTurn(turn);

      expect(maximum).toBeLessThanOrEqual(10);
      const toolMessages = requests[1]?.messages.filter((message) => message.role === "tool") ?? [];
      expect(toolMessages).toHaveLength(25);
      expect(toolMessages.map((message) => JSON.parse(message.content) as { index: number }).map((item) => item.index)).toEqual(Array.from({ length: 25 }, (_, index) => index));
      const resultEvents = (await host.events(session.id))
        .filter((event) => event.type === "tool/result")
        .map((event) => String(event.payload["toolCallId"]));
      expect(resultEvents).toEqual(Array.from({ length: 25 }, (_, index) => `scheduler-call-${index}`));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops replenishing parallel calls after turn cancellation and drains the started calls", async () => {
    const store = new InMemoryEventStore();
    const registry = new ToolRegistry();
    const started: string[] = [];
    registry.register({
      name: "cancel_scheduler_fixture",
      description: "Block until the scheduler cancels this call.",
      inputSchema: { type: "object", additionalProperties: false },
      executionMode: "parallel",
      riskLevel: "read",
      approvalMode: "auto",
      interruptBehavior: "cancel",
      execute: async (_input, context) => {
        started.push(String(context.toolCallId));
        await new Promise<void>((_resolve, reject) => {
          if (context.signal.aborted) { reject(context.signal.reason ?? new Error("cancelled")); return; }
          context.signal.addEventListener("abort", () => reject(context.signal.reason ?? new Error("cancelled")), { once: true });
        });
        return { ok: true };
      },
    });
    const requests: ModelRequest[] = [];
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        for (let index = 0; index < 4; index += 1) {
          yield { type: "tool_call_start", index, id: `cancel-scheduler-${index}`, name: "cancel_scheduler_fixture" };
          yield { type: "tool_call_delta", index, arguments: "{}" };
          yield { type: "tool_call_end", index };
        }
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model, compactionEnabled: false, maxParallelToolCalls: 2, toolRuntime: new ToolRuntime({ store, registry }) });
    const session = await host.createSession("D:/scheduler-cancel");
    const turn = await host.sendMessage(session.id, "cancel scheduler");
    for (let attempt = 0; attempt < 100 && started.length < 2; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(started).toHaveLength(2);
    expect(await host.cancelTurn(session.id, turn)).toBe(true);
    await host.waitForTurn(turn);
    expect(requests).toHaveLength(1);
    expect((await host.events(session.id)).filter((event) => event.type === "tool/result")).toHaveLength(4);
    expect((await host.getSession(session.id))?.status).toBe("stopped");
  });

  it("combines Windows PowerShell parallel results with artifact persistence and restart replay", async () => {
    if (process.platform !== "win32") return;
    const root = await mkdtemp(path.join(tmpdir(), "cra-phase6-pwsh-artifact-"));
    try {
      const store = new InMemoryEventStore();
      const registry = new ToolRegistry();
      registry.register({
        name: "pwsh_large_fixture",
        description: "Emit a large PowerShell result for integration coverage.",
        inputSchema: { type: "object", additionalProperties: false },
        executionMode: "parallel",
        riskLevel: "read",
        approvalMode: "auto",
        interruptBehavior: "cancel",
        execute: async (_input, context) => {
          const result = await execFileAsync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output ('x' * 50001)"], { cwd: context.workspaceRoot, maxBuffer: 200_000 });
          return { ok: true, output: result.stdout, modelView: result.stdout };
        },
      });
      const requests: ModelRequest[] = [];
      const model: ChatModel = {
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
          requests.push(request);
          if (requests.length === 1) {
            for (let index = 0; index < 2; index += 1) {
              yield { type: "tool_call_start", index, id: `pwsh-large-${index}`, name: "pwsh_large_fixture" };
              yield { type: "tool_call_delta", index, arguments: "{}" };
              yield { type: "tool_call_end", index };
            }
          } else {
            yield { type: "text_delta", text: "PowerShell artifacts persisted." };
          }
          yield { type: "done" };
        },
      };
      const host = new AgentHost({ store, model, compactionEnabled: false, toolRuntime: new ToolRuntime({ store, registry }) });
      const session = await host.createSession(root);
      const turn = await host.sendMessage(session.id, "run the PowerShell fixtures");
      await host.waitForTurn(turn);
      const events = await host.events(session.id);
      const receipts = events.filter((event) => event.type === "context/tool_result_persisted");
      expect(receipts).toHaveLength(2);
      expect(events.filter((event) => event.type === "tool/result").map((event) => String(event.payload["toolCallId"]))).toEqual(["pwsh-large-0", "pwsh-large-1"]);
      const firstToolMessage = requests[1]?.messages.find((message) => message.role === "tool");
      expect(firstToolMessage?.content).toContain("persisted-tool-result");
      for (const receipt of receipts) {
        const relativePath = receipt.payload["relativePath"];
        expect(typeof relativePath).toBe("string");
        expect((await stat(path.join(root, String(relativePath)))).isFile()).toBe(true);
      }

      const replayRequests: ModelRequest[] = [];
      const replayModel: ChatModel = {
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
          replayRequests.push(request);
          yield { type: "text_delta", text: "replayed" };
          yield { type: "done" };
        },
      };
      const restarted = new AgentHost({ store, model: replayModel, compactionEnabled: false });
      const replayTurn = await restarted.sendMessage(session.id, "replay the PowerShell artifacts");
      await restarted.waitForTurn(replayTurn);
      const replayToolMessage = replayRequests[0]?.messages.find((message) => message.role === "tool");
      expect(replayToolMessage?.content).toBe(firstToolMessage?.content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists oversized single tool results and replays the same bounded model view", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cra-runtime-tool-result-"));
    try {
      const store = new InMemoryEventStore();
      const registry = new ToolRegistry();
      const content = "x".repeat(50_001);
      registry.register({
        name: "huge_fixture",
        description: "Return a large deterministic fixture.",
        inputSchema: { type: "object", additionalProperties: false },
        executionMode: "parallel",
        riskLevel: "read",
        approvalMode: "auto",
        interruptBehavior: "cancel",
        execute: async () => ({ ok: true, output: content, modelView: content }),
      });
      const requests: ModelRequest[] = [];
      const model: ChatModel = {
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
          requests.push(request);
          if (requests.length === 1) {
            yield { type: "tool_call_start", index: 0, id: "call_huge", name: "huge_fixture" };
            yield { type: "tool_call_delta", index: 0, arguments: "{}" };
            yield { type: "tool_call_end", index: 0 };
          } else {
            yield { type: "text_delta", text: "bounded result observed" };
          }
          yield { type: "done" };
        },
      };
      const host = new AgentHost({ store, model, compactionEnabled: false, toolRuntime: new ToolRuntime({ store, registry }) });
      const session = await host.createSession(root);
      const turn = await host.sendMessage(session.id, "inspect the huge fixture");
      await host.waitForTurn(turn);
      const events = await host.events(session.id);
      const receipt = events.find((event) => event.type === "context/tool_result_persisted");
      expect(receipt?.payload["relativePath"]).toBe(`.agent-artifacts/tool-results/${String(session.id)}/call_huge.txt`);
      expect(JSON.stringify(receipt)).not.toContain(content);
      const durable = events.find((event) => event.type === "tool/result");
      expect(JSON.stringify(durable)).toContain(content);
      const modelToolMessage = requests[1]?.messages.find((message) => message.role === "tool");
      expect(modelToolMessage?.content).toContain("persisted-tool-result");
      expect(modelToolMessage?.content).toContain("preview");
      expect(modelToolMessage?.content).not.toContain(content.slice(0, 10_000));
      expect((await stat(path.join(root, ".agent-artifacts", "tool-results", String(session.id), "call_huge.txt"))).isFile()).toBe(true);

      const restartedRequests: ModelRequest[] = [];
      const restartedModel: ChatModel = {
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
          restartedRequests.push(request);
          yield { type: "text_delta", text: "replayed" };
          yield { type: "done" };
        },
      };
      const restarted = new AgentHost({ store, model: restartedModel, compactionEnabled: false });
      const nextTurn = await restarted.sendMessage(session.id, "replay the fixture");
      await restarted.waitForTurn(nextTurn);
      const replayed = restartedRequests[0]?.messages.find((message) => message.role === "tool");
      expect(replayed?.content).toBe(modelToolMessage?.content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses existing session memory for M06 compaction and records a bounded receipt", async () => {
    const store = new InMemoryEventStore();
    const requests: ModelRequest[] = [];
    let boundaryId = "";
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        yield { type: "text_delta", text: "session-memory-ok" };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({
      store,
      model,
      contextPolicy: { contextWindowTokens: 30_000, autoCompactBufferTokens: 1_000 },
      sessionMemory: { get: async () => ({ content: "Goal: preserve the review plan", lastSummarizedMessageId: boundaryId }) },
      sessionMemoryCompact: { minTokens: 1, minTextBlockMessages: 1, maxTokens: 1_000, maxMemoryChars: 200 },
    });
    const session = await host.createSession("D:/m06-session-memory-fixture");
    await store.append({ sessionId: session.id, type: "user/message", payload: { content: "old context " + "x".repeat(30_000) } });
    const summarized = await store.append({ sessionId: session.id, type: "assistant/message", payload: { content: "old answer " + "x".repeat(30_000) } });
    boundaryId = summarized.eventId;
    await store.append({ sessionId: session.id, type: "user/message", payload: { content: "recent context" } });
    const turn = await host.sendMessage(session.id, "continue with memory");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(requests[0]?.messages.some((message) => message.content.includes("<session-memory>"))).toBe(true);
    expect(events.some((event) => event.type === "context/session_memory_compacted")).toBe(true);
    expect(events.some((event) => event.type === "context/compacted")).toBe(false);
    expect((await host.getSession(session.id))?.contextCompaction).toMatchObject({ kind: "session_memory", status: "completed" });
    const receipt = events.find((event) => event.type === "context/session_memory_compacted");
    expect(receipt?.payload).toMatchObject({ boundaryKnown: true, memoryChars: expect.any(Number), droppedMessages: expect.any(Number) });
  });

  it("uses a tool-less summary model for M07 and records separate summary usage", async () => {
    const store = new InMemoryEventStore();
    const requests: ModelRequest[] = [];
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        if (request.purpose === "context_summary") {
          expect(request.tools).toEqual([]);
          expect(request.toolChoice).toBe("none");
          yield { type: "usage", usage: { inputTokens: 12, outputTokens: 4 } };
          yield { type: "text_delta", text: "Preserve the review goal and the unresolved test failure." };
        } else {
          yield { type: "text_delta", text: "summary-compact-ok" };
        }
        yield { type: "done" };
      },
    };
    const host = new AgentHost({
      store,
      model,
      contextPolicy: { contextWindowTokens: 10_000, autoCompactBufferTokens: 1_000 },
      summaryCompact: { recentMessageTokens: 1, maxSummaryChars: 200, maxPtlRetries: 2 },
    });
    const session = await host.createSession("D:/m07-summary-fixture");
    await store.append({ sessionId: session.id, type: "user/message", payload: { content: "old context " + "x".repeat(30_000) } });
    await store.append({ sessionId: session.id, type: "assistant/message", payload: { content: "old answer " + "x".repeat(30_000), responseId: "old-response" } });
    const turn = await host.sendMessage(session.id, "continue with summary");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(requests[0]?.purpose).toBe("context_summary");
    expect(requests[1]?.messages.some((message) => message.content.includes("<conversation-summary>"))).toBe(true);
    expect(events.some((event) => event.type === "context/summary_started")).toBe(true);
    expect(events.some((event) => event.type === "context/summary_compacted")).toBe(true);
    expect(events.some((event) => event.type === "context/compacted")).toBe(false);
    expect((await host.getSession(session.id))?.contextCompaction).toMatchObject({ kind: "summary", status: "completed" });
    const receipt = events.find((event) => event.type === "context/summary_compacted");
    expect(receipt?.payload).toMatchObject({ summaryUsage: { inputTokens: 12, outputTokens: 4 }, purpose: "context_summary" });
  });

  it("creates an M08 boundary, restores plan attachments, and replays the post-compact segment", async () => {
    const store = new InMemoryEventStore();
    const requests: ModelRequest[] = [];
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        if (request.purpose === "context_summary") {
          yield { type: "text_delta", text: "M08 historical summary" };
        } else {
          yield { type: "text_delta", text: "M08 completed" };
        }
        yield { type: "done" };
      },
    };
    const host = new AgentHost({
      store,
      model,
      contextPolicy: { contextWindowTokens: 10_000, autoCompactBufferTokens: 1_000 },
      summaryCompact: { recentMessageTokens: 1, maxSummaryChars: 200 },
      postCompactAttachmentProvider: async () => [{ id: "file-recent", kind: "file", content: "recent file content" }],
    });
    const session = await host.createSession("D:/m08-boundary-fixture");
    const drafted = await host.updatePlan(session.id, "Run tests after the review", "active");
    expect(drafted.plan.status).toBe("active");
    await store.append({ sessionId: session.id, type: "user/message", payload: { content: "old context " + "x".repeat(30_000) } });
    await store.append({ sessionId: session.id, type: "assistant/message", payload: { content: "old answer", responseId: "old-response" } });
    await store.append({ sessionId: session.id, type: "user/message", payload: { content: "recent context" } });
    const turn = await host.sendMessage(session.id, "continue after compact");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    const boundaryEvent = events.find((event) => event.type === "context/compact_boundary");
    expect(boundaryEvent?.payload["boundary"]).toMatchObject({ version: 1, algorithmVersion: "m10.v1", kind: "summary", sourceSequence: expect.any(Number) });
    expect(events.find((event) => event.type === "context/transcript_segment")?.payload["segment"]).toMatchObject({ version: 1, algorithmVersion: "m10.v1", boundaryId: expect.any(String) });
    expect(boundaryEvent?.payload["attachments"]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "file-recent" }), expect.objectContaining({ id: "plan:" + session.id })]));
    expect(requests[1]?.messages.some((message) => message.role === "system" && message.content === "Conversation compacted")).toBe(true);
    expect(requests[1]?.messages.some((message) => message.content.includes("file-recent"))).toBe(true);
    const restarted = new AgentHost({ store, model, postCompactAttachmentProvider: async () => [{ id: "file-recent", kind: "file", content: "recent file content" }] });
    const replay = await restarted.getSession(session.id);
    expect(replay?.contextCompaction?.boundary?.preservedSegment?.headMessageId).toBeDefined();
    expect(replay?.contextTranscript).toMatchObject({ algorithmVersion: "m10.v1", boundaryId: expect.any(String) });
    const resumedTurn = await restarted.sendMessage(session.id, "resume from the compact boundary");
    await restarted.waitForTurn(resumedTurn);
    expect((await restarted.events(session.id)).some((event) => event.type === "context/session_restored" && event.payload["mode"] === "boundary")).toBe(true);
    expect((await restarted.getSession(session.id))?.contextRestore).toMatchObject({ status: "restored", mode: "boundary", algorithmVersion: "m10.v1" });
    expect(requests.at(-1)?.messages.some((message) => message.role === "system" && message.content === "Conversation compacted")).toBe(true);
    expect(requests.at(-1)?.messages.some((message) => message.content.includes("file-recent"))).toBe(true);
  });

  it("pauses a turn for permission and resumes the same turn after approval", async () => {
    const store = new InMemoryEventStore();
    const registry = new ToolRegistry();
    const writeTool: ToolDefinition = {
      name: "write_fixture",
      description: "Write a deterministic fixture.",
      inputSchema: { type: "object", additionalProperties: false },
      executionMode: "exclusive",
      riskLevel: "write",
      approvalMode: "ask",
      interruptBehavior: "block",
      execute: async () => ({ ok: true, output: { written: true }, modelView: { written: true } }),
    };
    registry.register(writeTool);
    const requests: ModelRequest[] = [];
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "tool_call_start", index: 0, id: "call_write", name: "write_fixture" };
          yield { type: "tool_call_delta", index: 0, arguments: "{}" };
        } else {
          yield { type: "text_delta", text: "Write approved." };
        }
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model, toolRuntime: new ToolRuntime({ store, registry }) });
    const session = await host.createSession("D:/workspace");
    const turn = await host.sendMessage(session.id, "write the fixture");
    let permissionId: PermissionId | undefined;
    for (let attempt = 0; attempt < 100 && permissionId === undefined; attempt += 1) {
      const projection = await host.getSession(session.id);
      permissionId = projection?.permissions.find((permission) => permission.status === "pending")?.id;
      if (permissionId === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(permissionId).toBeDefined();
    const approved = await host.resolvePermission(session.id, permissionId!, "approved");
    expect(approved.status).toBe("completed");
    await host.waitForTurn(turn);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)?.role).toBe("tool");
    expect((await host.getSession(session.id))?.messages.at(-1)?.content).toBe("Write approved.");
  });

  it("replays a pending approval after host restart and continues the interrupted turn", async () => {
    const store = new InMemoryEventStore(); const registry = new ToolRegistry();
    registry.register({ name: "write_fixture", description: "write", inputSchema: { type: "object", additionalProperties: false }, executionMode: "exclusive", riskLevel: "write", approvalMode: "ask", interruptBehavior: "block", execute: async () => ({ ok: true, output: { written: true }, modelView: { written: true } }) });
    const requests: ModelRequest[] = [];
    let calls = 0;
    const model: ChatModel = { async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> { requests.push(request); calls += 1; if (calls === 1) { yield { type: "tool_call_start", index: 0, id: "call_restart", name: "write_fixture" }; yield { type: "tool_call_delta", index: 0, arguments: "{}" }; } else yield { type: "text_delta", text: "Recovered and continued." }; yield { type: "done" }; } };
    const first = new AgentHost({ store, model, toolRuntime: new ToolRuntime({ store, registry }) }); const session = await first.createSession("D:/workspace"); const turn = await first.sendMessage(session.id, "write after restart");
    let permissionId: PermissionId | undefined;
    for (let attempt = 0; attempt < 100 && permissionId === undefined; attempt += 1) { permissionId = (await first.getSession(session.id))?.permissions.find((permission) => permission.status === "pending")?.id; if (permissionId === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
    expect(permissionId).toBeDefined(); await store.append({ sessionId: session.id, turnId: turn, type: "agent/status", payload: { status: "interrupted", reason: "process_restart" } });
    const second = new AgentHost({ store, model, toolRuntime: new ToolRuntime({ store, registry }) }); expect((await second.getSession(session.id))?.status).toBe("interrupted");
    const approved = await second.resolvePermission(session.id, permissionId!, "approved"); expect(approved.status).toBe("completed"); await second.waitForTurn(turn, 2_000);
    expect(requests[1]?.messages.find((message) => message.role === "system")?.content).toContain("# Recovery");
    expect((await second.getSession(session.id))?.messages.at(-1)?.content).toBe("Recovered and continued.");
    expect((await second.events(session.id)).filter((event) => event.type === "agent/status").at(-1)?.payload["status"]).toBe("running");
  });

  it("replays a pending user interaction after host restart and continues the interrupted turn", async () => {
    const store = new InMemoryEventStore(); const registry = new ToolRegistry(); registry.registerMany(createBuiltinTools());
    const requests: ModelRequest[] = [];
    let calls = 0;
    const model: ChatModel = { async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
      requests.push(request); calls += 1;
      if (calls === 1) {
        yield { type: "tool_call_start", index: 0, id: "call_interaction_restart", name: "ask_user" };
        yield { type: "tool_call_delta", index: 0, arguments: JSON.stringify({ question: "Continue after restart?", options: [{ label: "Yes", value: "yes" }] }) };
      } else {
        yield { type: "text_delta", text: "Interaction recovered and continued." };
      }
      yield { type: "done" };
    } };
    const first = new AgentHost({ store, model, toolRuntime: new ToolRuntime({ store, registry, permissionTtlMs: 5_000 }) });
    const session = await first.createSession("D:/workspace"); const turn = await first.sendMessage(session.id, "ask me something");
    let interactionId: InteractionId | undefined;
    for (let attempt = 0; attempt < 100 && interactionId === undefined; attempt += 1) { interactionId = (await first.getSession(session.id))?.interactions.find((interaction) => interaction.status === "pending")?.id; if (interactionId === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
    expect(interactionId).toBeDefined();
    await store.append({ sessionId: session.id, turnId: turn, type: "agent/status", payload: { status: "interrupted", reason: "process_restart" } });
    const second = new AgentHost({ store, model, toolRuntime: new ToolRuntime({ store, registry, permissionTtlMs: 5_000 }) });
    expect((await second.getSession(session.id))?.interactions.find((interaction) => interaction.id === interactionId)?.status).toBe("pending");
    const answer = await second.resolveInteraction(session.id, interactionId!, "answered", "yes");
    expect(answer).toMatchObject({ status: "answered", answer: "yes" });
    await second.waitForTurn(turn, 2_000);
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call_interaction_restart" });
    expect((await second.getSession(session.id))?.messages.at(-1)?.content).toBe("Interaction recovered and continued.");
  });

  it("cancels a permission-paused turn without continuing the model", async () => {
    const store = new InMemoryEventStore();
    const registry = new ToolRegistry();
    registry.register({
      name: "write_fixture",
      description: "Write a deterministic fixture.",
      inputSchema: { type: "object", additionalProperties: false },
      executionMode: "exclusive",
      riskLevel: "write",
      approvalMode: "ask",
      interruptBehavior: "block",
      execute: async () => ({ ok: true, output: { written: true } }),
    });
    const requests: ModelRequest[] = [];
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        yield { type: "tool_call_start", index: 0, id: "call_cancel", name: "write_fixture" };
        yield { type: "tool_call_delta", index: 0, arguments: "{}" };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model, toolRuntime: new ToolRuntime({ store, registry }) });
    const session = await host.createSession("D:/workspace");
    const turn = await host.sendMessage(session.id, "cancel the write");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const projection = await host.getSession(session.id);
      if (projection?.permissions.some((permission) => permission.status === "pending")) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(await host.cancelTurn(session.id, turn)).toBe(true);
    await host.waitForTurn(turn);
    expect(requests).toHaveLength(1);
    expect((await host.events(session.id)).at(-1)?.payload["status"]).toBe("stopped");
  });

  it("cancels a running turn", async () => {
    const host = new AgentHost({ store: new InMemoryEventStore() });
    const session = await host.createSession("D:/workspace");
    const turn = await host.sendMessage(session.id, "cancel me");
    expect(await host.cancelTurn(session.id, turn)).toBe(true);
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(events.some((event) => event.type === "agent/status")).toBe(true);
    expect(events.at(-1)?.payload["status"]).toBe("stopped");
  });

  it("queues turns and makes repeated send commands idempotent", async () => {
    const store = new InMemoryEventStore();
    const host = new AgentHost({ store });
    const session = await host.createSession("D:/workspace");
    const first = await host.sendMessage(session.id, "first", "send-1");
    expect(await host.sendMessage(session.id, "first", "send-1")).toBe(first);
    const second = await host.sendMessage(session.id, "second", "send-2");
    await host.waitForTurn(first);
    await host.waitForTurn(second);
    const events = await host.events(session.id);
    expect(events.filter((event) => event.type === "user/message")).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn/queued")).toHaveLength(2);
    expect((await host.getSession(session.id))?.turns.map((turn) => turn.status)).toEqual(["completed", "completed"]);
  });

  it("steers a running turn with a durable receipt and idempotent replay", async () => {
    const store = new InMemoryEventStore();
    const requests: ModelRequest[] = [];
    let releaseFirst!: () => void;
    let firstStartedResolve!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        if (requests.length === 1) {
          firstStartedResolve();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
          yield { type: "text_delta", text: "Initial answer" };
        } else {
          yield { type: "text_delta", text: "Steered answer" };
        }
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model });
    const session = await host.createSession("D:/steer-fixture");
    const turn = await host.sendMessage(session.id, "start work");
    await firstStarted;
    const receipt = await host.steerTurn(session.id, turn, "focus on the failing test", "steer-1");
    expect(receipt.accepted).toBe(true);
    expect(receipt.receiptId).toMatch(/^steer_/u);
    expect(await host.steerTurn(session.id, turn, "focus on the failing test", "steer-1")).toEqual(receipt);
    releaseFirst();
    await host.waitForTurn(turn);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)).toEqual({ role: "user", content: "focus on the failing test" });
    expect((await host.events(session.id)).some((event) => event.type === "turn/steered" && event.payload["receiptId"] === receipt.receiptId)).toBe(true);
    expect((await host.steerTurn(session.id, turn, "too late", "steer-late")).accepted).toBe(false);
  });

  it("records attachment receipts idempotently without storing bytes in events", async () => {
    const store = new InMemoryEventStore();
    const host = new AgentHost({ store });
    const session = await host.createSession("D:/attachment-fixture");
    const receipt: AttachmentReceipt = { id: "att_fixture", status: "accepted", fileName: "notes.md", mediaType: "text/markdown", sizeBytes: 5, kind: "file", createdAt: "2026-08-23T00:00:00.000Z", relativePath: ".agent-artifacts/attachments/att_fixture-notes.md" };
    expect(await host.recordAttachment(session.id, receipt, "attachment-1")).toEqual(receipt);
    expect(await host.recordAttachment(session.id, receipt, "attachment-1")).toEqual(receipt);
    const event = (await host.events(session.id)).find((item) => item.type === "attachment/received");
    expect(event?.payload).toMatchObject({ id: "att_fixture", fileName: "notes.md", sizeBytes: 5 });
    expect(JSON.stringify(event?.payload)).not.toContain("hello");
  });

  it("reorders queued turns durably and keeps the command idempotent", async () => {
    const store = new InMemoryEventStore();
    let releaseFirst!: () => void;
    let firstStartedResolve!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
    let calls = 0;
    const model: ChatModel = {
      async *stream(): AsyncIterable<ModelStreamPart> {
        calls += 1;
        if (calls === 1) {
          firstStartedResolve();
          await new Promise<void>((release) => { releaseFirst = release; });
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model });
    const session = await host.createSession("D:/workspace");
    const first = await host.sendMessage(session.id, "first");
    await firstStarted;
    const second = await host.sendMessage(session.id, "second");
    const third = await host.sendMessage(session.id, "third");
    const moved = await host.reorderQueue(session.id, third, 0, "queue-move-1");
    const repeated = await host.reorderQueue(session.id, third, 0, "queue-move-1");
    expect(moved).toMatchObject({ reordered: true, queuedTurnIds: [third, second] });
    expect(repeated).toEqual(moved);
    expect((await host.getSession(session.id))?.turns.filter((turn) => turn.status === "queued").sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0)).map((turn) => turn.id)).toEqual([third, second]);
    releaseFirst();
    await host.waitForTurn(first);
    await host.waitForTurn(third);
    await host.waitForTurn(second);
    const queueEvents = (await host.events(session.id)).filter((event) => event.type === "queue/changed");
    expect(queueEvents.some((event) => JSON.stringify(event.payload["queuedTurnIds"]) === JSON.stringify([third, second]))).toBe(true);
  });

  it("lists and reorders workspaces from a durable event with idempotent replay", async () => {
    const store = new InMemoryEventStore();
    const host = new AgentHost({ store });
    const first = await host.createSession("D:/first");
    const second = await host.createSession("D:/second");
    const before = await host.listWorkspaces();
    expect(new Set(before.workspaces.map((workspace) => workspace.root))).toEqual(new Set(["D:/first", "D:/second"]));
    const requested = ["D:/first", "D:/second"];
    const moved = await host.reorderWorkspaces(requested, "workspace-order-1");
    expect(moved.workspaces.map((workspace) => workspace.root)).toEqual(requested);
    expect(await host.reorderWorkspaces(requested, "workspace-order-1")).toEqual(moved);
    const reopened = new AgentHost({ store });
    expect((await reopened.listWorkspaces()).workspaces.map((workspace) => workspace.root)).toEqual(requested);
    const durableEvents = [...await reopened.events(first.id), ...await reopened.events(second.id)];
    expect(durableEvents.some((event) => event.type === "workspace/reordered")).toBe(true);
  });

  it("renames, archives, restores and soft-deletes a workspace with replayable metadata", async () => {
    const store = new InMemoryEventStore();
    const host = new AgentHost({ store });
    const first = await host.createSession("D:/workspace-lifecycle");
    const second = await host.createSession("D:/workspace-lifecycle");
    await host.createSession("D:/workspace-other");
    const key = "d:/workspace-lifecycle";

    const renamed = await host.renameWorkspace(key, "Review workspace", "workspace-rename-1");
    expect(renamed.workspaces.find((workspace) => workspace.key === key)).toMatchObject({ label: "Review workspace" });
    expect(await host.renameWorkspace(key, "Review workspace", "workspace-rename-1")).toEqual(renamed);

    const archived = await host.archiveWorkspace(key, true, "workspace-archive-1");
    expect(archived.workspaces.some((workspace) => workspace.key === key)).toBe(false);
    expect((await host.listWorkspaces(true)).workspaces.find((workspace) => workspace.key === key)).toMatchObject({ label: "Review workspace", archived: true });

    const restored = await host.archiveWorkspace(key, false, "workspace-restore-1");
    expect(restored.workspaces.find((workspace) => workspace.key === key)).toMatchObject({ label: "Review workspace" });

    const deleted = await host.deleteWorkspace(key, "workspace-delete-1");
    expect(deleted.workspaces.some((workspace) => workspace.key === key)).toBe(false);
    expect((await host.listSessions(true)).filter((session) => session.workspaceRoot === "D:/workspace-lifecycle")).toHaveLength(2);
    const events = [...await host.events(first.id), ...await host.events(second.id)].filter((event) => event.type === "workspace/updated");
    expect(events.map((event) => event.payload["action"])).toEqual(expect.arrayContaining(["renamed", "archived", "restored", "deleted"]));
  });

  it("scopes workspace catalog, metadata, ordering and mutation events by tenant", async () => {
    const store = new InMemoryEventStore();
    const host = new AgentHost({ store });
    const tenantA = { principalId: brand<string, "PrincipalId">("user-a"), tenantId: brand<string, "TenantId">("tenant-a") };
    const tenantB = { principalId: brand<string, "PrincipalId">("user-b"), tenantId: brand<string, "TenantId">("tenant-b") };
    const shared = "D:/shared-workspace";
    const aOnly = "D:/tenant-a-only";
    const bOnly = "D:/tenant-b-only";
    const aShared = await host.createSession(shared, undefined, undefined, tenantA);
    await host.createSession(aOnly, undefined, undefined, tenantA);
    const bShared = await host.createSession(shared, undefined, undefined, tenantB);
    await host.createSession(bOnly, undefined, undefined, tenantB);

    expect((await host.listWorkspaces(false, tenantA)).workspaces.map((workspace) => workspace.root).sort()).toEqual([aOnly, shared].sort());
    expect((await host.listWorkspaces(false, tenantB)).workspaces.map((workspace) => workspace.root).sort()).toEqual([bOnly, shared].sort());

    const renamed = await host.renameWorkspace(shared, "Tenant A label", "tenant-a-rename-1", tenantA);
    expect(renamed.workspaces.find((workspace) => workspace.key === "d:/shared-workspace")).toMatchObject({ label: "Tenant A label" });
    expect((await host.listWorkspaces(false, tenantB)).workspaces.find((workspace) => workspace.key === "d:/shared-workspace")).not.toHaveProperty("label");
    await expect(host.renameWorkspace(aOnly, "Tenant B must not see this", "tenant-b-cross-tenant", tenantB)).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });

    const aOrder = ["d:/tenant-a-only", "d:/shared-workspace"];
    const reordered = await host.reorderWorkspaces(aOrder, "tenant-a-reorder-1", tenantA);
    expect(reordered.workspaces.map((workspace) => workspace.key)).toEqual(aOrder);
    expect((await host.listWorkspaces(false, tenantB)).workspaces.map((workspace) => workspace.root).sort()).toEqual([bOnly, shared].sort());

    const archived = await host.archiveWorkspace(shared, true, "tenant-a-archive-1", tenantA);
    expect(archived.workspaces.some((workspace) => workspace.key === "d:/shared-workspace")).toBe(false);
    expect((await host.listWorkspaces(true, tenantA)).workspaces.find((workspace) => workspace.key === "d:/shared-workspace")).toMatchObject({ archived: true, label: "Tenant A label" });
    expect((await host.listWorkspaces(true, tenantB)).workspaces.find((workspace) => workspace.key === "d:/shared-workspace")).not.toHaveProperty("archived");

    const aEvents = [...await host.events(aShared.id)].filter((event) => event.type === "workspace/updated" || event.type === "workspace/reordered");
    const bEvents = [...await host.events(bShared.id)].filter((event) => event.type === "workspace/updated" || event.type === "workspace/reordered");
    expect(aEvents.some((event) => event.payload["tenantId"] === "tenant-a" && event.payload["principalId"] === "user-a")).toBe(true);
    expect(bEvents.some((event) => event.payload["tenantId"] === "tenant-a")).toBe(false);
  });

  it("replays tenant workspace metadata after SQLite reopen", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coding-agent-tenant-workspace-"));
    const databasePath = path.join(directory, "events.sqlite");
    const ownership = { principalId: brand<string, "PrincipalId">("user-a"), tenantId: brand<string, "TenantId">("tenant-a") };
    const firstStore = new SqliteEventStore({ databasePath });
    const firstHost = new AgentHost({ store: firstStore });
    await firstHost.createSession("D:/tenant-workspace", undefined, undefined, ownership);
    await firstHost.renameWorkspace("D:/tenant-workspace", "Durable tenant label", "tenant-sqlite-rename-1", ownership);
    await firstHost.archiveWorkspace("D:/tenant-workspace", true, "tenant-sqlite-archive-1", ownership);
    firstStore.close();

    const reopenedStore = new SqliteEventStore({ databasePath });
    const reopenedHost = new AgentHost({ store: reopenedStore });
    expect((await reopenedHost.listWorkspaces(true, ownership)).workspaces.find((workspace) => workspace.key === "d:/tenant-workspace")).toMatchObject({ label: "Durable tenant label", archived: true });
    reopenedStore.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("supports resume and fork commands", async () => {
    const store = new InMemoryEventStore();
    const host = new AgentHost({ store });
    const session = await host.createSession("D:/workspace");
    await store.append({ sessionId: session.id, type: "agent/status", payload: { status: "interrupted" } });
    expect((await host.resumeSession(session.id, "resume-1")).status).toBe("idle");
    const turn = await host.sendMessage(session.id, "history");
    await host.waitForTurn(turn);
    const forked = await host.forkSession(session.id, "D:/fork", "fork-1");
    expect((await host.forkSession(session.id, "D:/fork", "fork-1"))).toBe(forked);
    expect((await host.getSession(forked))?.workspaceRoot).toBe("D:/fork");
    expect((await host.getSession(forked))?.status).toBe("idle");
    expect((await host.getSession(forked))?.messages.at(-1)?.content).toBe("Echo: history");
  });

  it("records explainable model failures", async () => {
    const store = new InMemoryEventStore();
    const failingModel = {
      async *stream(): AsyncIterable<{ type: "done" }> {
        throw new Error("provider unavailable");
      },
    };
    const host = new AgentHost({ store, model: failingModel });
    const session = await host.createSession("D:/workspace");
    const turn = await host.sendMessage(session.id, "fail me");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(events.find((event) => event.type === "agent/error")?.payload["message"]).toBe("provider unavailable");
    expect(events.at(-1)?.type).toBe("turn/ended");
    expect(events.at(-1)?.payload["status"]).toBe("failed");
    expect((await host.getSession(session.id))?.status).toBe("failed");
  });

  it("durably creates, switches, protects and replays a Git worktree", async () => {
    try { await execFileAsync("git", ["--version"]); } catch { return; }
    const parent = await mkdtemp(path.join(tmpdir(), "cra-runtime-worktree-"));
    const repo = path.join(parent, "repo");
    try {
      await execFileAsync("git", ["init", "-q", repo]);
      await execFileAsync("git", ["-C", repo, "config", "user.email", "agent@example.test"]);
      await execFileAsync("git", ["-C", repo, "config", "user.name", "Coding Agent"]);
      await writeFile(path.join(repo, "README.md"), "initial\n", "utf8");
      await execFileAsync("git", ["-C", repo, "add", "README.md"]);
      await execFileAsync("git", ["-C", repo, "commit", "-qm", "initial"]);
      const store = new InMemoryEventStore();
      const host = new AgentHost({ store });
      const session = await host.createSession(repo);
      const first = await host.createWorktree(session.id, { id: "feature-one", branch: "feature/one" }, "worktree-create-1");
      const repeated = await host.createWorktree(session.id, { id: "feature-one", branch: "feature/one" }, "worktree-create-1");
      expect(repeated.worktrees).toHaveLength(1);
      const createdEvents = (await host.events(session.id)).filter((event) => event.type === "worktree/created");
      expect(createdEvents).toHaveLength(1);
      const created = first.worktrees?.find((item) => item.id === "feature-one");
      expect(created?.status).toBe("clean");
      const switched = await host.switchWorktree(session.id, "feature-one", "worktree-switch-1");
      expect(switched.activeWorktreeId).toBe("feature-one");
      expect(switched.activeWorkspaceRoot).toBe(created?.path);
      await writeFile(path.join(created!.path, "dirty.txt"), "dirty\n", "utf8");
      await expect(host.cleanupWorktree(session.id, "feature-one", false, "worktree-cleanup-1")).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });
      const cleaned = await host.cleanupWorktree(session.id, "feature-one", true, "worktree-cleanup-2");
      expect(cleaned.activeWorktreeId).toBeUndefined();
      expect(cleaned.worktrees?.find((item) => item.id === "feature-one")?.status).toBe("removed");
      const restarted = new AgentHost({ store });
      expect((await restarted.getSession(session.id))?.worktrees?.find((item) => item.id === "feature-one")?.status).toBe("removed");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 15_000);

  it("recovers a pending worktree create after the Git side effect already happened", async () => {
    try { await execFileAsync("git", ["--version"]); } catch { return; }
    const parent = await mkdtemp(path.join(tmpdir(), "cra-runtime-worktree-recovery-"));
    const repo = path.join(parent, "repo");
    const linked = path.join(parent, "linked");
    try {
      await execFileAsync("git", ["init", "-q", repo]);
      await execFileAsync("git", ["-C", repo, "config", "user.email", "agent@example.test"]);
      await execFileAsync("git", ["-C", repo, "config", "user.name", "Coding Agent"]);
      await writeFile(path.join(repo, "README.md"), "initial\n", "utf8");
      await execFileAsync("git", ["-C", repo, "add", "README.md"]);
      await execFileAsync("git", ["-C", repo, "commit", "-qm", "initial"]);

      const store = new InMemoryEventStore();
      const host = new AgentHost({ store });
      const session = await host.createSession(repo);
      await store.claimCommand({ sessionId: session.id, commandId: "worktree-crash-1", kind: "create_worktree", request: { id: "recovered", branch: "feature/recovered", path: linked }, result: { status: "pending" } });
      await new GitWorktreeManager(repo).create({ id: "recovered", branch: "feature/recovered", path: linked });

      const recovered = await host.createWorktree(session.id, { id: "recovered", branch: "feature/recovered", path: linked }, "worktree-crash-1");
      expect(recovered.worktrees).toHaveLength(1);
      expect(recovered.worktrees?.[0]).toMatchObject({ id: "recovered", path: path.resolve(linked), branch: "feature/recovered", status: "clean" });
      expect((await host.events(session.id)).filter((event) => event.type === "worktree/created")).toHaveLength(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 15_000);

  it("reactively compacts once after a provider prompt-too-long and retries the same turn", async () => {
    const store = new InMemoryEventStore();
    const requests: ModelRequest[] = [];
    let agentAttempts = 0;
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        if (request.purpose === "context_summary") {
          yield { type: "text_delta", text: "Keep the review goal and unresolved findings." };
          yield { type: "done" };
          return;
        }
        agentAttempts += 1;
        if (agentAttempts === 1) {
          const error = new Error("context_length_exceeded") as Error & { status?: number; code?: string };
          error.status = 413;
          error.code = "context_length_exceeded";
          throw error;
        }
        yield { type: "text_delta", text: "Recovered after compact." };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({
      store,
      model,
      contextPolicy: { autoCompactEnabled: false, contextWindowTokens: 10_000 },
      summaryCompact: { recentMessageTokens: 1, maxSummaryChars: 200 },
    });
    const session = await host.createSession("D:/m09-reactive-fixture");
    await store.append({ sessionId: session.id, type: "user/message", payload: { content: "old context " + "x".repeat(30_000) } });
    await store.append({ sessionId: session.id, type: "assistant/message", payload: { content: "old answer", responseId: "old-response" } });
    const turn = await host.sendMessage(session.id, "continue after overflow");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect((await host.getSession(session.id))?.messages.at(-1)?.content).toBe("Recovered after compact.");
    expect(requests.filter((request) => request.purpose === "context_summary")).toHaveLength(1);
    expect(events.some((event) => event.type === "context/recovery_started" && event.payload["transitionReason"] === "reactive_compact_retry")).toBe(true);
    expect(events.some((event) => event.type === "context/recovery_transition")).toBe(true);
    expect(events.some((event) => event.type === "context/recovery_succeeded")).toBe(true);
    expect(events.find((event) => event.type === "context/recovery_succeeded")?.payload).toMatchObject({ errorClass: "prompt_too_long", providerStatus: 413, attempt: 1, requestHash: expect.stringMatching(/^ctxreq_[0-9a-f]{16}$/u) });
  });

  it("keeps recovery guard state isolated between turns", async () => {
    const first = new ContextRecoveryGuard(1, 3);
    const second = new ContextRecoveryGuard(1, 3);
    expect(first.beginReactive()).toBe(1);
    expect(second.beginReactive()).toBe(1);
    expect(first.snapshot().reactiveAttempts).toBe(1);
    expect(second.snapshot().reactiveAttempts).toBe(1);
  });

  it("serializes concurrent creates and never projects duplicate paths", async () => {
    try { await execFileAsync("git", ["--version"]); } catch { return; }
    const parent = await mkdtemp(path.join(tmpdir(), "cra-runtime-worktree-lock-"));
    const repo = path.join(parent, "repo");
    const linked = path.join(parent, "linked");
    try {
      await execFileAsync("git", ["init", "-q", repo]);
      await execFileAsync("git", ["-C", repo, "config", "user.email", "agent@example.test"]);
      await execFileAsync("git", ["-C", repo, "config", "user.name", "Coding Agent"]);
      await writeFile(path.join(repo, "README.md"), "initial\n", "utf8");
      await execFileAsync("git", ["-C", repo, "add", "README.md"]);
      await execFileAsync("git", ["-C", repo, "commit", "-qm", "initial"]);
      const host = new AgentHost({ store: new InMemoryEventStore() });
      const session = await host.createSession(repo);
      const results = await Promise.allSettled([
        host.createWorktree(session.id, { id: "lock-one", branch: "feature/lock", path: linked }, "worktree-lock-1"),
        host.createWorktree(session.id, { id: "lock-two", branch: "feature/lock", path: linked }, "worktree-lock-2"),
      ]);
      expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      expect(results.find((item) => item.status === "rejected")?.reason).toMatchObject({ code: "WORKTREE_EXISTS" });
      expect((await host.getSession(session.id))?.worktrees).toHaveLength(1);
      expect((await host.events(session.id)).filter((event) => event.type === "worktree/created")).toHaveLength(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 15_000);

  it("runs M11 session memory extraction in an isolated background adapter", async () => {
    const store = new InMemoryEventStore();
    let saved: { content: string; lastSummarizedMessageId?: string; updatedAt?: string } | undefined;
    const requests: Array<{ sessionId: string; canUseParentTools: false; canWriteWorkspace: false }> = [];
    const model: ChatModel = {
      async *stream(): AsyncIterable<ModelStreamPart> {
        yield { type: "text_delta", text: "memory extraction trigger" };
        yield { type: "done" };
      },
    };
    const host = new AgentHost({
      store,
      model,
      sessionMemory: {
        get: async () => saved,
        save: async (_sessionId, snapshot) => { saved = snapshot; },
        memoryPath: async () => "D:/memory/session.md",
      },
      sessionMemoryExtraction: { minimumMessageTokensToInit: 1, minimumTokensBetweenUpdate: 1, toolCallsBetweenUpdates: 1 },
      sessionMemoryExtractor: {
        async extract(request) {
          requests.push({ sessionId: request.sessionId, canUseParentTools: request.capabilities.canUseParentTools, canWriteWorkspace: request.capabilities.canWriteWorkspace });
          return { snapshot: { content: "Preserve the current review goal", ...(request.sourceMessageId === undefined ? {} : { lastSummarizedMessageId: request.sourceMessageId }) }, tokensAtExtraction: request.estimatedTokens };
        },
      },
    });
    const session = await host.createSession("D:/m11-memory-fixture");
    const turn = await host.sendMessage(session.id, "capture this session");
    await host.waitForTurn(turn);
    await host.waitForSessionMemoryExtraction(session.id);
    const events = await host.events(session.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ canUseParentTools: false, canWriteWorkspace: false });
    expect(saved?.content).toContain("current review goal");
    expect(events.some((event) => event.type === "context/session_memory_extraction_started")).toBe(true);
    expect(events.some((event) => event.type === "context/session_memory_extraction_completed")).toBe(true);
    expect((await host.getSession(session.id))?.contextSessionMemory).toMatchObject({ status: "completed", initialized: true });
    expect(JSON.stringify(events.find((event) => event.type === "context/session_memory_extraction_completed"))).not.toContain("current review goal");
  });

  it("keeps the completed main turn successful when memory extraction fails", async () => {
    const store = new InMemoryEventStore();
    const host = new AgentHost({
      store,
      sessionMemory: { get: async () => undefined, save: async () => undefined },
      sessionMemoryExtraction: { minimumMessageTokensToInit: 1, minimumTokensBetweenUpdate: 1 },
      sessionMemoryExtractor: { async extract() { throw new Error("extractor offline"); } },
    });
    const session = await host.createSession("D:/m11-failure-fixture");
    const turn = await host.sendMessage(session.id, "finish despite extraction failure");
    await host.waitForTurn(turn);
    await host.waitForSessionMemoryExtraction(session.id);
    const events = await host.events(session.id);
    expect(events.find((event) => event.type === "turn/ended")?.payload["status"]).toBe("completed");
    expect(events.some((event) => event.type === "context/session_memory_extraction_failed")).toBe(true);
    expect(events.some((event) => event.type === "agent/error")).toBe(false);
  });

  it("loads bounded Project Memory, recalls relevant topics, and records metadata without正文", async () => {
    const store = new InMemoryEventStore();
    const requests: string[] = [];
    const modelRequests: ModelRequest[] = [];
    const host = new AgentHost({
      store,
      model: {
        async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
          modelRequests.push(request);
          yield { type: "text_delta", text: "memory checked" };
          yield { type: "done" };
        },
      },
      projectMemory: {
        async getEntrypoint(scope) { requests.push(`entry:${scope.scopeKey}`); return { content: "# Index\n- [Deploy](topics/deploy.md) — release procedure" }; },
        async listTopics(scope) { requests.push(`list:${scope.scopeKey}`); return [{ id: "topics/deploy.md", path: "topics/deploy.md", title: "Deploy", description: "release procedure", type: "project", content: "Deploy with pnpm." }]; },
        async readTopic(scope, id) { requests.push(`read:${scope.scopeKey}:${id}`); return id === "topics/deploy.md" ? { id, path: id, title: "Deploy", description: "release procedure", type: "project", content: "Deploy with pnpm." } : undefined; },
      },
    });
    const session = await host.createSession("D:/m12-project-memory");
    const turn = await host.sendMessage(session.id, "review the deploy release flow");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(requests.some((value) => value.startsWith("entry:pm_"))).toBe(true);
    expect(events.some((event) => event.type === "context/project_memory_loaded")).toBe(true);
    expect(events.some((event) => event.type === "context/project_memory_recalled")).toBe(true);
    expect(JSON.stringify(events.filter((event) => event.type.startsWith("context/project_memory")))).not.toContain("Deploy with pnpm.");
    const system = modelRequests[0]?.messages.find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain("# Project Memory");
    expect(modelRequests[0]?.messages.some((message) => message.content.includes("Deploy with pnpm."))).toBe(true);
    expect((await host.getSession(session.id))?.contextProjectMemory).toMatchObject({ status: "recalled", recalledTopicIds: ["topics/deploy.md"], ignored: false });
  });

  it("does not load Project Memory when the user explicitly asks to ignore it", async () => {
    const store = new InMemoryEventStore();
    let calls = 0;
    const host = new AgentHost({
      store,
      projectMemory: {
        async getEntrypoint() { calls += 1; return { content: "memory" }; },
        async listTopics() { calls += 1; return []; },
        async readTopic() { calls += 1; return undefined; },
      },
    });
    const session = await host.createSession("D:/m12-ignore");
    const turn = await host.sendMessage(session.id, "ignore project memory and answer normally");
    await host.waitForTurn(turn);
    expect(calls).toBe(0);
    const events = await host.events(session.id);
    expect(events.some((event) => event.type === "context/project_memory_disabled")).toBe(true);
    expect((await host.getSession(session.id))?.contextProjectMemory).toMatchObject({ status: "disabled", ignored: true, reason: "user_requested_ignore" });
  });

  it("validates recalled memory against the scoped workspace and excludes stale topics", async () => {
    const store = new InMemoryEventStore();
    const host = new AgentHost({
      store,
      projectMemory: {
        async getEntrypoint() { return { content: "memory" }; },
        async listTopics() { return [{ id: "old", path: "topics/old.md", title: "Deploy", description: "release", type: "feedback", content: "old advice", references: [{ kind: "path", value: "missing.ts" }] }]; },
        async readTopic(_scope, id) { return id === "old" ? { id, path: "topics/old.md", title: "Deploy", description: "release", type: "feedback", content: "old advice", references: [{ kind: "path", value: "missing.ts" }] } : undefined; },
      },
      projectMemoryValidation: { pathExists: async () => false },
    });
    const session = await host.createSession("D:/m12-stale");
    const turn = await host.sendMessage(session.id, "review deploy release");
    await host.waitForTurn(turn);
    const events = await host.events(session.id);
    expect(events.some((event) => event.type === "context/project_memory_stale")).toBe(true);
    expect(events.some((event) => event.type === "context/project_memory_recalled")).toBe(false);
  });
});
