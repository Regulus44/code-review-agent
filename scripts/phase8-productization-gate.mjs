/** Phase 8.5 first-slice gate: productization capability is explicit and fail-closed. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const child = spawn(process.execPath, [join(root, "scripts", "phase8-web-fixture-server.mjs")], {
  cwd: root,
  env: { ...process.env, PHASE8_WEB_ROOT: join(root, "apps", "web"), PHASE8_PRODUCTIZATION: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
const fixture = await new Promise((resolve, reject) => {
  const readline = createInterface({ input: child.stdout });
  const onExit = (code, signal) => reject(new Error(`Phase 8 productization fixture exited (${code ?? signal}): ${stderr}`));
  child.once("exit", onExit);
  readline.once("line", (value) => {
    child.removeListener("exit", onExit);
    readline.close();
    try { resolve(JSON.parse(value)); } catch (error) { reject(error); }
  });
});

const assert = (condition, message) => { if (!condition) throw new Error(`Phase 8.5 productization gate: ${message}`); };
try {
  const response = await fetch(`${fixture.baseUrl}/v1/capabilities`);
  assert(response.status === 401, "missing bearer token must be rejected when auth is required");
  const authorized = await fetch(`${fixture.baseUrl}/v1/capabilities`, { headers: { authorization: "Bearer fixture-tenant-a-token" } });
  const body = await authorized.json();
  const productization = body.productization;
  assert(authorized.status === 200, "authorized capabilities endpoint did not respond successfully");
  assert(productization?.version === 1, "productization capability version must be 1");
  assert(productization.enabled === true && productization.status === "configured", "configured productization must be reported as enabled");
  assert(productization.auth?.mode === "bearer" && productization.auth?.required === true, "bearer auth metadata is missing");
  assert(productization.tenantIsolation?.status === "configured" && productization.tenantIsolation?.sessionOwnership === "durable", "tenant isolation metadata is missing");
  assert(productization.quota?.status === "configured" && productization.quota?.enforcement === "hard", "quota metadata is missing");
  assert(productization.credentials?.redaction === "required", "credential redaction must remain required");
  const modelHeaders = { authorization: "Bearer fixture-tenant-a-token" };
  const initialModels = await (await fetch(`${fixture.baseUrl}/v1/models`, { headers: modelHeaders })).json();
  assert(initialModels.current === "fixture-host-model" && initialModels.route === undefined, "tenant model catalog must start from the host route without a tenant override");
  const selectedModel = await fetch(`${fixture.baseUrl}/v1/models`, { method: "POST", headers: { ...modelHeaders, "content-type": "application/json" }, body: JSON.stringify({ model: "fixture-tenant-model-a" }) });
  assert(selectedModel.status === 200, "tenant model selection should be accepted");
  const selectedModelBody = await selectedModel.json();
  assert(selectedModelBody.route?.model === "fixture-tenant-model-a" && selectedModelBody.route?.provider === "deepseek", "tenant model route receipt is missing provider/model metadata");
  const routedCapabilities = await (await fetch(`${fixture.baseUrl}/v1/capabilities`, { headers: modelHeaders })).json();
  const foreignRoutedCapabilities = await (await fetch(`${fixture.baseUrl}/v1/capabilities`, { headers: { authorization: "Bearer fixture-tenant-b-token" } })).json();
  assert(routedCapabilities.productization?.routing?.status === "configured" && routedCapabilities.productization?.routing?.modelSelector === "tenant-scoped", "tenant routing readiness is missing from capabilities");
  assert(foreignRoutedCapabilities.productization?.routing?.status === "available" && foreignRoutedCapabilities.productization?.routing?.modelSelector === "host-local", "routing readiness leaked across tenants");
  const credentialResponse = await fetch(`${fixture.baseUrl}/v1/credentials`, { method: "POST", headers: { ...modelHeaders, "content-type": "application/json" }, body: JSON.stringify({ kind: "header", label: "Fixture provider", material: { headers: { authorization: "Bearer fixture-secret-value" } } }) });
  assert(credentialResponse.status === 201, "tenant credential creation should be accepted");
  const credentialBody = await credentialResponse.json();
  assert(!JSON.stringify(credentialBody).includes("fixture-secret-value"), "credential creation response leaked secret material");
  const credential = credentialBody.credential;
  const credentialCatalog = await (await fetch(`${fixture.baseUrl}/v1/credentials`, { headers: modelHeaders })).json();
  assert(credentialCatalog.credentials?.length === 1 && !JSON.stringify(credentialCatalog).includes("fixture-secret-value"), "credential catalog leaked secret material or wrong tenant scope");
  const foreignCredentialCatalog = await (await fetch(`${fixture.baseUrl}/v1/credentials`, { headers: { authorization: "Bearer fixture-tenant-b-token" } })).json();
  assert(Array.isArray(foreignCredentialCatalog.credentials) && foreignCredentialCatalog.credentials.length === 0, "credential metadata leaked across tenants");
  const foreignCredentialSelection = await fetch(`${fixture.baseUrl}/v1/models`, { method: "POST", headers: { authorization: "Bearer fixture-tenant-b-token", "content-type": "application/json" }, body: JSON.stringify({ model: "fixture-tenant-model-a", credentialRef: { id: credential.id, kind: credential.kind, version: credential.version } }) });
  assert(foreignCredentialSelection.status === 400, "cross-tenant credential reference must be rejected");
  const credentialSelected = await fetch(`${fixture.baseUrl}/v1/models`, { method: "POST", headers: { ...modelHeaders, "content-type": "application/json" }, body: JSON.stringify({ model: "fixture-tenant-model-a", credentialRef: { id: credential.id, kind: credential.kind, version: credential.version } }) });
  assert(credentialSelected.status === 200, "model route should accept an active credential reference");
  const credentialSelectedBody = await credentialSelected.json();
  assert(credentialSelectedBody.route?.credentialRef?.version === 1, "model route did not retain the credential version");
  const credentialDeleteWhileReferenced = await fetch(`${fixture.baseUrl}/v1/credentials/${encodeURIComponent(credential.id)}`, { method: "DELETE", headers: modelHeaders });
  assert(credentialDeleteWhileReferenced.status === 409, "referenced credential deletion must be rejected");
  const rotatedCredential = await fetch(`${fixture.baseUrl}/v1/credentials/${encodeURIComponent(credential.id)}/rotate`, { method: "POST", headers: { ...modelHeaders, "content-type": "application/json" }, body: JSON.stringify({ kind: "header", material: { headers: { authorization: "Bearer fixture-rotated-secret" } } }) });
  assert(rotatedCredential.status === 200, "credential rotation should be accepted");
  const rotatedCredentialBody = await rotatedCredential.json();
  assert(rotatedCredentialBody.credential?.version === 2 && !JSON.stringify(rotatedCredentialBody).includes("fixture-rotated-secret"), "credential rotation did not version metadata safely");
  const afterRotation = await (await fetch(`${fixture.baseUrl}/v1/models`, { headers: modelHeaders })).json();
  assert(afterRotation.route?.credentialRef?.version === 2, "model route was not rebound to the rotated credential");
  const revokedCredential = await fetch(`${fixture.baseUrl}/v1/credentials/${encodeURIComponent(credential.id)}/revoke`, { method: "POST", headers: modelHeaders });
  assert(revokedCredential.status === 200, "credential revoke should be accepted");
  const afterRevoke = await (await fetch(`${fixture.baseUrl}/v1/models`, { headers: modelHeaders })).json();
  assert(afterRevoke.route === undefined, "revoked credential must invalidate the model route");
  const credentialDelete = await fetch(`${fixture.baseUrl}/v1/credentials/${encodeURIComponent(credential.id)}`, { method: "DELETE", headers: modelHeaders });
  assert(credentialDelete.status === 200, "unreferenced revoked credential should be deletable");
  const tenantModels = await (await fetch(`${fixture.baseUrl}/v1/models`, { headers: modelHeaders })).json();
  const foreignModels = await (await fetch(`${fixture.baseUrl}/v1/models`, { headers: { authorization: "Bearer fixture-tenant-b-token" } })).json();
  assert(tenantModels.route === undefined && tenantModels.current === "fixture-host-model", "revoked credential did not clear the tenant model route");
  assert(foreignModels.route === undefined && foreignModels.current === "fixture-host-model", "tenant model route leaked across tenants");
  const sessions = await (await fetch(`${fixture.baseUrl}/v1/sessions`, { headers: { authorization: "Bearer fixture-tenant-a-token" } })).json();
  assert(sessions.sessions?.length === 1 && sessions.sessions[0]?.ownership?.tenantId === "fixture-tenant-a", "tenant session catalog did not filter by ownership");
  const workspaces = await (await fetch(`${fixture.baseUrl}/v1/workspaces`, { headers: { authorization: "Bearer fixture-tenant-a-token" } })).json();
  assert(workspaces.workspaces?.length === 1 && workspaces.workspaces[0]?.root === fixture.workspaceRoot, "tenant workspace catalog did not filter by ownership");
  const renamedWorkspace = await fetch(`${fixture.baseUrl}/v1/workspaces/${encodeURIComponent(fixture.workspaceRoot)}/label`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-tenant-a-token", "idempotency-key": "phase8-gate-workspace-rename" }, body: JSON.stringify({ label: "Tenant A workspace" }) });
  assert(renamedWorkspace.status === 200, "tenant workspace rename should be accepted");
  const renamedWorkspaceBody = await renamedWorkspace.json();
  assert(renamedWorkspaceBody.workspaces?.some((workspace) => workspace.root === fixture.workspaceRoot && workspace.label === "Tenant A workspace"), "tenant workspace rename did not replay scoped metadata");
  const foreignWorkspaceMutation = await fetch(`${fixture.baseUrl}/v1/workspaces/${encodeURIComponent(fixture.workspaceRoot)}/label`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-tenant-b-token", "idempotency-key": "phase8-gate-cross-tenant-workspace" }, body: JSON.stringify({ label: "Must not leak" }) });
  assert(foreignWorkspaceMutation.status === 404, "cross-tenant workspace mutation must be hidden");
  const mcpCreated = await fetch(`${fixture.baseUrl}/v1/mcp/servers`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-tenant-a-token" }, body: JSON.stringify({ name: "fixture-tenant-mcp", scope: "user", transport: "stdio", command: "fixture", enabled: false, start: false, env: { AUTH_TOKEN: "must-not-leak" } }) });
  assert(mcpCreated.status === 201, "tenant MCP config should be accepted");
  const tenantMcp = await (await fetch(`${fixture.baseUrl}/v1/mcp/servers`, { headers: { authorization: "Bearer fixture-tenant-a-token" } })).json();
  assert(tenantMcp.servers?.length === 1 && tenantMcp.servers[0]?.config?.tenantId === "fixture-tenant-a" && tenantMcp.servers[0]?.config?.env?.AUTH_TOKEN === "[redacted]", "tenant MCP catalog or credential redaction is incorrect");
  const foreignMcp = await (await fetch(`${fixture.baseUrl}/v1/mcp/servers`, { headers: { authorization: "Bearer fixture-tenant-b-token" } })).json();
  assert(Array.isArray(foreignMcp.servers) && foreignMcp.servers.length === 0, "tenant MCP catalog leaked across tenants");
  const foreignMcpCatalog = await fetch(`${fixture.baseUrl}/v1/mcp/servers/fixture-tenant-mcp/catalog`, { headers: { authorization: "Bearer fixture-tenant-b-token" } });
  assert(foreignMcpCatalog.status === 404, "cross-tenant MCP catalog must be hidden");
  const foreign = await fetch(`${fixture.baseUrl}/v1/sessions/${fixture.sessionId}`, { headers: { authorization: "Bearer fixture-tenant-b-token" } });
  assert(foreign.status === 404, "cross-tenant session access must be hidden");
  const firstTurn = await fetch(`${fixture.baseUrl}/v1/sessions/${fixture.sessionId}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-tenant-a-token" }, body: JSON.stringify({ content: "quota turn" }) });
  assert(firstTurn.status === 202, "first tenant turn should be accepted");
  const secondTurn = await fetch(`${fixture.baseUrl}/v1/sessions/${fixture.sessionId}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-tenant-a-token" }, body: JSON.stringify({ content: "over quota" }) });
  assert(secondTurn.status === 429, "second tenant turn should be rejected by quota");
  const browserBundle = await readFile(join(root, "apps", "web", "dist", "browser.js"), "utf8");
  assert(browserBundle.includes("productization"), "typed browser bundle must carry productization capability state");
  console.log(JSON.stringify({ phase: "8.5", gate: "productization-capability-boundary", passed: true, status: productization.status, auth: productization.auth.status, tenantIsolation: productization.tenantIsolation.status, quota: productization.quota.status, checks: ["auth", "tenant-session-catalog", "tenant-workspace-catalog", "tenant-workspace-mutation", "tenant-mcp-catalog", "tenant-mcp-denial", "tenant-model-routing", "tenant-model-denial", "tenant-credential-create", "tenant-credential-denial", "tenant-credential-rotation", "tenant-credential-revoke", "credential-reference-in-use", "credential-redaction", "cross-tenant-denial", "turn-quota"] }));
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
