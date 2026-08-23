/**
 * Phase 8.3 real Web fixture for LSP and Code Mode.
 *
 * The fixture executes read-only LSP tools and the optional Code Mode builtin
 * through AgentHost/ToolRuntime before exposing the normal API and Web shell.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../apps/api/dist/server.js";
import { AgentHost } from "../packages/runtime/dist/index.js";
import { CodeModeSandbox } from "../packages/tools/dist/index.js";
import { SqliteEventStore } from "../packages/storage/dist/index.js";

const root = await mkdtemp(join(tmpdir(), "code-review-agent-phase8-lsp-web-"));
const databasePath = join(root, "events.sqlite");
const workspaceRoot = join(root, "workspace");
await mkdir(workspaceRoot, { recursive: true });
await writeFile(join(workspaceRoot, "fixture.ts"), "const value = 1;\n", "utf8");

const lspFixture = join(process.cwd(), "packages", "tools", "test-fixtures", "lsp-server.mjs");
const store = new SqliteEventStore({ databasePath });
const host = new AgentHost({
  store,
  lspServers: { default: { command: process.execPath, args: [lspFixture], requestTimeoutMs: 1_000 } },
  codeMode: new CodeModeSandbox({ enabled: true, maxRuntimeMs: 5_000, maxOutputBytes: 4_096 }),
});
const session = await host.createSession(workspaceRoot, "danger-full-access");

const diagnostic = await host.executeTool(session.id, "lsp_diagnostics", { path: "fixture.ts" }, undefined, "phase8-lsp-diagnostics", undefined, "system");
const definition = await host.executeTool(session.id, "lsp_definition", { path: "fixture.ts", line: 0, character: 0 }, undefined, "phase8-lsp-definition", undefined, "system");
const references = await host.executeTool(session.id, "lsp_references", { path: "fixture.ts", line: 0, character: 0, includeDeclaration: true }, undefined, "phase8-lsp-references", undefined, "system");
const codeRead = await host.executeTool(session.id, "code_mode", { code: "console.log(require('node:fs').readFileSync('fixture.ts', 'utf8'))" }, undefined, "phase8-code-mode-read", undefined, "system");
const codeNetwork = await host.executeTool(session.id, "code_mode", { code: "fetch('https://example.com')" }, undefined, "phase8-code-mode-network", undefined, "system");
if (diagnostic.status !== "completed" || definition.status !== "completed" || references.status !== "completed") {
  throw new Error(`LSP fixture tool execution failed: ${JSON.stringify({ diagnostic, definition, references })}`);
}
if (codeRead.status !== "completed" || codeNetwork.status !== "failed" || codeNetwork.result?.error?.code !== "CODE_MODE_NETWORK_DENIED") {
  throw new Error(`Code Mode fixture tool execution failed: ${JSON.stringify({ codeRead, codeNetwork })}`);
}

const webRoot = process.env.PHASE8_WEB_ROOT;
const server = createApiServer({ store, host, ...(webRoot === undefined ? {} : { webRoot }) });
await new Promise((resolve) => server.listen(Number(process.env.PHASE8_LSP_FIXTURE_PORT ?? 0), "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Phase 8 LSP fixture server did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;
console.log(JSON.stringify({ baseUrl, databasePath, workspaceRoot, sessionId: session.id, lspServerId: "default" }));

async function cleanup() {
  await new Promise((resolve) => server.close(() => resolve()));
  await host.shutdown().catch(() => undefined);
  store.close();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
process.once("SIGINT", () => { void cleanup().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void cleanup().finally(() => process.exit(0)); });
await new Promise(() => undefined);
