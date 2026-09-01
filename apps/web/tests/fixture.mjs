import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiServer } from "../../api/dist/server.js";
import { AgentHost, sessionId, turnId } from "../../../packages/runtime/dist/index.js";
import { SqliteEventStore } from "../../../packages/storage/dist/index.js";

const webRoot = join(fileURLToPath(new URL("../..", import.meta.url)), "web");

/**
 * Starts the same SQLite-backed API and static Web shell used by the app.
 * Tests deliberately cross the HTTP/SSE boundary; direct store access is only
 * used to create deterministic dropped-frame and long-history fixtures.
 */
export async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "coding-agent-phase5-"));
  const databasePath = join(root, "events.sqlite");
  let store = new SqliteEventStore({ databasePath });
  let host = new AgentHost({ store });
  let server;
  let baseUrl;

  const listen = async () => {
    server = createApiServer({ store, host, webRoot });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Phase 5 fixture did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  };

  const closeServer = async () => {
    if (server?.listening !== true) return;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };

  await listen();

  const context = {
    root,
    databasePath,
    get baseUrl() { return baseUrl; },
    get store() { return store; },
    get host() { return host; },
    async request(pathname, init = {}, expected = 200) {
      const response = await fetch(`${baseUrl}${pathname}`, init);
      const text = await response.text();
      let body = text;
      try { body = text.length === 0 ? undefined : JSON.parse(text); } catch { /* text body */ }
      if (response.status !== expected) throw new Error(`${init.method ?? "GET"} ${pathname} returned ${response.status}, expected ${expected}: ${text}`);
      return { response, body };
    },
    async createSession(workspaceRoot = root, permissionPreset = "ask-on-write") {
      const { body } = await context.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceRoot, permissionPreset }),
      }, 201);
      return body;
    },
    async append(id, type, payload = {}, currentTurnId) {
      return store.append({
        sessionId: sessionId(id),
        ...(currentTurnId === undefined ? {} : { turnId: turnId(currentTurnId) }),
        type,
        payload,
      });
    },
    async session(id) {
      return (await context.request(`/v1/sessions/${encodeURIComponent(id)}`)).body;
    },
    async events(id, query = "") {
      return (await context.request(`/v1/sessions/${encodeURIComponent(id)}/events?format=json${query}`)).body;
    },
    async waitFor(label, read, predicate, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await read();
        if (predicate(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
    },
    async restart() {
      await closeServer();
      store.close();
      store = new SqliteEventStore({ databasePath });
      host = new AgentHost({ store });
      await listen();
    },
  };

  try {
    return await run(context);
  } finally {
    await closeServer().catch(() => undefined);
    store.close();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(`Phase 5 browser gate: ${message}`);
}

export function assertSequence(events, label = "events") {
  for (let index = 1; index < events.length; index += 1) {
    assert(events[index].sequence === events[index - 1].sequence + 1, `${label} has a gap at index ${index}`);
  }
}

export function collectSse(url, count) {
  const controller = new AbortController();
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const result = (async () => {
    const response = await fetch(url, { signal: controller.signal });
    resolveReady();
    if (!response.body) throw new Error("SSE response has no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName;
    let data = [];
    const events = [];
    try {
      while (events.length < count) {
        const next = await reader.read();
        buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith(":") || line.length === 0) {
            if (line.length === 0 && data.length > 0) {
              const parsed = JSON.parse(data.join("\n"));
              events.push({ type: eventName, event: parsed });
              eventName = undefined;
              data = [];
              if (events.length >= count) break;
            }
            continue;
          }
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (next.done) break;
      }
      return events;
    } finally {
      await reader.cancel().catch(() => undefined);
      controller.abort();
    }
  })();
  return { ready, result };
}
