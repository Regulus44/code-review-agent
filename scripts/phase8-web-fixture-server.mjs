/**
 * Phase 8 Web parity fixture.
 *
 * This fixture seeds one durable session with the planning and question
 * surfaces consumed by the Web shell. It intentionally uses the regular API,
 * SQLite event store and AgentHost so the gate exercises replayable facts and
 * host commands instead of a UI-only mock.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../apps/api/dist/server.js";
import { AgentHost } from "../packages/runtime/dist/index.js";
import { SqliteEventStore } from "../packages/storage/dist/index.js";
import { brand } from "../packages/contracts/dist/index.js";

const root = await mkdtemp(join(tmpdir(), "code-review-agent-phase8-web-"));
const databasePath = join(root, "events.sqlite");
const webRoot = process.env.PHASE8_WEB_ROOT;
const productizationEnabled = process.env.PHASE8_PRODUCTIZATION === "1";
const interactionTtlMs = boundedInteger(process.env.PHASE8_INTERACTION_TTL_MS ?? "600000", 120_000, 900_000, "PHASE8_INTERACTION_TTL_MS");
const liveControlEnabled = process.env.PHASE8_WEB_LIVE_TURN === "1";
const liveControlDelayMs = boundedInteger(process.env.PHASE8_WEB_LIVE_DELAY_MS ?? "300", 100, 2_000, "PHASE8_WEB_LIVE_DELAY_MS");
const store = new SqliteEventStore({ databasePath });
const ownership = productizationEnabled ? { principalId: brand("fixture-user-a", "PrincipalId"), tenantId: brand("fixture-tenant-a", "TenantId") } : undefined;
const productizationHostOptions = productizationEnabled ? {
  quota: { maxSessionsPerTenant: 2, maxTurnsPerTenant: 2 },
  operations: { backup: "available", migration: "available", upgrade: "deferred" },
} : {};
const bootstrapHost = new AgentHost({ store, ...productizationHostOptions });
const session = await bootstrapHost.createSession(root, "ask-on-write", undefined, ownership);
const turnId = brand("turn_phase8_web", "TurnId");
const toolCallId = brand("call_phase8_web", "ToolCallId");
const interactionOne = brand("interaction_phase8_one", "InteractionId");
const interactionTwo = brand("interaction_phase8_two", "InteractionId");

await store.append({ sessionId: session.id, turnId, type: "user/message", payload: { content: "Review the release plan and ask for confirmation." } });
await store.append({ sessionId: session.id, turnId, type: "turn/started", payload: {} });
await store.append({ sessionId: session.id, turnId, type: "step/started", payload: { step: 1 } });
await store.append({ sessionId: session.id, turnId, type: "goal/created", payload: {
  goalId: "goal_phase8_web",
  title: "Ship the Web parity slice",
  successCriteria: ["Question batch is answered", "Plan is approved"],
  status: "active",
} });
await store.append({ sessionId: session.id, turnId, type: "plan/updated", payload: {
  content: "1. Confirm the release scope\n2. Approve the implementation plan\n3. Run the browser gate",
  status: "draft",
} });
await store.append({ sessionId: session.id, turnId, type: "todo/updated", payload: {
  todos: [
    { id: "confirm-scope", content: "Confirm the release scope", status: "in_progress", activeForm: "Confirming the release scope" },
    { id: "run-gate", content: "Run the browser gate", status: "pending", activeForm: "Running the browser gate" },
  ],
} });
// Seed both interactions before the serving host is constructed. Its normal
// recovery pass registers them as restored waiters, so API answers exercise
// the durable recovery path and remain resolvable after a host restart.
await store.append({ sessionId: session.id, turnId, type: "tool/call", payload: { toolCallId, name: "ask_user", input: { batch: true } } });
await store.append({ sessionId: session.id, turnId, type: "interaction/requested", payload: {
  interactionId: interactionOne,
  toolCallId,
  question: "Which release channel should be used?",
  options: [{ label: "Stable", value: "stable" }, { label: "Preview", value: "preview" }],
  allowFreeform: true,
  caller: "agent",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + interactionTtlMs).toISOString(),
} });
await store.append({ sessionId: session.id, turnId, type: "interaction/requested", payload: {
  interactionId: interactionTwo,
  toolCallId,
  question: "Should the gate run after approval?",
  options: [{ label: "Run it", value: "yes" }, { label: "Skip", value: "no" }],
  allowFreeform: false,
  caller: "agent",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + interactionTtlMs).toISOString(),
} });
await store.append({ sessionId: session.id, turnId, type: "assistant/message", payload: { content: "The release plan is ready for your answers." } });

const fixtureModel = (text) => ({
  async *stream() {
    yield { type: "text_delta", text };
    yield { type: "done" };
  },
});
const liveControlModel = {
  async *stream(_messages, signal) {
    for (const text of ["Live control turn started. ", "Steer and queue are durable. ", "Live control turn completed."]) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, liveControlDelayMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }, { once: true });
      });
      yield { type: "text_delta", text };
    }
    yield { type: "done" };
  },
};
const host = new AgentHost({ store, ...productizationHostOptions, ...(liveControlEnabled ? { model: liveControlModel } : {}) });
let liveControlSession;
if (liveControlEnabled) {
  liveControlSession = await host.createSession(join(root, "live-control"), "ask-on-write");
  await host.sendMessage(liveControlSession.id, "Phase 8 live control fixture", "phase8-live-control");
}
const settingsModelOptions = process.env.PHASE8_MODEL_FAILURES === undefined ? {} : {
  modelSelector: (model) => ({
    model: fixtureModel(`selected:${model}`),
    config: { provider: "echo", model, configured: false },
  }),
};
const productizationModelOptions = productizationEnabled ? {
  availableModels: ["fixture-tenant-model-a", "fixture-tenant-model-b"],
  modelInfo: { provider: "deepseek", model: "fixture-host-model", baseUrl: "https://fixture-host.example.test", configured: true },
  modelSelector: (model, tenantId) => ({
    model: fixtureModel(`${tenantId ?? "local"}:${model}`),
    config: { provider: "deepseek", model, baseUrl: `https://${tenantId ?? "local"}.fixture-model.example.test`, configured: true },
  }),
} : {};

const server = createApiServer({
  store,
  host,
  ...(webRoot === undefined ? {} : { webRoot }),
  ...(process.env.PHASE8_MODEL_FAILURES === undefined ? {} : { modelCatalogFailures: Number(process.env.PHASE8_MODEL_FAILURES) }),
  ...(process.env.PHASE8_MODEL_FAILURES === undefined ? {} : { availableModels: ["fixture-model"] }),
  ...(process.env.PHASE8_MODEL_FAILURES === undefined ? {} : { modelInfo: { provider: "echo", model: "fixture-model", configured: false } }),
  ...settingsModelOptions,
  ...productizationModelOptions,
  ...(productizationEnabled ? { productization: { auth: { required: true, tokens: [{ token: "fixture-tenant-a-token", principalId: "fixture-user-a", tenantId: "fixture-tenant-a" }, { token: "fixture-tenant-b-token", principalId: "fixture-user-b", tenantId: "fixture-tenant-b" }] }, quota: { maxSessionsPerTenant: 2, maxTurnsPerTenant: 2 } } } : {}),
});
await new Promise((resolve) => server.listen(Number(process.env.PHASE8_WEB_PORT ?? 0), "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Phase 8 Web fixture did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;

console.log(JSON.stringify({
  baseUrl,
  databasePath,
  workspaceRoot: root,
  sessionId: session.id,
  turnId,
  goalId: "goal_phase8_web",
  interactions: { first: interactionOne, second: interactionTwo },
  ...(liveControlSession === undefined ? {} : { liveControlSessionId: liveControlSession.id, liveControlDelayMs }),
}));

async function cleanup() {
  await new Promise((resolve) => server.close(() => resolve())).catch(() => undefined);
  store.close();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

process.once("SIGINT", () => { void cleanup().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void cleanup().finally(() => process.exit(0)); });
await new Promise(() => undefined);

function boundedInteger(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
}
