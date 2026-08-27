/** Phase 8.5 UI-M5 provider/model selection, recovery, and security gate. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../apps/api/dist/server.js";

const webRoot = join(process.cwd(), "apps", "web");

function assert(condition, message) {
  if (!condition) throw new Error(`Phase 8.5 provider/model gate: ${message}`);
}

async function startServer(options) {
  const server = createApiServer({ ...options, webRoot });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Provider/model fixture did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server) {
  if (server?.listening !== true) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function request(baseUrl, pathname, init = {}, expected = 200) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let body = text;
  try { body = text.length === 0 ? undefined : JSON.parse(text); } catch { /* text response */ }
  assert(response.status === expected, `${init.method ?? "GET"} ${pathname} returned ${response.status}, expected ${expected}: ${text}`);
  return { response, body, text };
}

async function waitFor(label, read, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function readSseReplay(baseUrl, pathname, afterSequence, expectedEvent) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { accept: "text/event-stream", "last-event-id": String(afterSequence) },
    signal: controller.signal,
  });
  assert(response.status === 200 && response.body !== null, "SSE replay did not open");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < 12_000 && !text.includes(`event: ${expectedEvent}`)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  assert(text.includes(`event: ${expectedEvent}`), `SSE replay missed ${expectedEvent}`);
  return text;
}

async function runLocalRecoveryScenario() {
  const root = await mkdtemp(join(tmpdir(), "code-review-agent-phase8.5-m5-"));
  const databasePath = join(root, "events.sqlite");
  const credentialSecretsPath = join(root, "credentials.secrets.json");
  const providerProfilesPath = join(root, "provider-profiles.json");
  const secret = "m5-local-secret-value";
  let current;
  let sessionId;
  try {
    current = await startServer({ databasePath, credentialSecretsPath, providerProfilesPath });
    const session = await request(current.baseUrl, "/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: root }),
    }, 201);
    sessionId = session.body.id;
    const credential = await request(current.baseUrl, "/v1/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "header", label: "M5 local provider", material: { headers: { authorization: `Bearer ${secret}` } } }),
    }, 201);
    const credentialRecord = credential.body.credential;
    assert(!credential.text.includes(secret), "credential create response exposed secret material");
    const provider = await request(current.baseUrl, "/v1/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "m5-local-provider",
        displayName: "M5 Local Provider",
        protocol: "echo",
        baseUrl: "https://m5.local.example/v1",
        models: ["m5-model-a", "m5-model-b"],
        credentialRef: credentialRecord,
      }),
    }, 201);
    assert(!provider.text.includes(secret), "Provider response exposed secret material");
    const providers = await request(current.baseUrl, "/v1/providers");
    assert(providers.body.profiles.some((profile) => profile.id === "m5-local-provider"), "saved Provider profile is missing from catalog");
    assert(!providers.text.includes(secret), "Provider catalog exposed secret material");
    assert(providers.body.profiles.find((profile) => profile.id === "m5-local-provider")?.credentialRef?.id === credentialRecord.id, "Provider profile did not retain an opaque credential reference");

    const sessionModels = await request(current.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/models`);
    const localGroup = sessionModels.body.providers.find((group) => group.provider === "m5-local-provider");
    assert(localGroup?.status === "ready" && localGroup.models.some((model) => model.model === "m5-model-a"), "saved Provider was not immediately available to the Session model directory");

    const selected = await request(current.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "m5-session-model-select" },
      body: JSON.stringify({ provider: "m5-local-provider", model: "m5-model-a" }),
    });
    const repeated = await request(current.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/model`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "m5-session-model-select" },
      body: JSON.stringify({ provider: "m5-local-provider", model: "m5-model-a" }),
    });
    assert(selected.body.selection?.provider === "m5-local-provider" && selected.body.selection?.model === "m5-model-a", "Session model selection did not use the Provider/model pair");
    assert(JSON.stringify(repeated.body) === JSON.stringify(selected.body), "repeated Session model selection was not idempotent");
    const eventsBeforeRestart = await request(current.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/events?format=json`);
    const selectionEvents = eventsBeforeRestart.body.filter((event) => event.type === "session/model_selected");
    assert(selectionEvents.length === 1, "Session model selection emitted duplicate durable events");
    assert(!eventsBeforeRestart.text.includes(secret), "event replay exposed secret material");
    const lastBeforeSelection = selectionEvents[0].sequence - 1;
    const sseReplay = await readSseReplay(current.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/events`, lastBeforeSelection, "session/model_selected");
    assert(sseReplay.includes("m5-local-provider") && !sseReplay.includes(secret), "SSE replay exposed the wrong route or secret material");

    await stopServer(current.server);
    current = await startServer({ databasePath, credentialSecretsPath, providerProfilesPath });
    const restored = await request(current.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/model`);
    assert(restored.body.selection?.provider === "m5-local-provider" && restored.body.selection?.model === "m5-model-a", "Session selection did not survive API restart");
    const restoredDirectory = await request(current.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/models`);
    assert(restoredDirectory.body.providers.find((group) => group.provider === "m5-local-provider")?.status === "ready", "Provider directory did not survive API restart");
    const restoredSse = await readSseReplay(current.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/events`, lastBeforeSelection, "session/model_selected");
    assert(restoredSse.includes("m5-model-a"), "SSE replay after restart missed the persisted Session selection");
    await request(current.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "M5 restart route check" }),
    }, 202);
    const projection = await waitFor("restored Provider-backed turn", async () => (await request(current.baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}`)).body, (value) => value.status === "idle" && value.messages.some((message) => message.content.includes("M5 restart route check")) && value.messages.some((message) => message.content.includes("Echo:")));
    assert(projection.messages.some((message) => message.content.includes("Echo: M5 restart route check")), "restored Session selection was not bound to the next turn");

    const profileFile = await readFile(providerProfilesPath, "utf8");
    assert(!profileFile.includes(secret), "durable Provider profile persisted secret material");
    const secretFile = await readFile(credentialSecretsPath, "utf8");
    assert(secretFile.includes(secret), "host-owned secret material was not durably persisted");
    return { sessionId, provider: "m5-local-provider", model: "m5-model-a", selectionEvents: selectionEvents.length, sseReplay: true, restartRecovery: true };
  } finally {
    await stopServer(current?.server).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runTenantIsolationScenario() {
  const makeProfile = (id, tenantId, displayName) => ({
    id,
    tenantId,
    displayName,
    protocol: "echo",
    models: [{ provider: id, model: `${id}-model` }],
    enabled: true,
    revision: 1,
    source: "custom",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  });
  const server = await startServer({
    productization: {
      auth: {
        required: true,
        tokens: [
          { token: "m5-tenant-a-token", principalId: "m5-user-a", tenantId: "m5-tenant-a" },
          { token: "m5-tenant-b-token", principalId: "m5-user-b", tenantId: "m5-tenant-b" },
        ],
      },
    },
    providerProfiles: [
      makeProfile("m5-tenant-a-ready", "m5-tenant-a", "Tenant A Ready"),
      makeProfile("m5-tenant-a-offline", "m5-tenant-a", "Tenant A Offline"),
      makeProfile("m5-tenant-b-only", "m5-tenant-b", "Tenant B Only"),
    ],
    providerDiscovery: async (profile) => {
      if (profile.id === "m5-tenant-a-offline") throw new Error("M5 provider unavailable");
      return profile.models;
    },
  });
  const auth = (token) => ({ authorization: `Bearer ${token}` });
  try {
    const tenantA = await request(server.baseUrl, "/v1/providers", { headers: auth("m5-tenant-a-token") });
    const tenantB = await request(server.baseUrl, "/v1/providers", { headers: auth("m5-tenant-b-token") });
    const groupsA = tenantA.body.providers;
    const groupsB = tenantB.body.providers;
    assert(groupsA.some((group) => group.provider === "m5-tenant-a-ready" && group.status === "ready"), "Tenant A ready Provider is missing");
    assert(groupsA.some((group) => group.provider === "m5-tenant-a-offline" && group.status === "failed" && group.error === "M5 provider unavailable"), "Provider-local discovery failure was not isolated");
    assert(!groupsA.some((group) => group.provider === "m5-tenant-b-only"), "Tenant B Provider leaked into Tenant A catalog");
    assert(groupsB.some((group) => group.provider === "m5-tenant-b-only"), "Tenant B Provider is missing from its own catalog");
    assert(!groupsB.some((group) => group.provider.startsWith("m5-tenant-a-")), "Tenant A Provider leaked into Tenant B catalog");
    return { tenantAProviders: groupsA.length, tenantBProviders: groupsB.length, isolatedFailure: true };
  } finally {
    await stopServer(server.server);
  }
}

async function runWebContractScenario() {
  const server = await startServer({});
  try {
    const shell = await request(server.baseUrl, "/");
    const browser = await request(server.baseUrl, "/web/browser.js");
    for (const marker of ["settings-provider-row", "settings-provider-editor", "API token (write-only)", "createCredential", "discoverProvider", "model-command-search", "Provider · Model", "event.stopPropagation(); modelMenuPane = 'models'"]) {
      assert(shell.text.includes(marker), `Web shell is missing ${marker}`);
    }
    assert(
      shell.text.includes("modelMenuPane = 'models';\n          renderModelSeatMenu();\n          dispatchOverlay({ type: 'toggle', overlay: 'model-popover' });") ||
        shell.text.includes("modelMenuPane = 'models';\r\n          renderModelSeatMenu();\r\n          dispatchOverlay({ type: 'toggle', overlay: 'model-popover' });"),
      "Composer model trigger must open the provider-grouped model pane directly",
    );
    assert(browser.text.includes("ModelDirectory") || browser.text.includes("createModelPopup"), "typed browser bundle is missing the shared model selection bridge");
    return { settingsEditor: true, modelPopup: true, credentialWriteOnly: true };
  } finally {
    await stopServer(server.server);
  }
}

try {
  const local = await runLocalRecoveryScenario();
  const tenant = await runTenantIsolationScenario();
  const web = await runWebContractScenario();
  console.log(JSON.stringify({ phase: "8.5", gate: "provider-model-ui-m5", passed: true, scenarios: { local, tenant, web } }));
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
