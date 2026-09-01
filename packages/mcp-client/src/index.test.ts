import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryEventStore, SqliteEventStore } from "@coding-agent/storage";
import { ToolRegistry, ToolRuntime } from "@coding-agent/tools";
import { brand } from "@coding-agent/contracts";
import { createMcpToolRegistrations, McpConnectionManager, McpConfigStore, publicToolName, type McpServerConfig } from "./index.js";

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
    expect(manager.discovery("fixture")).toMatchObject({ resources: [{ uri: "fixture://readme" }], prompts: [{ name: "review" }], tools: [{ name: "echo" }] });
    const resource = await manager.readResource("fixture", "fixture://readme");
    expect(resource.trust).toBe("untrusted-mcp-content");
    expect(resource.modelView).toContain("fixture readme");
    const prompt = await manager.getPrompt("fixture", "review", { focus: "mcp" });
    expect(prompt.trust).toBe("untrusted-mcp-content");

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

  it("uses durable config revisions and never persists secret values", async () => {
    const directory = join(process.cwd(), ".tmp-mcp-config-test");
    const databasePath = join(directory, "agent.sqlite");
    const { mkdirSync, rmSync } = await import("node:fs");
    mkdirSync(directory, { recursive: true });
    const store = new SqliteEventStore({ databasePath });
    const config: McpServerConfig = {
      name: "durable",
      scope: "project",
      workspaceRoot: process.cwd(),
      transport: "stdio",
      command: "fixture",
      env: { AUTH_TOKEN: "must-not-hit-sqlite", SAFE_VALUE: "ok" },
      credentialRef: { id: "oauth-durable", kind: "oauth" },
      enabled: false,
    };
    const first = new McpConnectionManager({ registry: new ToolRegistry(), configBackend: store });
    const record = await first.add(config, false);
    expect(record.revision).toBe(1);
    expect(store.listMcpConfigs()[0]?.config).not.toHaveProperty("env.AUTH_TOKEN");
    expect(store.listMcpConfigs()[0]?.credentialRef?.id).toBe("oauth-durable");
    await first.close();
    const second = new McpConnectionManager({ registry: new ToolRegistry(), configBackend: store });
    expect(second.get("durable")?.config.credentialRef?.id).toBe("oauth-durable");
    await second.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires an active credential resolver, scopes it by tenant, and stops live use on invalidation", async () => {
    const fixture = createFixtureTransport();
    let resolvedTenant: string | undefined;
    let seenHeaders: Record<string, string> | undefined;
    const manager = new McpConnectionManager({
      registry: new ToolRegistry(),
      configStore: new McpConfigStore([{ name: "secured", scope: "user", tenantId: "tenant-a", transport: "stdio", command: "fixture", credentialRef: { id: "cred-a", kind: "header", version: 1 }, reconnect: { enabled: false } }]),
      credentialResolver: (reference, tenantId) => {
        expect(reference.version).toBe(1);
        resolvedTenant = tenantId;
        return { headers: { authorization: "Bearer secret-value" } };
      },
      transportFactory: (config) => {
        seenHeaders = config.headers;
        return fixture.client;
      },
    });
    expect((await manager.start("secured", "tenant-a")).status).toBe("connected");
    expect(resolvedTenant).toBe("tenant-a");
    expect(seenHeaders).toEqual({ authorization: "Bearer secret-value" });
    await manager.invalidateCredential("tenant-a", "cred-a");
    expect(manager.get("secured", "tenant-a")?.status).toBe("needs_auth");
    await manager.close();

    const missing = new McpConnectionManager({
      registry: new ToolRegistry(),
      configStore: new McpConfigStore([{ name: "missing", scope: "user", tenantId: "tenant-a", transport: "stdio", command: "fixture", credentialRef: { id: "missing", kind: "header" }, reconnect: { enabled: false } }]),
      transportFactory: () => fixture.client,
    });
    expect((await missing.start("missing", "tenant-a")).status).toBe("needs_auth");
    await missing.close();
  });

  it("keeps tenant-scoped MCP config catalog and lifecycle access isolated", async () => {
    const tenantA = { name: "tenant-a-server", scope: "user" as const, tenantId: "tenant-a", transport: "stdio" as const, command: "fixture", enabled: false };
    const manager = new McpConnectionManager({ registry: new ToolRegistry(), configStore: new McpConfigStore([tenantA]) });
    expect(manager.list("tenant-a").map((record) => record.config.name)).toEqual(["tenant-a-server"]);
    expect(manager.list("tenant-b")).toEqual([]);
    expect(manager.get("tenant-a-server", "tenant-b")).toBeUndefined();
    await expect(manager.setEnabled("tenant-a-server", true, "tenant-b")).rejects.toMatchObject({ code: "MCP_SERVER_NOT_FOUND" });
    await expect(manager.add({ ...tenantA, tenantId: "tenant-b" }, false)).rejects.toMatchObject({ code: "MCP_TENANT_SCOPE_CONFLICT" });
    const registration = createMcpToolRegistrations({} as never, "tenant-a-server", { ...tenantA }, [{ name: "read", inputSchema: { type: "object" } }]);
    expect(registration[0]?.definition.source).toMatchObject({ kind: "mcp", tenantId: "tenant-a" });
    await manager.close();
  });

  it("keeps the full JSON schema contract and uses a deterministic SHA-256 name", () => {
    const rawName = "very-long-tool-name/with spaces/and a stable suffix";
    expect(publicToolName("fixture", rawName)).toBe(publicToolName("fixture", rawName));
    const registration = createMcpToolRegistrations({} as never, "fixture", { name: "fixture", scope: "user", transport: "stdio", command: "fixture" }, [{
      name: "schema",
      inputSchema: { type: "object", oneOf: [{ required: ["a"] }, { required: ["b"] }], $defs: { nested: { type: "string" } }, properties: { a: { type: "string", const: "x" } } },
    }]);
    expect(registration[0]?.definition.inputSchema).toMatchObject({ $defs: { nested: { type: "string" } } });
    expect((registration[0]?.definition.inputSchema as { oneOf?: unknown[] }).oneOf).toHaveLength(2);
  });

  it("debounces a list-changed storm into one serialized discovery", async () => {
    const fixture = createFixtureTransport();
    const manager = new McpConnectionManager({
      registry: new ToolRegistry(),
      configStore: new McpConfigStore([{ name: "storm", scope: "user", transport: "stdio", command: "fixture", riskLevel: "read", reconnect: { enabled: false } }]),
      transportFactory: () => fixture.client,
    });
    await manager.start("storm");
    const before = fixture.listCalls.value;
    await Promise.all(Array.from({ length: 10 }, () => fixture.server.sendToolListChanged()));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fixture.listCalls.value - before).toBe(1);
    expect(manager.get("storm")?.generation).toBeGreaterThan(0);
    await manager.close();
  });

  it("notifies resource consumers on connect and resources/list_changed", async () => {
    const fixture = createFixtureTransport();
    const changes: string[] = [];
    const manager = new McpConnectionManager({
      registry: new ToolRegistry(),
      configStore: new McpConfigStore([{ name: "resource-events", scope: "user", transport: "stdio", command: "fixture", riskLevel: "read", reconnect: { enabled: false } }]),
      transportFactory: () => fixture.client,
    });
    const unsubscribe = manager.subscribeResourceChanges((name) => changes.push(name));
    await manager.start("resource-events");
    const before = changes.length;
    await fixture.server.sendResourceListChanged();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(changes.slice(0, before).every((name) => name === "resource-events")).toBe(true);
    expect(changes.length).toBeGreaterThan(before);
    unsubscribe();
    await manager.close();
  });

  it("projects MCP lifecycle events only to sessions visible in the configured scope", async () => {
    const store = new InMemoryEventStore();
    const visible = await store.createSession("D:/workspace/visible");
    const hidden = await store.createSession("D:/workspace/other");
    const fixture = createFixtureTransport();
    const manager = new McpConnectionManager({
      registry: new ToolRegistry(),
      store,
      configStore: new McpConfigStore([{ name: "scoped", scope: "project", workspaceRoot: "D:/workspace/visible", transport: "stdio", command: "fixture", riskLevel: "read", reconnect: { enabled: false } }]),
      transportFactory: () => fixture.client,
    });
    await manager.start("scoped");
    expect((await store.list(visible)).some((event) => event.type === "mcp/server")).toBe(true);
    expect((await store.list(hidden)).some((event) => event.type === "mcp/server")).toBe(false);
    await manager.close();
  });
});

function createFixtureTransport(): { client: InMemoryTransport; server: Server; listCalls: { value: number } } {
  const [client, serverTransport] = InMemoryTransport.createLinkedPair();
  const listCalls = { value: 0 };
  const server = new Server({ name: "fixture-server", version: "1.0.0" }, { capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => { listCalls.value += 1; return { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }; });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "fixture://readme", name: "readme", mimeType: "text/plain" }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [{ uri: "fixture://readme", mimeType: "text/plain", text: "fixture readme" }] }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: "review", description: "Review fixture", arguments: [{ name: "focus", required: false }] }] }));
  server.setRequestHandler(GetPromptRequestSchema, async () => ({ description: "Untrusted review prompt", messages: [{ role: "user", content: { type: "text", text: "fixture prompt" } }] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.arguments?.["text"] === "error") return { isError: true, content: [{ type: "text", text: "fixture failure" }] };
    if (request.params.arguments?.["text"] === "slow") await new Promise((resolve) => setTimeout(resolve, 100));
    return { content: [{ type: "text", text: `echo: ${String(request.params.arguments?.["text"] ?? "")}` }] };
  });
  void server.connect(serverTransport);
  return { client, server, listCalls };
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
