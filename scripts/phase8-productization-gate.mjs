/** Phase 8.5 first-slice gate: productization capability is explicit and fail-closed. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const child = spawn(process.execPath, [join(root, "scripts", "phase8-web-fixture-server.mjs")], {
  cwd: root,
  env: { ...process.env, PHASE8_WEB_ROOT: join(root, "apps", "web") },
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
  const body = await response.json();
  const productization = body.productization;
  assert(response.status === 200, "capabilities endpoint did not respond successfully");
  assert(productization?.version === 1, "productization capability version must be 1");
  assert(productization.enabled === false && productization.status === "deferred", "local host must keep productization disabled/deferred");
  assert(productization.auth?.mode === "disabled" && productization.auth?.required === false, "auth must not be implicitly enabled");
  assert(productization.tenantIsolation?.status === "deferred" && productization.tenantIsolation?.sessionOwnership === "disabled", "tenant isolation must fail closed");
  assert(productization.quota?.status === "disabled" && productization.quota?.enforcement === "disabled", "quota must fail closed");
  assert(productization.credentials?.redaction === "required", "credential redaction must remain required");
  const browserBundle = await readFile(join(root, "apps", "web", "dist", "browser.js"), "utf8");
  assert(browserBundle.includes("productization"), "typed browser bundle must carry productization capability state");
  console.log(JSON.stringify({ phase: "8.5", gate: "productization-capability-boundary", passed: true, status: productization.status, auth: productization.auth.status, tenantIsolation: productization.tenantIsolation.status, quota: productization.quota.status }));
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
