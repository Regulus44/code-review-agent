/**
 * Phase 7 browser smoke harness for Read-only, Edit and Test/Recovery.
 *
 * The fixture is backed by SQLite so the second API host is a real restart:
 * running sessions become interrupted, pending permissions are restored, and
 * the browser can approve them through the normal API/SSE path.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../apps/api/dist/server.js";
import { seedCodingFixture } from "../apps/api/dist/fixtures/coding.js";
import { AgentHost } from "../packages/runtime/dist/index.js";
import { SqliteEventStore } from "../packages/storage/dist/index.js";

const root = await mkdtemp(join(tmpdir(), "code-review-agent-phase7-coding-"));
const databasePath = join(root, "events.sqlite");
const webRoot = process.env.PHASE7_WEB_ROOT;

let store = new SqliteEventStore({ databasePath });
let host = new AgentHost({ store });
let server = createApiServer({ store, host, ...(webRoot === undefined ? {} : { webRoot }) });

async function listen(current) {
  await new Promise((resolve) => current.listen(Number(process.env.PHASE7_FIXTURE_PORT ?? 0), "127.0.0.1", resolve));
  const address = current.address();
  if (address === null || typeof address === "string") throw new Error("Phase 7 coding fixture server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer() {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const initialBaseUrl = await listen(server);
const seed = await seedCodingFixture({ store, host, workspaceRoot: root, commandPrefix: "phase7-browser-coding" });

// Close and reopen the same database before exposing the fixture URL. This
// makes the Test/Recovery session visibly interrupted with a restorable
// permission, while Read-only and Edit remain ordinary replayable sessions.
await closeServer();
store.close();
store = new SqliteEventStore({ databasePath });
host = new AgentHost({ store });
await host.getSession(seed.testRecovery.sessionId);
server = createApiServer({ store, host, ...(webRoot === undefined ? {} : { webRoot }) });
const baseUrl = await listen(server);

console.log(JSON.stringify({
  baseUrl,
  initialBaseUrl,
  databasePath,
  workspaceRoot: root,
  scenarios: {
    readOnly: seed.readOnly,
    edit: seed.edit,
    testRecovery: seed.testRecovery,
  },
}));

async function cleanup() {
  await closeServer().catch(() => undefined);
  store.close();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

process.once("SIGINT", () => { void cleanup().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void cleanup().finally(() => process.exit(0)); });
await new Promise(() => undefined);
