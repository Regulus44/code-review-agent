import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "./server.js";
import { InMemoryEventStore } from "@code-review-agent/storage";
import { sessionId } from "@code-review-agent/runtime";

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
      expect((await read.json()).result.output).toBe("before");
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
});
