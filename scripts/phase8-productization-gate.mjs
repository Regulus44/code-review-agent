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
  const sessions = await (await fetch(`${fixture.baseUrl}/v1/sessions`, { headers: { authorization: "Bearer fixture-tenant-a-token" } })).json();
  assert(sessions.sessions?.length === 1 && sessions.sessions[0]?.ownership?.tenantId === "fixture-tenant-a", "tenant session catalog did not filter by ownership");
  const foreign = await fetch(`${fixture.baseUrl}/v1/sessions/${fixture.sessionId}`, { headers: { authorization: "Bearer fixture-tenant-b-token" } });
  assert(foreign.status === 404, "cross-tenant session access must be hidden");
  const firstTurn = await fetch(`${fixture.baseUrl}/v1/sessions/${fixture.sessionId}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-tenant-a-token" }, body: JSON.stringify({ content: "quota turn" }) });
  assert(firstTurn.status === 202, "first tenant turn should be accepted");
  const secondTurn = await fetch(`${fixture.baseUrl}/v1/sessions/${fixture.sessionId}`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-tenant-a-token" }, body: JSON.stringify({ content: "over quota" }) });
  assert(secondTurn.status === 429, "second tenant turn should be rejected by quota");
  const browserBundle = await readFile(join(root, "apps", "web", "dist", "browser.js"), "utf8");
  assert(browserBundle.includes("productization"), "typed browser bundle must carry productization capability state");
  console.log(JSON.stringify({ phase: "8.5", gate: "productization-capability-boundary", passed: true, status: productization.status, auth: productization.auth.status, tenantIsolation: productization.tenantIsolation.status, quota: productization.quota.status, checks: ["auth", "tenant-session-catalog", "cross-tenant-denial", "turn-quota", "credential-redaction"] }));
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
