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

  it("replays tool and permission audit state", async () => {
    const store = new InMemoryEventStore(); const sessionId = await store.createSession("D:/workspace"); const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await store.append({ sessionId, type: "tool/call", payload: { toolCallId: "tool_fixture", name: "write_file", input: { path: "a.txt" }, riskLevel: "write", approvalMode: "ask", caller: "agent", workspaceRoot: "D:/workspace" } });
    await store.append({ sessionId, type: "permission/requested", payload: { permissionId: "perm_fixture", toolCallId: "tool_fixture", toolName: "write_file", riskLevel: "write", reason: "approval", caller: "agent", workspaceRoot: "D:/workspace", expiresAt } });
    await store.append({ sessionId, type: "permission/resolved", payload: { permissionId: "perm_fixture", toolCallId: "tool_fixture", status: "expired" } });
    await store.append({ sessionId, type: "tool/result", payload: { toolCallId: "tool_fixture", status: "denied", result: { ok: false, error: { code: "PERMISSION_EXPIRED", message: "expired" } } } });
    const projection = await store.project(sessionId); expect(projection?.toolCalls[0]).toMatchObject({ status: "denied", caller: "agent", workspaceRoot: "D:/workspace", result: { error: { code: "PERMISSION_EXPIRED" } } }); expect(projection?.permissions[0]).toMatchObject({ status: "expired", expiresAt });
  });

  it("persists events, projections, commands, and schema across reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "code-review-agent-"));
    const databasePath = join(directory, "agent.sqlite");
    const first = new SqliteEventStore({ databasePath });
    const sessionId = await first.createSession("D:/workspace");
    const turnId = brand<string, "TurnId">("turn_fixture");
    await first.append({ sessionId, turnId, type: "user/message", payload: { content: "hello" } });
    await first.append({ sessionId, turnId, type: "turn/queued", payload: {} });
    await first.append({ sessionId, type: "task/created", payload: { taskId: "task_fixture", title: "inspect" } });
    const claim = await first.claimCommand({ sessionId, commandId: "cmd-1", kind: "send_message", request: { content: "hello" }, result: { turnId } });
    expect(claim.created).toBe(true);
    expect((await first.claimCommand({ sessionId, commandId: "cmd-1", kind: "send_message", request: { content: "hello" }, result: { turnId } })).created).toBe(false);
    const before = await first.project(sessionId);
    expect(before?.turns[0]?.userMessage).toBe("hello");
    expect(before?.tasks[0]?.title).toBe("inspect");
    const fixture = await first.list(sessionId);
    first.close();
    const corrupted = new DatabaseSync(databasePath);
    corrupted.prepare("UPDATE projections SET projection_json = ? WHERE session_id = ?").run(JSON.stringify({ broken: true }), sessionId);
    corrupted.close();

    const second = new SqliteEventStore({ databasePath });
    expect((await second.list(sessionId)).map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
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
});
