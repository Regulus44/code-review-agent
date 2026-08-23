/**
 * Phase 8.1 context compaction browser/replay gate.
 *
 * Uses a real API host with a deliberately small configured budget, then
 * reopens the same SQLite database to prove compaction receipts are durable.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiServer } from "../apps/api/dist/server.js";

const root = await mkdtemp(join(tmpdir(), "code-review-agent-phase8-compaction-"));
const databasePath = join(root, "events.sqlite");
const webRoot = fileURLToPath(new URL("../apps/web/", import.meta.url));
let server;

function assert(condition, message) {
  if (!condition) throw new Error(`Phase 8.1 compaction gate: ${message}`);
}

async function listen() {
  server = createApiServer({
    databasePath,
    webRoot,
    contextBudget: { maxTokens: 120, recentMessageTokens: 40, maxToolResultChars: 200, maxSummaryChars: 160 },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Compaction gate API did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function close() {
  if (server === undefined || !server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server = undefined;
}

async function request(baseUrl, pathname, init = {}, expected = 200) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let body = text;
  try { body = text.length === 0 ? undefined : JSON.parse(text); } catch { /* text response */ }
  assert(response.status === expected, `${init.method ?? "GET"} ${pathname} returned ${response.status}, expected ${expected}: ${text}`);
  return body;
}

try {
  let baseUrl = await listen();
  const shell = await request(baseUrl, "/");
  assert(typeof shell === "string" && shell.includes("context-meter"), "Web shell is missing the context meter");
  const browser = await request(baseUrl, "/web/browser.js");
  assert(typeof browser === "string" && browser.includes("presentContextMeter"), "typed browser bundle is missing context presenter");
  const capabilities = await request(baseUrl, "/v1/capabilities");
  assert(capabilities.context?.enabled === true && capabilities.context.configured === true && capabilities.context.budget?.maxTokens === 120, "configured context budget metadata is missing");

  const session = await request(baseUrl, "/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: root }) }, 201);
  const content = "long context fixture " + "x".repeat(1_500);
  const sendAndWait = async (commandId, value) => {
    await request(baseUrl, `/v1/sessions/${session.id}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": commandId }, body: JSON.stringify({ content: value }) }, 202);
    let settled;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      settled = await request(baseUrl, `/v1/sessions/${session.id}`);
      if (settled.status === "idle") return settled;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return settled;
  };
  await sendAndWait("phase8-compaction-turn-1", content);
  await sendAndWait("phase8-compaction-turn-2", content);
  let projection;
  projection = await request(baseUrl, `/v1/sessions/${session.id}`);
  assert(projection?.status === "idle", "long-context turn did not settle");
  assert(projection?.contextCompaction?.status === "completed", "long-context turn did not produce a durable compaction receipt");
  assert(projection.contextCompaction.droppedMessages > 0, "compaction receipt did not record dropped messages");
  const events = await request(baseUrl, `/v1/sessions/${session.id}/events?format=json`);
  assert(events.some((event) => event.type === "context/compacted"), "compaction event is missing from replay");

  await close();
  baseUrl = await listen();
  const restored = await request(baseUrl, `/v1/sessions/${session.id}`);
  assert(restored.contextCompaction?.status === "completed" && restored.contextCompaction.droppedMessages > 0, "SQLite restart lost compaction projection");
  const replayed = await request(baseUrl, `/v1/sessions/${session.id}/events?format=json`);
  assert(replayed.some((event) => event.type === "context/compacted"), "SQLite restart lost compaction event replay");
  console.log(JSON.stringify({ phase: "8.1", gate: "compaction-browser-replay", passed: true, sessionId: session.id, events: replayed.length, droppedMessages: restored.contextCompaction.droppedMessages }));
} finally {
  await close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
