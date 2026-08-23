import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InMemoryEventStore, replayProjection, SqliteEventStore } from "./index.js";
import { brand } from "@code-review-agent/contracts";

describe("InMemoryEventStore", () => {
  it("assigns monotonic session-local sequences and projects messages", async () => {
    const store = new InMemoryEventStore();
    const sessionId = await store.createSession("D:/workspace");
    await store.append({ sessionId, type: "user/message", payload: { content: "hello" } });
    await store.append({ sessionId, type: "assistant/message", payload: { content: "hi" } });
    const events = await store.list(sessionId);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect((await store.list(sessionId, 2)).map((event) => event.type)).toEqual(["assistant/message"]);
    expect((await store.project(sessionId))?.messages.map((message) => message.content)).toEqual(["hello", "hi"]);
  });

  it("isolates unknown sessions", async () => {
    const store = new InMemoryEventStore();
    const unknown = brand<string, "SessionId">("missing");
    expect(await store.list(unknown)).toEqual([]);
    expect(await store.project(unknown)).toBeUndefined();
  });

  it("serves bounded latest and older pages without changing the full replay contract", async () => {
    const store = new InMemoryEventStore();
    const sessionId = await store.createSession("D:/workspace");
    for (let index = 0; index < 6; index += 1) await store.append({ sessionId, type: "session/updated", payload: { index } });
    const latest = await store.listPage!(sessionId, { limit: 3 });
    expect(latest.events.map((event) => event.sequence)).toEqual([5, 6, 7]);
    expect(latest.hasMoreBefore).toBe(true);
    const older = await store.listPage!(sessionId, { ...(latest.oldestSequence === undefined ? {} : { beforeSequence: latest.oldestSequence }), limit: 3 });
    expect(older.events.map((event) => event.sequence)).toEqual([2, 3, 4]);
    expect(older.hasMoreBefore).toBe(true);
    expect((await store.list(sessionId)).map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("replays tool and permission audit state", async () => {
    const store = new InMemoryEventStore(); const sessionId = await store.createSession("D:/workspace"); const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await store.append({ sessionId, type: "tool/call", payload: { toolCallId: "tool_fixture", name: "write_file", input: { path: "a.txt" }, riskLevel: "write", approvalMode: "ask", caller: "agent", workspaceRoot: "D:/workspace" } });
    await store.append({ sessionId, type: "permission/requested", payload: { permissionId: "perm_fixture", toolCallId: "tool_fixture", toolName: "write_file", riskLevel: "write", reason: "approval", caller: "agent", workspaceRoot: "D:/workspace", expiresAt } });
    await store.append({ sessionId, type: "permission/resolved", payload: { permissionId: "perm_fixture", toolCallId: "tool_fixture", status: "expired" } });
    await store.append({ sessionId, type: "tool/result", payload: { toolCallId: "tool_fixture", status: "denied", result: { ok: false, error: { code: "PERMISSION_EXPIRED", message: "expired" } } } });
    const projection = await store.project(sessionId); expect(projection?.toolCalls[0]).toMatchObject({ status: "denied", caller: "agent", workspaceRoot: "D:/workspace", result: { error: { code: "PERMISSION_EXPIRED" } } }); expect(projection?.permissions[0]).toMatchObject({ status: "expired", expiresAt });
  });

  it("projects plan, todo, and user interaction state from events", async () => {
    const store = new InMemoryEventStore(); const sessionId = await store.createSession("D:/workspace");
    await store.append({ sessionId, type: "plan/updated", payload: { content: "Read then edit", status: "active" } });
    await store.append({ sessionId, type: "todo/updated", payload: { todos: [{ id: "todo_1", content: "Read", status: "completed" }, { id: "todo_2", content: "Edit", status: "pending" }] } });
    await store.append({ sessionId, type: "interaction/requested", payload: { interactionId: "interaction_1", toolCallId: "tool_1", question: "Continue?", options: [{ label: "Yes", value: "yes" }], allowFreeform: false, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    await store.append({ sessionId, type: "interaction/resolved", payload: { interactionId: "interaction_1", toolCallId: "tool_1", question: "Continue?", status: "answered", answer: "yes" } });
    const projection = await store.project(sessionId);
    expect(projection?.plan).toMatchObject({ content: "Read then edit", status: "active" }); expect(projection?.todos).toHaveLength(2); expect(projection?.interactions[0]).toMatchObject({ status: "answered", answer: "yes" });
  });

  it("projects durable goal lifecycle state", async () => {
    const store = new InMemoryEventStore(); const sessionId = await store.createSession("D:/workspace");
    await store.append({ sessionId, type: "goal/created", payload: { goalId: "goal_1", title: "Ship phase", successCriteria: ["Tests pass"], status: "active" } });
    await store.append({ sessionId, type: "goal/ended", payload: { goalId: "goal_1", status: "completed", result: { tests: "pass" } } });
    expect((await store.project(sessionId))?.goals[0]).toMatchObject({ id: "goal_1", title: "Ship phase", status: "completed", successCriteria: ["Tests pass"], result: { tests: "pass" } });
  });

  it("persists events, projections, commands, and schema across reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "code-review-agent-"));
    const databasePath = join(directory, "agent.sqlite");
    const first = new SqliteEventStore({ databasePath });
    const sessionId = await first.createSession("D:/workspace");
    const turnId = brand<string, "TurnId">("turn_fixture");
    await first.append({ sessionId, turnId, type: "user/message", payload: { content: "hello" } });
    await first.append({ sessionId, turnId, type: "turn/queued", payload: {} });
    await first.append({ sessionId, type: "queue/changed", payload: { queuedTurnIds: [turnId] } });
    await first.append({ sessionId, type: "task/created", payload: { taskId: "task_fixture", title: "inspect" } });
    const claim = await first.claimCommand({ sessionId, commandId: "cmd-1", kind: "send_message", request: { content: "hello" }, result: { turnId } });
    expect(claim.created).toBe(true);
    expect((await first.claimCommand({ sessionId, commandId: "cmd-1", kind: "send_message", request: { content: "hello" }, result: { turnId } })).created).toBe(false);
    const before = await first.project(sessionId);
    expect(before?.turns[0]?.userMessage).toBe("hello");
    expect(before?.tasks[0]?.title).toBe("inspect");
    const fixture = await first.list(sessionId);
    const latestPage = await first.listPage!(sessionId, { limit: 2 });
    expect(latestPage.events.map((event) => event.sequence)).toEqual([4, 5]);
    expect(latestPage.hasMoreBefore).toBe(true);
    expect((await first.listPage!(sessionId, { ...(latestPage.oldestSequence === undefined ? {} : { beforeSequence: latestPage.oldestSequence }), limit: 2 })).events.map((event) => event.sequence)).toEqual([2, 3]);
    first.close();
    const corrupted = new DatabaseSync(databasePath);
    corrupted.prepare("UPDATE projections SET projection_json = ? WHERE session_id = ?").run(JSON.stringify({ broken: true }), sessionId);
    corrupted.close();

    const second = new SqliteEventStore({ databasePath });
    expect((await second.list(sessionId)).map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect((await second.project(sessionId))?.turns[0]?.queuePosition).toBe(1);
    expect(await second.project(sessionId)).toEqual(before);
    const rebuilt = replayProjection(
      { ...before!, messages: [], turns: [], tasks: [], status: "idle", lastSequence: 0 },
      fixture,
    );
    expect(rebuilt).toEqual(before);
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("marks an in-flight session interrupted after reopening", async () => {
    const directory = mkdtempSync(join(tmpdir(), "code-review-agent-recovery-"));
    const databasePath = join(directory, "agent.sqlite");
    const first = new SqliteEventStore({ databasePath });
    const sessionId = await first.createSession("D:/workspace");
    const turnId = brand<string, "TurnId">("turn_running");
    await first.append({ sessionId, turnId, type: "user/message", payload: { content: "running" } });
    await first.append({ sessionId, turnId, type: "turn/started", payload: {} });
    first.close();

    const second = new SqliteEventStore({ databasePath });
    const events = await second.list(sessionId, 2);
    expect(events.at(-1)?.type).toBe("agent/status");
    expect(events.at(-1)?.payload["status"]).toBe("interrupted");
    expect((await second.project(sessionId))?.status).toBe("interrupted");
    expect((await second.project(sessionId))?.turns[0]?.status).toBe("interrupted");
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps session sequences monotonic under concurrent appends", async () => {
    const store = new SqliteEventStore(":memory:");
    const sessionId = await store.createSession("D:/workspace");
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.append({ sessionId, type: "session/updated", payload: { index } })));
    expect((await store.list(sessionId)).map((event) => event.sequence)).toEqual(Array.from({ length: 21 }, (_, index) => index + 1));
    store.close();
  });

  it("persists scrubbed scoped MCP configuration and credential references", () => {
    const directory = mkdtempSync(join(tmpdir(), "code-review-agent-mcp-config-"));
    const databasePath = join(directory, "agent.sqlite");
    const first = new SqliteEventStore({ databasePath });
    const stored = first.upsertMcpConfig({
      name: "review-server",
      scope: "project",
      ownerId: "owner-1",
      workspaceRoot: "D:/workspace",
      enabled: true,
      revision: 7,
      credentialRef: { id: "cred-1", kind: "oauth", label: "Review OAuth" },
      config: { transport: "streamable-http", url: "https://example.test/mcp", headers: { "x-safe": "ok" } },
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:01.000Z",
    });
    expect(stored.revision).toBe(7);
    expect(first.listMcpConfigs()).toEqual([stored]);
    first.close();
    const second = new SqliteEventStore({ databasePath });
    expect(second.listMcpConfigs()).toEqual([stored]);
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
