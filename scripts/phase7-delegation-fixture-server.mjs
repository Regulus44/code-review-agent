/**
 * Phase 7 browser smoke harness.
 *
 * Starts an isolated in-memory API, seeds one completed child and one live
 * cancellable child, then keeps the server alive for a browser session. The
 * harness uses compiled workspace packages; run `pnpm typecheck` first.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../apps/api/dist/server.js";
import { createDelegationFixtureProvider, seedDelegationFixture } from "../apps/api/dist/fixtures/delegation.js";
import { sessionId } from "../packages/runtime/dist/index.js";
import { InMemoryEventStore } from "../packages/storage/dist/index.js";
import { SubagentRuntime } from "../packages/subagent/dist/index.js";

const store = new InMemoryEventStore();
const fixtureRoot = await mkdtemp(join(tmpdir(), "code-review-agent-phase7-delegation-"));
const subagentRuntime = new SubagentRuntime({ store });
subagentRuntime.registerProvider(createDelegationFixtureProvider({ store }));
const server = createApiServer({ store, subagentRuntime });

await new Promise((resolve) => server.listen(Number(process.env.PHASE7_FIXTURE_PORT ?? 0), "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Phase 7 fixture server did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;
const parent = await (await fetch(`${baseUrl}/v1/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ workspaceRoot: fixtureRoot, permissionPreset: "read-only" }),
})).json();
const seed = await seedDelegationFixture({
  store,
  runtime: subagentRuntime,
  parentSessionId: sessionId(parent.id),
  workspaceRoot: fixtureRoot,
  completedWorkspaceRoot: join(fixtureRoot, "completed-child"),
  cancellableWorkspaceRoot: join(fixtureRoot, "cancellable-child"),
  commandPrefix: "browser-delegation-fixture",
});

console.log(JSON.stringify({ baseUrl, parentSessionId: parent.id, completed: seed.completed, cancellable: seed.cancellable }));

const close = async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(fixtureRoot, { recursive: true, force: true });
};
process.once("SIGINT", () => { void close().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); });
await new Promise(() => undefined);
