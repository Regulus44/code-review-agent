import { describe, expect, it } from "vitest";
import { brand, type TaskId } from "@coding-agent/contracts";
import { InMemoryEventStore, SqliteEventStore } from "@coding-agent/storage";
import { DescriptorError, foldSubagentDescriptor, snapshotDescriptor } from "./descriptor.js";
import { SubagentRuntime, type ProviderRun, type SubagentProvider } from "./runtime.js";

function provider(): SubagentProvider {
  return {
    name: "in-process",
    capabilities: { oneShot: true, continuable: false, outputSchema: true, toolFilter: true },
    async start(request, context): Promise<ProviderRun> {
      await context.appendEvent("subagent/start", { taskId: context.taskId, promptLength: request.prompt.length });
      return {
        result: async () => ({ taskId: context.taskId, childSessionId: context.childSessionId, status: "completed", stopReason: "completed", summary: `done: ${request.prompt}`, output: { ok: true }, artifacts: [] }),
        dispose: async () => undefined,
      };
    },
  };
}

function continuableProvider(log: string[]): SubagentProvider {
  return {
    name: "continuable",
    capabilities: { oneShot: false, continuable: true, outputSchema: false, toolFilter: true },
    async start(request, context): Promise<ProviderRun> {
      return {
        result: async () => ({ taskId: context.taskId, childSessionId: context.childSessionId, status: "completed", stopReason: "completed", summary: `initial: ${request.prompt}`, artifacts: [] }),
        sendMessage: async (prompt) => { log.push(prompt); return { taskId: context.taskId, childSessionId: context.childSessionId, status: "partial", summary: `followup: ${prompt}`, artifacts: [] }; },
        interrupt: async () => { log.push("interrupt"); },
        dispose: async () => undefined,
      };
    },
    resume: async (descriptor, context) => ({
      result: async () => ({ taskId: context.taskId, childSessionId: context.childSessionId, status: "completed", summary: "resumed", artifacts: [] }),
      sendMessage: async (prompt) => { log.push(prompt); return { taskId: context.taskId, childSessionId: context.childSessionId, status: "partial", summary: `resumed: ${prompt}`, artifacts: [] }; },
      dispose: async () => undefined,
    }),
  };
}

describe("phase 5 subagent contracts", () => {
  it("snapshots an immutable descriptor and rejects unknown fields", () => {
    const descriptor = snapshotDescriptor({ mode: "continuable", provider: "in-process", label: "child", parentSessionId: brand<string, "SessionId">("parent"), childSessionId: brand<string, "SessionId">("child"), workspaceRoot: "D:/workspace", permissionPreset: "read-only", delegationDepth: 1 });
    expect(descriptor.version).toBe(1);
    expect(() => snapshotDescriptor({ ...descriptor, extra: true } as never)).toThrowError(DescriptorError);
    expect(foldSubagentDescriptor([{ eventId: "e", sequence: 1, schemaVersion: 1, sessionId: descriptor.childSessionId, type: "subagent/descriptor", createdAt: new Date().toISOString(), payload: { descriptor } }])).toEqual(descriptor);
  });

  it("persists parent/child metadata and task projection across SQLite reopen", async () => {
    const store = new SqliteEventStore(":memory:");
    const parent = await store.createSession("D:/workspace", "read-only");
    const child = brand<string, "SessionId">("child_fixture");
    const task = brand<string, "TaskId">("task_fixture");
    await store.createChildSession({ id: child, workspaceRoot: "D:/workspace", permissionPreset: "read-only", metadata: { parentSessionId: parent, parentTaskId: task, childMode: "continuable", childProvider: "in-process", delegationDepth: 1 } });
    await store.append({ sessionId: parent, type: "task/created", payload: { taskId: task, childSessionId: child, parentSessionId: parent, mode: "continuable", provider: "in-process", title: "fixture" } });
    await store.append({ sessionId: parent, type: "task/ended", payload: { taskId: task, status: "completed" } });
    expect((await store.listChildSessions(parent))[0]).toMatchObject({ id: child, parentSessionId: parent, parentTaskId: task, childMode: "continuable" });
    expect((await store.listTasks(parent))[0]).toMatchObject({ id: task, childSessionId: child, status: "completed", artifacts: [] });
    store.close();
  });

  it("runs foreground and background one-shot children with distinct task reports", async () => {
    const store = new InMemoryEventStore();
    const parent = await store.createSession("D:/workspace", "read-only");
    const runtime = new SubagentRuntime({ store, providers: [provider()] });
    const foreground = await runtime.spawn({ parentSessionId: parent, prompt: "foreground", workspaceRoot: "D:/workspace", permissionPreset: "read-only" });
    expect(foreground.report?.summary).toBe("done: foreground");
    const background = await runtime.spawn({ parentSessionId: parent, prompt: "background", background: true, workspaceRoot: "D:/workspace", permissionPreset: "read-only" });
    expect(background.report).toBeUndefined();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const task = await runtime.taskQuery(parent, background.taskId);
      if (task?.report !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect((await runtime.taskOutput(parent, background.taskId))?.report?.summary).toBe("done: background");
  });

  it("detects sequence gaps before rebuilding a child fixture", async () => {
    const { assertContiguousSequence } = await import("./projection.js");
    const session = brand<string, "SessionId">("child");
    const event = (sequence: number) => ({ eventId: `e${sequence}`, sequence, schemaVersion: 1 as const, sessionId: session, type: "subagent/descriptor" as const, createdAt: new Date().toISOString(), payload: {} });
    expect(() => assertContiguousSequence([event(1), event(3)])).toThrow("EVENT_SEQUENCE_GAP");
  });

  it("keeps continuable inbox FIFO, derives direct-parent reports, and preserves queued messages on interrupt", async () => {
    const store = new InMemoryEventStore();
    const parent = await store.createSession("D:/workspace", "read-only");
    const log: string[] = [];
    const runtime = new SubagentRuntime({ store, providers: [continuableProvider(log)] });
    const receipt = await runtime.spawn({ parentSessionId: parent, prompt: "start", mode: "continuable", provider: "continuable", workspaceRoot: "D:/workspace", permissionPreset: "read-only", toolAllowlist: [], mcpAllowlist: [] });
    await runtime.sendMessage(parent, receipt.taskId, "one");
    await runtime.sendMessage(parent, receipt.taskId, "two");
    await runtime.interrupt(parent, receipt.taskId);
    for (let attempt = 0; attempt < 20 && log.filter((item) => item === "one" || item === "two").length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(log.filter((item) => item === "one" || item === "two")).toEqual(["one", "two"]);
    const child = receipt.childSessionId;
    const reported = await runtime.report(child, { summary: "intermediate finding", delivery: "wakeup" });
    expect(reported.parentSessionId).toBe(parent);
    expect((await store.project(parent))?.tasks.find((task) => task.id === receipt.taskId)).toMatchObject({ status: "waiting", report: { summary: "intermediate finding" } });
    expect((await store.list(child)).some((event) => event.type === "subagent/settlement")).toBe(true);
  });
});
