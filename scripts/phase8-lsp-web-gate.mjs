/** Phase 8.3 real Web LSP/Code Mode fixture and replay gate. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const child = spawn(process.execPath, [join(root, "scripts", "phase8-lsp-fixture-server.mjs")], {
  cwd: root,
  env: { ...process.env, PHASE8_WEB_ROOT: join(root, "apps", "web") },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

const fixture = await new Promise((resolve, reject) => {
  const readline = createInterface({ input: child.stdout });
  const onExit = (code, signal) => reject(new Error(`Phase 8 LSP fixture exited (${code ?? signal}): ${stderr}`));
  child.once("exit", onExit);
  readline.once("line", (line) => {
    child.removeListener("exit", onExit);
    readline.close();
    try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
  });
});

function assert(condition, message) {
  if (!condition) throw new Error(`Phase 8.3 Web gate: ${message}`);
}

async function request(pathname, init = {}, expected = 200) {
  const response = await fetch(`${fixture.baseUrl}${pathname}`, init);
  const text = await response.text();
  let body = text;
  try { body = text.length === 0 ? undefined : JSON.parse(text); } catch { /* text response */ }
  assert(response.status === expected, `${init.method ?? "GET"} ${pathname} returned ${response.status}, expected ${expected}: ${text}`);
  return body;
}

try {
  const health = await request("/health");
  assert(health.runtime === "typescript" && health.persistence === "sqlite", "fixture is not using the durable TypeScript runtime");
  const capabilities = await request("/v1/capabilities");
  assert(capabilities.lsp?.configured === true && capabilities.lsp.servers.includes("default"), "LSP capability metadata did not reach the API");
  assert(capabilities.codeMode?.enabled === true, "Code Mode capability metadata did not reach the API");
  assert(capabilities.codeMode?.limits?.networkEnforcement === "process-policy" && capabilities.codeMode?.limits?.osNetworkIsolation === false, "API capability metadata overstated Code Mode network isolation");
  const tools = await request("/v1/tools");
  assert(tools.tools.some((tool) => tool.name === "lsp_diagnostics") && tools.tools.some((tool) => tool.name === "code_mode"), "LSP/Code Mode tools are missing from the host catalog");
  const shell = await request("/");
  assert(typeof shell === "string" && shell.includes("LSP diagnostics & source locations"), "Web shell is missing the LSP details surface");
  const browser = await request("/web/browser.js");
  assert(typeof browser === "string" && browser.includes("presentLspTool"), "typed browser bundle is missing the LSP presenter");

  const sessionPath = `/v1/sessions/${encodeURIComponent(fixture.sessionId)}`;
  const events = await request(`${sessionPath}/events?format=json`);
  const lspEvents = events.filter((event) => event.type === "lsp/server" || event.type === "lsp/request");
  const toolResults = events.filter((event) => event.type === "tool/result");
  assert(lspEvents.some((event) => event.type === "lsp/server" && event.payload?.action === "started"), "LSP server lifecycle event did not replay");
  assert(lspEvents.filter((event) => event.type === "lsp/request").length >= 3, "LSP request events did not replay for diagnostics/definition/references");
  assert(toolResults.some((event) => event.payload?.result?.output?.result?.items?.[0]?.message === "fixture diagnostic"), "diagnostics result did not reach the durable tool result");
  assert(toolResults.some((event) => event.payload?.result?.output?.result?.[0]?.uri === "file:///fixture.ts"), "source location result did not reach the durable tool result");
  assert(toolResults.some((event) => event.payload?.result?.error?.code === "CODE_MODE_NETWORK_DENIED"), "Code Mode network denial did not reach the durable tool result");
  assert(toolResults.some((event) => event.payload?.result?.output?.stdout?.includes("const value = 1")), "Code Mode workspace read result did not reach the durable tool result");

  const projection = await request(sessionPath);
  assert(projection.toolCalls.filter((call) => call.name.startsWith("lsp_")).length === 3, "session projection lost one or more LSP tool calls");
  assert(projection.toolCalls.some((call) => call.name === "code_mode" && call.status === "completed") && projection.toolCalls.some((call) => call.name === "code_mode" && call.status === "failed"), "Code Mode success and denied calls were not projected");
  const exported = await request(`${sessionPath}/export`);
  assert(exported.events.length === events.length && exported.session.id === fixture.sessionId, "LSP/Code Mode event replay was not preserved by export");
  console.log(JSON.stringify({ phase: "8.3", gate: "lsp-codemode-web-replay", passed: true, sessionId: fixture.sessionId, events: events.length, lspEvents: lspEvents.length }));
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
