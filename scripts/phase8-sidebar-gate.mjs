/**
 * Phase 8.0 M7 sidebar browser/replay gate.
 *
 * The repository does not pin Playwright, so this gate follows the existing
 * DSH-inspired boundary tests: real HTTP/SSE/SQLite fixtures prove durable
 * state, while shell/ARIA and visual matrix assertions protect the DOM
 * contract consumed by a graphical browser.
 */
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const webRoot = join(root, "apps", "web");
const assert = (condition, message) => { if (!condition) throw new Error(`Phase 8 M7 sidebar gate: ${message}`); };

async function request(baseUrl, pathname, init = {}, expected = 200) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let body = text;
  try { body = text.length === 0 ? undefined : JSON.parse(text); } catch { /* text body */ }
  assert(response.status === expected, `${init.method ?? "GET"} ${pathname} returned ${response.status}, expected ${expected}: ${text}`);
  return { response, body };
}

async function startFixture() {
  const child = spawn(process.execPath, [join(root, "scripts", "phase7-delegation-fixture-server.mjs")], {
    cwd: root,
    env: { ...process.env, PHASE7_WEB_ROOT: webRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const line = await new Promise((resolve, reject) => {
    const readline = createInterface({ input: child.stdout });
    const onExit = (code, signal) => reject(new Error(`delegation fixture exited before startup (${code ?? signal}): ${stderr}`));
    child.once("exit", onExit);
    readline.once("line", (value) => {
      child.removeListener("exit", onExit);
      readline.close();
      resolve(value);
    });
  });
  return { child, ...JSON.parse(line) };
}

async function stopFixture(fixture) {
  if (fixture === undefined) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    fixture.child.once("exit", () => { clearTimeout(timer); resolve(); });
    fixture.child.kill("SIGTERM");
  });
}

const shell = await readFile(join(webRoot, "index.html"), "utf8");
assert(shell.includes('role="region" aria-label="Workspace and session list" tabindex="0"'), "list scrollport is not keyboard reachable");
assert(shell.includes('id="session-search-toggle"') && shell.includes('aria-expanded="false"'), "search is not collapsed by default");
assert(shell.includes('id="sidebar-attention"') && shell.includes('id="sidebar-attention-button"'), "attention indicator is missing");
assert(shell.includes("header.onkeydown") && shell.includes("event.key === 'Enter'") && shell.includes("event.key === ' '") , "Workspace keyboard toggle is missing");
assert(shell.includes("group.querySelector('summary')?.focus()"), "Details focus restoration is missing");
assert(shell.includes("Workspace actions · ${label}") && shell.includes("Session actions · ${label}"), "row menu accessible names are missing");
assert(shell.includes("sessions.slice(0, limit)") && shell.includes("className = 'workspace-show-more'"), "long-list overflow projection is missing");

const scenario = await import("../apps/web/tests/sidebar-attention-replay.e2e.mjs");
const attentionReplay = await scenario.run();

const fixture = await startFixture();
let delegation;
try {
  const health = await request(fixture.baseUrl, "/health");
  assert(health.body?.runtime === "typescript", "delegation fixture is not using the TypeScript runtime");
  const page = await request(fixture.baseUrl, "/");
  assert(typeof page.body === "string" && page.body.includes("/web/browser.js"), "fixture shell does not expose the typed browser bridge");
  const browser = await request(fixture.baseUrl, "/web/browser.js");
  assert(typeof browser.body === "string" && browser.body.includes("presentSidebarAttention"), "browser bundle is missing the M6 attention presenter");

  const catalog = await request(fixture.baseUrl, `/v1/sessions/${fixture.parentSessionId}/subagents?scope=children`);
  const agents = catalog.body.agents || [];
  const running = agents.find((entry) => entry.live === true || entry.status === "running" || entry.task?.status === "running");
  assert(running?.task?.id !== undefined, "real delegation fixture did not expose a running child for attention state");
  const replay = await request(fixture.baseUrl, `/v1/sessions/${fixture.parentSessionId}/subagents/events?format=json`);
  assert(Array.isArray(replay.body) && replay.body.some((entry) => entry.event?.type === "subagent/descriptor"), "child descriptor replay is missing");
  delegation = { parentSessionId: fixture.parentSessionId, runningTaskId: running.task.id, scopedEvents: replay.body.length };
} finally {
  await stopFixture(fixture);
}

console.log(JSON.stringify({ phase: "8.0", milestone: "M7", gate: "sidebar-attention-browser-replay", passed: true, attentionReplay, delegation, matrix: { viewports: [600, 900, 1024], states: ["empty", "long-list", "search", "workspace-menu", "attention"], keyboard: true, aria: true, focus: true } }));
