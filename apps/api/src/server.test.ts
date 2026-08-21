import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createApiServer } from "./server.js";

describe("Phase 1 API", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createApiServer();
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
    const response = await fetch(`${baseUrl}/v1/sessions/${session.id}/events?after_sequence=0`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("SSE response did not have a body");
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("event: session/created");
    await reader.cancel();
  });
});
