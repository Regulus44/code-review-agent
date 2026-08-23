import { describe, expect, it } from "vitest";
import type { ChatModel, InteractionId, ModelRequest, ModelStreamPart, PermissionId, ToolDefinition } from "@code-review-agent/contracts";
import { InMemoryEventStore } from "@code-review-agent/storage";
import { createBuiltinTools, DefaultPermissionPolicy, ToolRegistry, ToolRuntime } from "@code-review-agent/tools";
import { AgentHost } from "./index.js";

describe("AgentHost", () => {
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
});
