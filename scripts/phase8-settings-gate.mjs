/** Phase 8.0 settings/model recovery fixture gate. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const child = spawn(process.execPath, [join(root, "scripts", "phase8-web-fixture-server.mjs")], {
  cwd: root,
  env: { ...process.env, PHASE8_WEB_ROOT: join(root, "apps", "web"), PHASE8_MODEL_FAILURES: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
const fixture = await new Promise((resolve, reject) => {
  const readline = createInterface({ input: child.stdout });
  const onExit = (code, signal) => reject(new Error(`Phase 8 settings fixture exited (${code ?? signal}): ${stderr}`));
  child.once("exit", onExit);
  readline.once("line", (value) => {
    child.removeListener("exit", onExit);
    readline.close();
    try { resolve(JSON.parse(value)); } catch (error) { reject(error); }
  });
});

const assert = (condition, message) => { if (!condition) throw new Error(`Phase 8.0 settings gate: ${message}`); };
async function request(pathname, init = {}) {
  const response = await fetch(`${fixture.baseUrl}${pathname}`, init);
  const text = await response.text();
  let body = text;
  try { body = text.length === 0 ? undefined : JSON.parse(text); } catch { /* text response */ }
  return { response, body };
}

try {
  const shell = await request("/");
  assert(shell.response.status === 200 && typeof shell.body === "string", "Web shell did not load");
  assert(shell.body.includes("Catalog status") && shell.body.includes("Retry model catalog"), "Settings retry surface is missing");

  const failed = await request("/v1/models");
  assert(failed.response.status === 503 && String(failed.body?.error).includes("temporarily unavailable"), "provider failure fixture did not fail explicitly");
  const recovered = await request("/v1/models");
  assert(recovered.response.status === 200 && recovered.body?.models?.[0] === "fixture-model", "model catalog did not recover on retry");
  const selected = await request("/v1/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture-model" }),
  });
  assert(selected.response.status === 200 && selected.body?.model?.model === "fixture-model", "recovered model catalog did not accept a model selection");
  const selectedCatalog = await request("/v1/models");
  assert(selectedCatalog.response.status === 200 && selectedCatalog.body?.current === "fixture-model", "model selection receipt was not reflected in the catalog");

  const sessions = await request("/v1/sessions");
  assert(sessions.response.status === 200 && sessions.body?.sessions?.length === 1, "model failure affected unrelated Session boot data");
  console.log(JSON.stringify({ phase: "8.0", gate: "settings-provider-failure-retry", passed: true, firstStatus: failed.response.status, recoveredStatus: recovered.response.status, selectedModel: selected.body.model.model }));
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
