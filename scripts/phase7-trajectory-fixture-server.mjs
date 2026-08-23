/**
 * Phase 7.8 browser fixture.
 *
 * Seeds one isolated session with 1,250 completed read-only tool records so
 * the Web client can exercise bounded history pages, load-older prepend,
 * search/fold, tail append and replay without executing real tools.
 */
import { createApiServer } from "../apps/api/dist/server.js";
import { seedTrajectoryFixture } from "../apps/api/dist/fixtures/trajectory.js";
import { InMemoryEventStore } from "../packages/storage/dist/index.js";
import { sessionId } from "../packages/runtime/dist/index.js";

const store = new InMemoryEventStore();
const server = createApiServer({ store });
await new Promise((resolve) => server.listen(Number(process.env.PHASE7_TRAJECTORY_PORT ?? 0), "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Phase 7 trajectory fixture server did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;
const parent = await (await fetch(`${baseUrl}/v1/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ workspaceRoot: process.cwd(), permissionPreset: "read-only" }),
})).json();
const seed = await seedTrajectoryFixture({ store, sessionId: sessionId(parent.id), records: 1_250 });
console.log(JSON.stringify({ baseUrl, sessionId: parent.id, ...seed }));

const close = async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
};
process.once("SIGINT", () => { void close().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); });
await new Promise(() => undefined);
