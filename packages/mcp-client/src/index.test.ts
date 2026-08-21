import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryEventStore } from "@code-review-agent/storage";
import { ToolRegistry, ToolRuntime } from "@code-review-agent/tools";
import { brand } from "@code-review-agent/contracts";
import { McpConnectionManager, McpConfigStore, type McpServerConfig } from "./index.js";

describe("MCP client bridge", () => {
  it("connects to a real stdio MCP server process", async () => {
    const registry = new ToolRegistry();
    const manager = new McpConnectionManager({
      registry,
      configStore: new McpConfigStore([{ name: "stdio", scope: "user", transport: "stdio", command: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), "../test-fixtures/stdio-server.mjs")], cwd: process.cwd(), riskLevel: "read", reconnect: { enabled: false } }]),
    });
    const record = await manager.start("stdio");
    expect(record.status).toBe("connected");
    expect(registry.has("mcp__stdio__echo")).toBe(true);
    await manager.close();
  });

  it("connects over Streamable HTTP", async () => {
    const fixture = await createHttpFixture();
    const manager = new McpConnectionManager({
      registry: new ToolRegistry(),
      configStore: new McpConfigStore([{ name: "http", scope: "project", transport: "streamable-http", url: fixture.url, riskLevel: "read", reconnect: { enabled: false } }]),
    });
    const record = await manager.start("http");
    expect(record.status).toBe("connected");
    expect(record.toolNames).toContain("mcp__http__echo");
    await manager.close();
    await fixture.close();
  });

  it("discovers, namespaces, redacts and executes an MCP tool through ToolRuntime", async () => {
    const store = new InMemoryEventStore();
    const sessionId = await store.createSession(process.cwd());
    const registry = new ToolRegistry();
    const config: McpServerConfig = {
      name: "fixture",
      scope: "project",
      transport: "stdio",
      command: "fixture-server",
      riskLevel: "read",
      env: { AUTH_TOKEN: "do-not-leak" },
      reconnect: { enabled: false },
    };
    const manager = new McpConnectionManager({
      registry,
      store,
      configStore: new McpConfigStore([config]),
      transportFactory: () => createFixtureTransport().client,
    });
    const record = await manager.start("fixture");
    expect(record.status).toBe("connected");
    expect(manager.list()[0]?.config.env?.["AUTH_TOKEN"]).toBe("[redacted]");
    expect(registry.list()[0]?.source).toEqual({ kind: "mcp", serverName: "fixture", rawName: "echo" });
    expect(manager.discovery("fixture")).toMatchObject({ resources: [], prompts: [], tools: [{ name: "echo" }] });

    const runtime = new ToolRuntime({ store, registry, defaultTimeoutMs: 1_000 });
    const result = await runtime.execute({ sessionId, workspaceRoot: process.cwd(), name: "mcp__fixture__echo", input: { text: "hello" } });
    expect(result.status).toBe("completed");
    expect(result.result?.ok).toBe(true);
    expect(result.result?.modelView).toBe("echo: hello");
    const failed = await runtime.execute({ sessionId, workspaceRoot: process.cwd(), name: "mcp__fixture__echo", input: { text: "error" } });
    expect(failed.status).toBe("failed");
    expect(failed.result?.error?.code).toBe("MCP_TOOL_ERROR");
    const controller = new AbortController();
    const pending = runtime.execute({ sessionId, workspaceRoot: process.cwd(), name: "mcp__fixture__echo", input: { text: "slow" }, toolCallId: brand<string, "ToolCallId">("tool_mcp_cancel"), signal: controller.signal });
    setTimeout(() => controller.abort(new Error("cancelled by test")), 10);
    const cancelled = await pending;
    expect(cancelled.status).toBe("cancelled");
    expect((await store.list(sessionId)).some((event) => event.type === "mcp/server")).toBe(true);
    await manager.close();
  });

  it("keeps MCP tools inside the local approval pipeline", async () => {
    const store = new InMemoryEventStore();
    const sessionId = await store.createSession(process.cwd());
    const registry = new ToolRegistry();
    const manager = new McpConnectionManager({
      registry,
      configStore: new McpConfigStore([{ name: "approval", scope: "session", transport: "stdio", command: "fixture", riskLevel: "write", reconnect: { enabled: false } }]),
      transportFactory: () => createFixtureTransport().client,
    });
    await manager.start("approval");
    const runtime = new ToolRuntime({ store, registry });
    const pending = await runtime.execute({ sessionId, workspaceRoot: process.cwd(), name: "mcp__approval__echo", input: { text: "approved" } });
    expect(pending.status).toBe("awaiting_permission");
    expect(pending.permission).toBeDefined();
    const approved = await runtime.resolvePermission(pending.permission!.id, "approved");
    expect(approved.status).toBe("completed");
    await manager.close();
  });

  it("reconnects after a transport close and preserves the namespace", async () => {
    let connections = 0;
    let firstClientTransport: InMemoryTransport | undefined;
    const registry = new ToolRegistry();
    const manager = new McpConnectionManager({
      registry,
      configStore: new McpConfigStore([{ name: "reconnect", scope: "user", transport: "stdio", command: "fixture", riskLevel: "read", reconnect: { initialDelayMs: 5, maxDelayMs: 20, maxAttempts: 3 } }]),
      transportFactory: () => {
        connections += 1;
        const pair = createFixtureTransport();
        if (connections === 1) firstClientTransport = pair.client;
        return pair.client;
      },
    });
    const firstServer = await manager.start("reconnect");
    expect(firstServer.status).toBe("connected");
    await firstClientTransport?.close();
    for (let attempt = 0; attempt < 50 && connections < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(connections).toBeGreaterThanOrEqual(2);
    expect(manager.get("reconnect")?.status).toBe("connected");
    await manager.close();
  });
});

function createFixtureTransport(): { client: InMemoryTransport; server: Server } {
  const [client, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "fixture-server", version: "1.0.0" }, { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.arguments?.["text"] === "error") return { isError: true, content: [{ type: "text", text: "fixture failure" }] };
    if (request.params.arguments?.["text"] === "slow") await new Promise((resolve) => setTimeout(resolve, 100));
    return { content: [{ type: "text", text: `echo: ${String(request.params.arguments?.["text"] ?? "")}` }] };
  });
  void server.connect(serverTransport);
  return { client, server };
}

async function createHttpFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const http = createHttpServer((request, response) => {
    const transport = new StreamableHTTPServerTransport({});
    const server = new Server({ name: "http-fixture", version: "1.0.0" }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: `http: ${String(request.params.arguments?.text ?? "")}` }] }));
    response.on("close", () => { void transport.close(); void server.close(); });
    void server.connect(transport as Transport).then(() => transport.handleRequest(request, response)).catch((error: unknown) => { if (!response.headersSent) response.writeHead(500); response.end(error instanceof Error ? error.message : String(error)); });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("HTTP fixture failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => { await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve())); },
  };
}
