import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "./server.js";
import { InMemoryEventStore } from "@code-review-agent/storage";
import { sessionId } from "@code-review-agent/runtime";
import { DEEPSEEK_MODELS, OpenAICompatibleChatModel } from "@code-review-agent/llm";
import { SubagentRuntime } from "@code-review-agent/subagent";
import { createDelegationFixtureProvider, seedDelegationFixture } from "./fixtures/delegation.js";

describe("Phase 2 API", () => {
  let server: Server;
  let baseUrl: string;
  const store = new InMemoryEventStore();

  beforeAll(async () => {
    server = createApiServer({ store });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("API did not bind to a TCP port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("creates a session, streams a turn, and serves the web shell", async () => {
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/workspace" }),
    });
    const session = (await created.json()) as { id: string };
    const sent = await fetch(`${baseUrl}/v1/sessions/${session.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(sent.status).toBe(202);
    let projection: { status: string; messages: { content: string }[] };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      projection = (await (await fetch(`${baseUrl}/v1/sessions/${session.id}`)).json()) as typeof projection;
      if (projection.status === "idle" && projection.messages.some((message) => message.content === "Echo: hello")) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(projection!.messages.at(-1)?.content).toBe("Echo: hello");
    const shell = await fetch(`${baseUrl}/`);
    expect(await shell.text()).toContain("Code Review Agent");
  });

  it("serves latest and older event pages while keeping unpaged JSON replay compatible", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/workspace/paging" }) });
    const session = await created.json() as { id: string };
    for (let index = 0; index < 5; index += 1) await store.append({ sessionId: sessionId(session.id), type: "session/updated", payload: { index } });
    const latestResponse = await fetch(`${baseUrl}/v1/sessions/${session.id}/events?format=json&limit=3`);
    const latest = await latestResponse.json() as { events: { sequence: number }[]; hasMoreBefore: boolean; oldestSequence: number };
    expect(latest.events.map((event) => event.sequence)).toEqual([4, 5, 6]);
    expect(latest.hasMoreBefore).toBe(true);
    const olderResponse = await fetch(`${baseUrl}/v1/sessions/${session.id}/events?format=json&before_sequence=${latest.oldestSequence}&limit=3`);
    const older = await olderResponse.json() as { events: { sequence: number }[]; hasMoreBefore: boolean };
    expect(older.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(older.hasMoreBefore).toBe(false);
    const full = await (await fetch(`${baseUrl}/v1/sessions/${session.id}/events?format=json`)).json() as { sequence: number }[];
    expect(full.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("exposes durable subagent catalog, task output, cancel, and scoped replay", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/workspace", permissionPreset: "read-only" }) });
    const session = await created.json() as { id: string };
    const spawned = await fetch(`${baseUrl}/v1/sessions/${session.id}/subagents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "child fixture", mode: "one-shot", background: false, permissionPreset: "read-only", toolAllowlist: [], mcpAllowlist: [] }) });
    expect(spawned.status).toBe(200);
    const receipt = await spawned.json() as { taskId: string; childSessionId: string; report?: { summary: string } };
    expect(receipt.report?.summary).toContain("Echo: child fixture");
    const catalog = await (await fetch(`${baseUrl}/v1/sessions/${session.id}/subagents`)).json() as { agents: { task: { id: string; childSessionId?: string; status: string } }[] };
    expect(catalog.agents.some((entry) => entry.task.id === receipt.taskId && entry.task.childSessionId === receipt.childSessionId)).toBe(true);
    const output = await (await fetch(`${baseUrl}/v1/sessions/${session.id}/tasks/${receipt.taskId}/output`)).json() as { report?: { summary: string } };
    expect(output.report?.summary).toContain("Echo: child fixture");
    const scoped = await (await fetch(`${baseUrl}/v1/sessions/${session.id}/subagents/events?format=json`)).json() as { sessionId: string; event: { type: string } }[];
    expect(scoped.some((entry) => entry.sessionId === receipt.childSessionId && entry.event.type === "subagent/descriptor")).toBe(true);
  });

  it("replays a non-empty isolated delegation fixture and prevents sibling task history access", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-review-agent-delegation-fixture-"));
    const childCompletedRoot = join(root, "completed-child");
    const childCancellableRoot = join(root, "cancellable-child");
    const siblingRoot = join(root, "sibling");
    const fixtureStore = new InMemoryEventStore();
    const fixtureRuntime = new SubagentRuntime({ store: fixtureStore });
    fixtureRuntime.registerProvider(createDelegationFixtureProvider({ store: fixtureStore }));
    const fixtureServer = createApiServer({ store: fixtureStore, subagentRuntime: fixtureRuntime });
    await new Promise<void>((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
    try {
      const address = fixtureServer.address();
      if (address === null || typeof address === "string") throw new Error("Delegation fixture API did not bind");
      const url = `http://127.0.0.1:${address.port}`;
      const parent = await (await fetch(`${url}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: root, permissionPreset: "read-only" }) })).json() as { id: string };
      const sibling = await (await fetch(`${url}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: siblingRoot, permissionPreset: "read-only" }) })).json() as { id: string };
      const seeded = await seedDelegationFixture({ store: fixtureStore, runtime: fixtureRuntime, parentSessionId: sessionId(parent.id), workspaceRoot: root, completedWorkspaceRoot: childCompletedRoot, cancellableWorkspaceRoot: childCancellableRoot, commandPrefix: "api-delegation-fixture" });

      const catalog = await (await fetch(`${url}/v1/sessions/${parent.id}/subagents?scope=children`)).json() as { agents: { task: { id: string; status: string; childSessionId?: string; workspaceRoot?: string; permissionPreset?: string; report?: { summary: string; artifacts: { id: string }[] }; artifacts: { id: string }[] }; live: boolean; resumable: boolean }[] };
      const completed = catalog.agents.find((entry) => entry.task.id === seeded.completed.taskId);
      const cancellable = catalog.agents.find((entry) => entry.task.id === seeded.cancellable.taskId);
      expect(completed?.task.status).toBe("completed");
      expect(completed?.task.childSessionId).toBe(seeded.completed.childSessionId);
      expect(completed?.task.workspaceRoot).toBe(childCompletedRoot);
      expect(completed?.task.permissionPreset).toBe("read-only");
      expect(completed?.task.report?.summary).toContain("Fixture completed");
      expect(completed?.task.artifacts).toHaveLength(1);
      expect(completed?.live).toBe(false);
      expect(cancellable?.live).toBe(true);
      expect(cancellable?.task.childSessionId).toBe(seeded.cancellable.childSessionId);

      const childProjection = await (await fetch(`${url}/v1/sessions/${seeded.completed.childSessionId}`)).json() as { parentSessionId?: string; workspaceRoot: string; permissionPreset: string; messages: { role: string; content: string }[] };
      expect(childProjection).toMatchObject({ parentSessionId: parent.id, workspaceRoot: childCompletedRoot, permissionPreset: "read-only" });
      expect(childProjection.messages.some((message) => message.role === "user" && message.content.includes("fixture:completed"))).toBe(true);
      expect(childProjection.messages.some((message) => message.role === "assistant" && message.content.includes("Fixture completed"))).toBe(true);

      const output = await (await fetch(`${url}/v1/sessions/${parent.id}/tasks/${seeded.completed.taskId}/output`)).json() as { report?: { summary: string; artifacts: { id: string }[] }; events: { type: string; payload: Record<string, unknown> }[] };
      expect(output.report?.summary).toContain("Fixture completed");
      expect(output.report?.artifacts).toHaveLength(1);
      expect(output.events.length).toBeGreaterThan(4);
      expect(output.events.some((event) => event.type === "user/message")).toBe(true);
      expect(output.events.some((event) => event.type === "assistant/message")).toBe(true);

      const descriptor = output.events.find((event) => event.type === "subagent/descriptor")?.payload["descriptor"] as { workspaceRoot?: string; permissionPreset?: string; toolAllowlist?: string[]; mcpAllowlist?: string[] } | undefined;
      expect(descriptor).toMatchObject({ workspaceRoot: childCompletedRoot, permissionPreset: "read-only", toolAllowlist: ["read_file"], mcpAllowlist: [] });

      const parentEvents = await (await fetch(`${url}/v1/sessions/${parent.id}/events?format=json`)).json() as { sequence: number; type: string }[];
      const reportEvent = parentEvents.find((event) => event.type === "task/report");
      expect(reportEvent).toBeDefined();
      const replayed = await (await fetch(`${url}/v1/sessions/${parent.id}/events?format=json&after_sequence=${Math.max(0, (reportEvent?.sequence ?? 1) - 1)}`)).json() as { sequence: number; type: string }[];
      expect(replayed.some((event) => event.type === "task/report")).toBe(true);
      const scoped = await (await fetch(`${url}/v1/sessions/${parent.id}/subagents/events?format=json`)).json() as { sessionId: string; event: { type: string } }[];
      expect(scoped.some((entry) => entry.sessionId === seeded.completed.childSessionId && entry.event.type === "assistant/message")).toBe(true);
      expect(scoped.some((entry) => entry.sessionId === seeded.cancellable.childSessionId && entry.event.type === "subagent/descriptor")).toBe(true);

      const forbidden = await fetch(`${url}/v1/sessions/${sibling.id}/tasks/${seeded.completed.taskId}/output`);
      expect(forbidden.status, await forbidden.text()).toBe(404);

      const cancelled = await fetch(`${url}/v1/sessions/${parent.id}/tasks/${seeded.cancellable.taskId}/cancel`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "api-delegation-fixture-cancel" }, body: "{}" });
      expect(cancelled.status).toBe(200);
      let cancelledTask: { status: string } | undefined;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const current = await (await fetch(`${url}/v1/sessions/${parent.id}/tasks/${seeded.cancellable.taskId}`)).json() as { status: string };
        cancelledTask = current;
        if (current.status === "cancelled") break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(cancelledTask?.status).toBe("cancelled");
      const afterCancel = await (await fetch(`${url}/v1/sessions/${parent.id}/subagents?scope=children`)).json() as { agents: { task: { id: string; status: string }; live: boolean }[] };
      const cancelledEntry = afterCancel.agents.find((entry) => entry.task.id === seeded.cancellable.taskId);
      expect(cancelledEntry).toMatchObject({ task: { status: "cancelled" }, live: false });
    } finally {
      await new Promise<void>((resolve, reject) => fixtureServer.close((error) => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates a local workspace directory before creating a session", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-review-agent-workspace-"));
    try {
      const valid = await fetch(`${baseUrl}/v1/workspaces/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceRoot: root }),
      });
      expect(valid.status).toBe(200);
      expect(await valid.json()).toMatchObject({ valid: true, workspaceRoot: root, isGitRepository: false });

      const invalid = await fetch(`${baseUrl}/v1/workspaces/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceRoot: join(root, "missing") }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: "workspaceRoot directory does not exist or is not accessible" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists scoped MCP settings and exposes catalog diagnostics without secrets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "code-review-agent-api-mcp-"));
    const databasePath = join(directory, "agent.sqlite");
    let owned: Server | undefined;
    try {
      owned = createApiServer({ databasePath });
      await new Promise<void>((resolve) => owned!.listen(0, "127.0.0.1", resolve));
      const address = owned.address();
      if (address === null || typeof address === "string") throw new Error("MCP API did not bind");
      const url = `http://127.0.0.1:${address.port}`;
      const created = await fetch(`${url}/v1/mcp/servers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "api-durable", scope: "project", workspaceRoot: "D:/workspace", transport: "stdio", command: "fixture", enabled: false, start: false, env: { AUTH_TOKEN: "must-not-leak", SAFE_VALUE: "ok" }, credentialRef: { id: "cred-api", kind: "oauth" } }) });
      expect(created.status).toBe(201);
      const body = await created.json() as { revision: number; config: { env?: Record<string, string>; credentialRef?: { id: string } } };
      expect(body.revision).toBe(1);
      expect(body.config.env?.AUTH_TOKEN).toBe("[redacted]");
      expect(body.config.credentialRef?.id).toBe("cred-api");
      await new Promise<void>((resolve, reject) => owned!.close((error) => error ? reject(error) : resolve()));
      owned = undefined;

      const reopened = createApiServer({ databasePath });
      await new Promise<void>((resolve) => reopened.listen(0, "127.0.0.1", resolve));
      const reopenedAddress = reopened.address();
      if (reopenedAddress === null || typeof reopenedAddress === "string") throw new Error("reopened MCP API did not bind");
      const listed = await (await fetch(`http://127.0.0.1:${reopenedAddress.port}/v1/mcp/servers`)).json() as { servers: { config: { credentialRef?: { id: string }; env?: Record<string, string> }; revision: number }[] };
      expect(listed.servers[0]).toMatchObject({ revision: 1, config: { credentialRef: { id: "cred-api" } } });
      expect(listed.servers[0]?.config.env?.AUTH_TOKEN).toBeUndefined();
      await new Promise<void>((resolve, reject) => reopened.close((error) => error ? reject(error) : resolve()));
    } finally {
      if (owned?.listening) await new Promise<void>((resolve) => owned!.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates, switches, archives, and restores a session work mode", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/workspace", permissionPreset: "workspace-write" }),
    });
    expect(created.status).toBe(201);
    const session = await created.json() as { id: string; permissionPreset: string; archived: boolean };
    expect(session).toMatchObject({ permissionPreset: "workspace-write", archived: false });

    const switched = await fetch(`${baseUrl}/v1/sessions/${session.id}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissionPreset: "read-only" }),
    });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toMatchObject({ permissionPreset: "read-only" });

    const archived = await fetch(`${baseUrl}/v1/sessions/${session.id}/archive`, { method: "POST" });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ archived: true });
    expect((await (await fetch(`${baseUrl}/v1/sessions`)).json() as { sessions: { id: string }[] }).sessions.some((item) => item.id === session.id)).toBe(false);

    const restored = await fetch(`${baseUrl}/v1/sessions/${session.id}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    expect(await restored.json()).toMatchObject({ archived: false });
  });

  it("soft-deletes a session and keeps its event history out of active lists", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/workspace/delete-fixture" }),
    });
    const session = await created.json() as { id: string };
    const deleted = await fetch(`${baseUrl}/v1/sessions/${session.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ deleted: true, sessionId: session.id });
    const active = await (await fetch(`${baseUrl}/v1/sessions?include_archived=true`)).json() as { sessions: { id: string }[] };
    expect(active.sessions.some((item) => item.id === session.id)).toBe(false);
    const history = await fetch(`${baseUrl}/v1/sessions/${session.id}/events?format=json`);
    expect(history.status).toBe(200);
    expect((await history.json() as { type: string }[]).at(-1)?.type).toBe("session/deleted");
  });

  it("replays session events over SSE", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/workspace" }),
    });
    const session = (await created.json()) as { id: string };
    await store.append({ sessionId: sessionId(session.id), type: "user/message", payload: { content: "after cursor" } });
    const response = await fetch(`${baseUrl}/v1/sessions/${session.id}/events?after_sequence=1`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("SSE response did not have a body");
    let text = "";
    for (let attempt = 0; attempt < 5 && !text.includes("event: user/message"); attempt += 1) {
      const chunk = await reader.read();
      text += new TextDecoder().decode(chunk.value);
      if (chunk.done) break;
    }
    expect(text).toContain("event: user/message");
    expect(text).not.toContain("event: session/created");
    await reader.cancel();
  });

  it("lists tools and completes an approved workspace edit", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-review-agent-tools-"));
    writeFileSync(join(root, "note.txt"), "before", "utf8");
    try {
      const created = await fetch(`${baseUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: root }) });
      const session = (await created.json()) as { id: string };
      const tools = await (await fetch(`${baseUrl}/v1/tools`)).json() as { tools: { name: string }[] };
      expect(tools.tools.map((tool) => tool.name)).toContain("edit_file");
      const read = await fetch(`${baseUrl}/v1/sessions/${session.id}/tools`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "tool-read-1" }, body: JSON.stringify({ name: "read_file", input: { path: "note.txt" } }) });
      expect(read.status).toBe(200);
      expect((await read.json()).result.output).toMatchObject({ path: "note.txt", lines: [{ number: 1, text: "before" }], truncated: false });
      const edit = await fetch(`${baseUrl}/v1/sessions/${session.id}/tools`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "tool-edit-1" }, body: JSON.stringify({ name: "edit_file", input: { path: "note.txt", oldText: "before", newText: "after" } }) });
      expect(edit.status).toBe(202);
      const pending = await edit.json() as { toolCallId: string; permission: { id: string } };
      const repeatedEdit = await fetch(`${baseUrl}/v1/sessions/${session.id}/tools`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "tool-edit-1" }, body: JSON.stringify({ name: "edit_file", input: { path: "note.txt", oldText: "before", newText: "after" } }) });
      expect(await repeatedEdit.json()).toMatchObject({ toolCallId: pending.toolCallId, permission: { id: pending.permission.id } });
      const approved = await fetch(`${baseUrl}/v1/sessions/${session.id}/permissions/${pending.permission.id}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "permission-edit-1" }, body: JSON.stringify({ status: "approved" }) });
      expect(approved.status).toBe(200);
      const repeatedApproval = await fetch(`${baseUrl}/v1/sessions/${session.id}/permissions/${pending.permission.id}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "permission-edit-1" }, body: JSON.stringify({ status: "approved" }) });
      expect(await repeatedApproval.json()).toMatchObject({ toolCallId: pending.toolCallId, status: "completed" });
      expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("after");
      const cancelCandidate = await fetch(`${baseUrl}/v1/sessions/${session.id}/tools`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "tool-edit-cancel-1" }, body: JSON.stringify({ name: "edit_file", input: { path: "note.txt", oldText: "after", newText: "cancelled" } }) });
      const cancelBody = await cancelCandidate.json() as { toolCallId: string };
      const cancelled = await fetch(`${baseUrl}/v1/sessions/${session.id}/tools/${cancelBody.toolCallId}/cancel`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "cancel-tool-1" }, body: "{}" });
      expect(cancelled.status).toBe(200); expect((await cancelled.json()).cancelled).toBe(true);
      const repeatedCancel = await fetch(`${baseUrl}/v1/sessions/${session.id}/tools/${cancelBody.toolCallId}/cancel`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "cancel-tool-1" }, body: "{}" });
      expect((await repeatedCancel.json()).cancelled).toBe(true); expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("after");
      const projection = await (await fetch(`${baseUrl}/v1/sessions/${session.id}`)).json() as { toolCalls: { id: string; status: string; caller?: string; workspaceRoot?: string }[]; permissions: { toolCallId: string; status: string }[] };
      expect(projection.toolCalls.find((call) => call.id === cancelBody.toolCallId)).toMatchObject({ status: "cancelled", caller: "user", workspaceRoot: root });
      expect(projection.permissions.find((permission) => permission.toolCallId === cancelBody.toolCallId)?.status).toBe("cancelled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pauses a model turn for ask_user and resumes through the interaction API", async () => {
    const interactionStore = new InMemoryEventStore(); let modelCalls = 0;
    const interactionServer = createApiServer({
      store: interactionStore,
      model: {
        async *stream() {
          if (modelCalls++ === 0) {
            yield { type: "tool_call_start" as const, index: 0, id: "call_ask", name: "ask_user" };
            yield { type: "tool_call_delta" as const, index: 0, arguments: JSON.stringify({ question: "Continue?", options: [{ label: "Yes", value: "yes" }] }) };
            yield { type: "done" as const };
          } else {
            yield { type: "text_delta" as const, text: "Continuing with your answer." };
            yield { type: "done" as const };
          }
        },
      },
    });
    await new Promise<void>((resolve) => interactionServer.listen(0, "127.0.0.1", resolve));
    try {
      const address = interactionServer.address(); if (address === null || typeof address === "string") throw new Error("Interaction API did not bind"); const url = `http://127.0.0.1:${address.port}`;
      const session = await (await fetch(`${url}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: process.cwd() }) })).json() as { id: string };
      await fetch(`${url}/v1/sessions/${session.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Ask me before continuing" }) });
      let interaction: { id: string } | undefined;
      for (let attempt = 0; attempt < 100 && interaction === undefined; attempt += 1) { const projection = await (await fetch(`${url}/v1/sessions/${session.id}`)).json() as { interactions?: { id: string; status: string }[] }; const pending = projection.interactions?.find((item) => item.status === "pending"); if (pending !== undefined) interaction = pending; else await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
      expect(interaction).toBeDefined();
      const answered = await fetch(`${url}/v1/sessions/${session.id}/interactions/${interaction!.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "answered", answer: "yes" }) });
      expect(answered.status).toBe(200); expect((await answered.json()).status).toBe("answered");
      let projection: { messages: { content: string }[] } = { messages: [] };
      for (let attempt = 0; attempt < 100; attempt += 1) { projection = await (await fetch(`${url}/v1/sessions/${session.id}`)).json() as typeof projection; if (projection.messages.some((message) => message.content.includes("Continuing"))) break; await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
      expect(projection.messages.some((message) => message.content.includes("Continuing"))).toBe(true);
    } finally { await new Promise<void>((resolve, reject) => interactionServer.close((error) => (error ? reject(error) : resolve()))); }
  });

  it("exposes MCP server configuration without leaking secrets", async () => {
    const created = await fetch(`${baseUrl}/v1/mcp/servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "api-fixture", scope: "user", transport: "stdio", command: "fixture", env: { AUTH_TOKEN: "secret-value" }, start: false }),
    });
    expect(created.status).toBe(201);
    const server = await created.json() as { config: { env?: Record<string, string> }; status: string };
    expect(server.status).toBe("stopped");
    expect(server.config.env?.AUTH_TOKEN).toBe("[redacted]");
    const listed = await (await fetch(`${baseUrl}/v1/mcp/servers`)).json() as { servers: { config: { name: string } }[] };
    expect(listed.servers.some((item) => item.config.name === "api-fixture")).toBe(true);
    const disabled = await fetch(`${baseUrl}/v1/mcp/servers/api-fixture/disable`, { method: "POST" });
    expect((await disabled.json()).status).toBe("disabled");
    const removed = await fetch(`${baseUrl}/v1/mcp/servers/api-fixture`, { method: "DELETE" });
    expect((await removed.json()).removed).toBe(true);
  });

  it("runs an explicitly configured DeepSeek-compatible model without exposing its key", async () => {
    let requestInit: RequestInit | undefined;
    const modelFetch: typeof fetch = async (_input, init) => {
      requestInit = init;
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"real model response\"}}]}\n\ndata: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const configured = createApiServer({
      store: new InMemoryEventStore(),
      model: new OpenAICompatibleChatModel({ baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "sk-test-only", fetch: modelFetch }),
      modelInfo: { provider: "deepseek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com", configured: true },
    });
    await new Promise<void>((resolve) => configured.listen(0, "127.0.0.1", resolve));
    try {
      const address = configured.address();
      if (address === null || typeof address === "string") throw new Error("Configured API did not bind");
      const configuredUrl = `http://127.0.0.1:${address.port}`;
      const health = await (await fetch(`${configuredUrl}/health`)).json() as { model: Record<string, unknown> };
      expect(health.model).toEqual({ provider: "deepseek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com", configured: true });
      expect(JSON.stringify(health)).not.toContain("sk-test-only");

      const session = await (await fetch(`${configuredUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/workspace" }) })).json() as { id: string };
      await fetch(`${configuredUrl}/v1/sessions/${session.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "hello" }) });
      let projection: { status: string; messages: { content: string }[] };
      for (let attempt = 0; attempt < 50; attempt += 1) {
        projection = await (await fetch(`${configuredUrl}/v1/sessions/${session.id}`)).json() as typeof projection;
        if (projection.status === "idle") break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(projection!.messages.at(-1)?.content).toBe("real model response");
      expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer sk-test-only");
      expect(String(requestInit?.body)).not.toContain("sk-test-only");
    } finally {
      await new Promise<void>((resolve, reject) => configured.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("lists and switches the supported DeepSeek models for subsequent turns", async () => {
    const makeModel = (name: string) => ({
      async *stream() {
        yield { type: "text_delta" as const, text: name };
        yield { type: "done" as const };
      },
    });
    const configured = createApiServer({
      store: new InMemoryEventStore(),
      model: makeModel("deepseek-v4-flash"),
      modelInfo: { provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", configured: true },
      availableModels: DEEPSEEK_MODELS,
      modelSelector: (model) => ({
        model: makeModel(model),
        config: { provider: "deepseek", model, baseUrl: "https://api.deepseek.com", configured: true },
      }),
    });
    await new Promise<void>((resolve) => configured.listen(0, "127.0.0.1", resolve));
    try {
      const address = configured.address();
      if (address === null || typeof address === "string") throw new Error("Model API did not bind");
      const configuredUrl = `http://127.0.0.1:${address.port}`;
      const models = await (await fetch(`${configuredUrl}/v1/models`)).json() as { current: string; models: string[] };
      expect(models).toMatchObject({ current: "deepseek-v4-flash", models: [...DEEPSEEK_MODELS] });
      const switched = await fetch(`${configuredUrl}/v1/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-v4-pro" }) });
      expect(switched.status).toBe(200);
      expect(await switched.json()).toMatchObject({ model: { model: "deepseek-v4-pro" } });
      const session = await (await fetch(`${configuredUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/workspace" }) })).json() as { id: string };
      await fetch(`${configuredUrl}/v1/sessions/${session.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "use selected model" }) });
      let projection: { status: string; messages: { content: string }[] };
      for (let attempt = 0; attempt < 50; attempt += 1) {
        projection = await (await fetch(`${configuredUrl}/v1/sessions/${session.id}`)).json() as typeof projection;
        if (projection.status === "idle") break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(projection!.messages.at(-1)?.content).toBe("deepseek-v4-pro");
      const rejected = await fetch(`${configuredUrl}/v1/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "not-a-deepseek-model" }) });
      expect(rejected.status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => configured.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("supports idempotent commands and session lifecycle endpoints", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/workspace" }),
    });
    const session = (await created.json()) as { id: string };
    const first = await fetch(`${baseUrl}/v1/sessions/${session.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "api-send-1" },
      body: JSON.stringify({ content: "idempotent" }),
    });
    const firstBody = (await first.json()) as { turnId: string };
    const repeated = await fetch(`${baseUrl}/v1/sessions/${session.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "api-send-1" },
      body: JSON.stringify({ content: "idempotent" }),
    });
    expect((await repeated.json()).turnId).toBe(firstBody.turnId);

    let projection: { status: string; messages: { content: string }[] };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      projection = (await (await fetch(`${baseUrl}/v1/sessions/${session.id}`)).json()) as typeof projection;
      if (projection.status === "idle" && projection.messages.some((message) => message.content === "Echo: idempotent")) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(projection!.messages.at(-1)?.content).toBe("Echo: idempotent");
    await store.append({ sessionId: sessionId(session.id), type: "agent/status", payload: { status: "interrupted" } });
    const resumed = await fetch(`${baseUrl}/v1/sessions/${session.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "api-resume-1" },
      body: "{}",
    });
    expect(resumed.status).toBe(200);
    const forked = await fetch(`${baseUrl}/v1/sessions/${session.id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "api-fork-1" },
      body: JSON.stringify({ workspaceRoot: "D:/fork" }),
    });
    expect(forked.status).toBe(201);
    const forkedBody = (await forked.json()) as { sessionId: string };
    const forkedProjection = (await (await fetch(`${baseUrl}/v1/sessions/${forkedBody.sessionId}`)).json()) as { workspaceRoot: string; status: string; messages: { content: string }[] };
    expect(forkedProjection.workspaceRoot).toBe("D:/fork");
    expect(forkedProjection.status).toBe("idle");
    expect(forkedProjection.messages.at(-1)?.content).toBe("Echo: idempotent");
  });

  it("reopens the same SQLite database with session history intact", async () => {
    const directory = mkdtempSync(join(tmpdir(), "code-review-agent-api-"));
    const databasePath = join(directory, "agent.sqlite");
    const first = createApiServer({ databasePath });
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
    const firstAddress = first.address();
    if (firstAddress === null || typeof firstAddress === "string") throw new Error("API did not bind");
    const firstUrl = `http://127.0.0.1:${firstAddress.port}`;
    const created = await fetch(`${firstUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/restart" }),
    });
    const session = (await created.json()) as { id: string };
    await new Promise<void>((resolve, reject) => first.close((error) => (error ? reject(error) : resolve())));

    const second = createApiServer({ databasePath });
    await new Promise<void>((resolve) => second.listen(0, "127.0.0.1", resolve));
    const secondAddress = second.address();
    if (secondAddress === null || typeof secondAddress === "string") throw new Error("API did not bind");
    const restored = await (await fetch(`http://127.0.0.1:${secondAddress.port}/v1/sessions/${session.id}`)).json() as { workspaceRoot: string; lastSequence: number };
    expect(restored.workspaceRoot).toBe("D:/restart");
    expect(restored.lastSequence).toBe(1);
    await new Promise<void>((resolve, reject) => second.close((error) => (error ? reject(error) : resolve())));
    rmSync(directory, { recursive: true, force: true });
  });

  it("restores a pending tool permission after an API restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "code-review-agent-permission-recovery-"));
    const databasePath = join(directory, "agent.sqlite");
    const first = createApiServer({ databasePath });
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
    const firstAddress = first.address();
    if (firstAddress === null || typeof firstAddress === "string") throw new Error("API did not bind");
    const firstUrl = `http://127.0.0.1:${firstAddress.port}`;
    const session = await (await fetch(`${firstUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: directory }) })).json() as { id: string };
    const pending = await (await fetch(`${firstUrl}/v1/sessions/${session.id}/tools`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "restart-write-1" }, body: JSON.stringify({ name: "write_file", input: { path: "restored.txt", content: "restored" } }) })).json() as { permission: { id: string } };
    await new Promise<void>((resolve, reject) => first.close((error) => (error ? reject(error) : resolve())));

    const second = createApiServer({ databasePath });
    await new Promise<void>((resolve) => second.listen(0, "127.0.0.1", resolve));
    const secondAddress = second.address();
    if (secondAddress === null || typeof secondAddress === "string") throw new Error("API did not bind");
    const approved = await fetch(`http://127.0.0.1:${secondAddress.port}/v1/sessions/${session.id}/permissions/${pending.permission.id}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "restart-approve-1" }, body: JSON.stringify({ status: "approved" }) });
    expect(approved.status).toBe(200); expect(readFileSync(join(directory, "restored.txt"), "utf8")).toBe("restored");
    await new Promise<void>((resolve, reject) => second.close((error) => (error ? reject(error) : resolve())));
    rmSync(directory, { recursive: true, force: true });
  });

  it("restores a pending user interaction after an API restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "code-review-agent-interaction-recovery-"));
    const databasePath = join(directory, "agent.sqlite");
    let modelCalls = 0;
    const model = {
      async *stream() {
        if (modelCalls++ === 0) {
          yield { type: "tool_call_start" as const, index: 0, id: "call_api_interaction_restart", name: "ask_user" };
          yield { type: "tool_call_delta" as const, index: 0, arguments: JSON.stringify({ question: "Continue after API restart?", options: [{ label: "Yes", value: "yes" }] }) };
          yield { type: "done" as const };
        } else {
          yield { type: "text_delta" as const, text: "API interaction recovered." };
          yield { type: "done" as const };
        }
      },
    };
    const first = createApiServer({ databasePath, model });
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
    try {
      const firstAddress = first.address();
      if (firstAddress === null || typeof firstAddress === "string") throw new Error("API did not bind");
      const firstUrl = `http://127.0.0.1:${firstAddress.port}`;
      const session = await (await fetch(`${firstUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: directory }) })).json() as { id: string };
      await fetch(`${firstUrl}/v1/sessions/${session.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "ask before continuing" }) });
      let interactionId: string | undefined;
      for (let attempt = 0; attempt < 100 && interactionId === undefined; attempt += 1) {
        const projection = await (await fetch(`${firstUrl}/v1/sessions/${session.id}`)).json() as { interactions?: { id: string; status: string }[] };
        interactionId = projection.interactions?.find((item) => item.status === "pending")?.id;
        if (interactionId === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(interactionId).toBeDefined();
      await new Promise<void>((resolve, reject) => first.close((error) => (error ? reject(error) : resolve())));

      const second = createApiServer({ databasePath, model });
      await new Promise<void>((resolve) => second.listen(0, "127.0.0.1", resolve));
      try {
        const secondAddress = second.address();
        if (secondAddress === null || typeof secondAddress === "string") throw new Error("API did not bind");
        const secondUrl = `http://127.0.0.1:${secondAddress.port}`;
        const restored = await (await fetch(`${secondUrl}/v1/sessions/${session.id}`)).json() as { status: string; interactions?: { id: string; status: string }[] };
        expect(restored.status).toBe("interrupted");
        expect(restored.interactions?.find((item) => item.id === interactionId)?.status).toBe("pending");
        const answered = await fetch(`${secondUrl}/v1/sessions/${session.id}/interactions/${interactionId}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "restart-interaction-answer-1" }, body: JSON.stringify({ status: "answered", answer: "yes" }) });
        expect(answered.status).toBe(200);
        let projection: { messages: { content: string }[] } = { messages: [] };
        for (let attempt = 0; attempt < 100; attempt += 1) { projection = await (await fetch(`${secondUrl}/v1/sessions/${session.id}`)).json() as typeof projection; if (projection.messages.some((message) => message.content.includes("API interaction recovered"))) break; await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
        expect(projection.messages.some((message) => message.content.includes("API interaction recovered"))).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) => second.close((error) => (error ? reject(error) : resolve())));
      }
    } finally {
      if ((first as { listening?: boolean }).listening) await new Promise<void>((resolve, reject) => first.close((error) => (error ? reject(error) : resolve())));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
