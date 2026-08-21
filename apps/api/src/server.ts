import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { sessionId, AgentHost, turnId } from "@code-review-agent/runtime";
import { SqliteEventStore } from "@code-review-agent/storage";
import { brand, type AgentEvent, type PermissionId, type SessionEventStore } from "@code-review-agent/contracts";

export interface ApiServerOptions {
  readonly store?: SessionEventStore;
  readonly databasePath?: string;
  readonly host?: AgentHost;
  readonly webRoot?: string;
}

export function createApiServer(options: ApiServerOptions = {}): Server {
  const ownsStore = options.store === undefined && options.host === undefined;
  const store = options.store ?? (options.host === undefined ? new SqliteEventStore(options.databasePath === undefined ? {} : { databasePath: options.databasePath }) : undefined);
  const host = options.host ?? new AgentHost({ store: store as SessionEventStore });
  const persistence = store instanceof SqliteEventStore ? "sqlite" : "custom";
  const webRoot = options.webRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
  const server = createServer((request, response) => {
    void handleRequest(request, response, host, webRoot, persistence);
  });
  if (ownsStore && store instanceof SqliteEventStore) server.on("close", () => store.close());
  return server;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, host: AgentHost, webRoot: string, persistence: string): Promise<void> {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type, idempotency-key, last-event-id");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "code-review-agent", runtime: "typescript", persistence });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/tools") {
      sendJson(response, 200, { tools: host.listTools() });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      serveIndex(response, webRoot);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/sessions") {
      const body = await readJson(request);
      const workspaceRoot = typeof body.workspaceRoot === "string" && body.workspaceRoot.length > 0 ? body.workspaceRoot : process.cwd();
      sendJson(response, 201, await host.createSession(workspaceRoot));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/sessions") {
      sendJson(response, 200, { sessions: await host.listSessions() });
      return;
    }
    const eventsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/u);
    if (request.method === "GET" && eventsMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(eventsMatch[1]));
      const after = parseSequence(url.searchParams.get("after_sequence") ?? request.headers["last-event-id"]);
      const session = await host.getSession(id);
      if (session === undefined) throw new HttpError(404, "session not found");
      if (url.searchParams.get("format") === "json") {
        sendJson(response, 200, await host.events(id, after));
        return;
      }
      await streamEvents(request, response, host, id, after);
      return;
    }
    const resumeMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/resume$/u);
    if (request.method === "POST" && resumeMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(resumeMatch[1]));
      const body = await readJson(request);
      sendJson(response, 200, await host.resumeSession(id, commandId(request, body)));
      return;
    }
    const permissionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/permissions\/([^/]+)$/u);
    if (request.method === "POST" && permissionMatch?.[1] !== undefined && permissionMatch[2] !== undefined) {
      const id = sessionId(decodeURIComponent(permissionMatch[1]));
      const body = await readJson(request);
      const status = body.status;
      if (status !== "approved" && status !== "denied" && status !== "cancelled") throw new HttpError(400, "status must be approved, denied, or cancelled");
      sendJson(response, 200, await host.resolvePermission(id, brand<string, "PermissionId">(decodeURIComponent(permissionMatch[2])), status, commandId(request, body)));
      return;
    }
    const forkMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/fork$/u);
    if (request.method === "POST" && forkMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(forkMatch[1]));
      const body = await readJson(request);
      const workspaceRoot = typeof body.workspaceRoot === "string" ? body.workspaceRoot : undefined;
      sendJson(response, 201, { sessionId: await host.forkSession(id, workspaceRoot, commandId(request, body)) });
      return;
    }
    const cancelMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/cancel$/u);
    if (request.method === "POST" && cancelMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(cancelMatch[1]));
      const body = await readJson(request);
      const rawTurnId = body.turnId;
      if (typeof rawTurnId !== "string") throw new HttpError(400, "turnId is required");
      sendJson(response, 200, { cancelled: await host.cancelTurn(id, turnId(rawTurnId), commandId(request, body)) });
      return;
    }
    const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/u);
    if (sessionMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(sessionMatch[1]));
      if (request.method === "POST") {
        const body = await readJson(request);
        const content = body.content;
        if (typeof content !== "string") throw new HttpError(400, "content is required");
        sendJson(response, 202, { turnId: await host.sendMessage(id, content, commandId(request, body)) });
        return;
      }
      if (request.method === "GET") {
        const projection = await host.getSession(id);
        if (projection === undefined) throw new HttpError(404, "session not found");
        sendJson(response, 200, projection);
        return;
      }
    }
    const toolsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/tools$/u);
    if (request.method === "POST" && toolsMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(toolsMatch[1]));
      const body = await readJson(request);
      if (typeof body.name !== "string") throw new HttpError(400, "name is required");
      const result = await host.executeTool(id, body.name, body.input, typeof body.turnId === "string" ? turnId(body.turnId) : undefined, commandId(request, body));
      sendJson(response, result.status === "awaiting_permission" ? 202 : 200, result);
      return;
    }
    throw new HttpError(404, "not found");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
    const status = error instanceof HttpError ? error.status : code === "INVALID_TOOL_INPUT" ? 400 : code === "TOOL_NOT_FOUND" ? 404 : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (!response.headersSent) sendJson(response, status, { error: message });
    else response.end();
  }
}

async function streamEvents(request: IncomingMessage, response: ServerResponse, host: AgentHost, id: ReturnType<typeof sessionId>, after: number): Promise<void> {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
  response.write(": connected\n\n");
  let replaying = true;
  let buffered: AgentEvent[] = [];
  let lastSent = after;
  const unsubscribe = host.subscribe(id, (event) => {
    if (replaying) buffered.push(event);
    else if (event.sequence > lastSent) {
      writeEvent(response, event);
      lastSent = event.sequence;
    }
  });
  const close = () => unsubscribe();
  request.on("close", close);
  try {
    const historical = await host.events(id, after);
    for (const event of historical) {
      if (event.sequence > lastSent) {
        writeEvent(response, event);
        lastSent = event.sequence;
      }
    }
    replaying = false;
    for (const event of buffered.sort((left, right) => left.sequence - right.sequence)) {
      if (event.sequence > lastSent) {
        writeEvent(response, event);
        lastSent = event.sequence;
      }
    }
    buffered = [];
  } catch (error) {
    unsubscribe();
    throw error;
  }
}

function commandId(request: IncomingMessage, body: Record<string, unknown>): string | undefined {
  const header = request.headers["idempotency-key"];
  if (typeof header === "string" && header.length > 0) return header;
  return typeof body.commandId === "string" && body.commandId.length > 0 ? body.commandId : undefined;
}

function serveIndex(response: ServerResponse, webRoot: string): void {
  const file = path.join(webRoot, "index.html");
  if (!existsSync(file)) throw new HttpError(404, "web shell not found");
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  createReadStream(file).pipe(response);
}

function writeEvent(response: ServerResponse, event: { sequence: number; type: string; payload: unknown }): void {
  if (response.destroyed) return;
  response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const content = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(content) });
  response.end(content);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength > 1_048_576) throw new HttpError(413, "request body too large");
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "JSON object required");
  return value as Record<string, unknown>;
}

function parseSequence(value: string | string[] | null | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === null || raw === undefined || raw === "") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env["PORT"] ?? "3210", 10);
  createApiServer().listen(port, "127.0.0.1", () => {
    console.log(`Code Review Agent API listening on http://127.0.0.1:${port}`);
  });
}
