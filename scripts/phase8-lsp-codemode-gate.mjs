/** Phase 8.3 LSP/Code Mode safety and recovery gate. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeModeSandbox, LspManager } from "../packages/tools/dist/index.js";

const root = await mkdtemp(join(tmpdir(), "code-review-agent-phase8-lsp-"));
const fixture = join(process.cwd(), "packages", "tools", "test-fixtures", "lsp-server.mjs");
const assert = (condition, message) => { if (!condition) throw new Error(`Phase 8.3 gate: ${message}`); };

try {
  await writeFile(join(root, "fixture.ts"), "const value = 1;\n", "utf8");
  const codeMode = new CodeModeSandbox({ enabled: true, maxRuntimeMs: 5_000, maxOutputBytes: 4_096 });
  const code = await codeMode.run({ code: "console.log(require('node:fs').readFileSync('fixture.ts', 'utf8'))" }, { workspaceRoot: root, signal: new AbortController().signal });
  assert(code.ok === true && code.output?.stdout.includes("const value"), "Code Mode success path did not read the workspace fixture");
  const network = await codeMode.run({ code: "fetch('https://example.com')" }, { workspaceRoot: root, signal: new AbortController().signal });
  assert(network.error?.code === "CODE_MODE_NETWORK_DENIED", "Code Mode network policy was bypassed");
  const output = await new CodeModeSandbox({ enabled: true, maxOutputBytes: 256 }).run({ code: "console.log('x'.repeat(10_000))" }, { workspaceRoot: root, signal: new AbortController().signal });
  assert(output.error?.code === "CODE_MODE_OUTPUT_LIMIT", "Code Mode output budget did not terminate the child");

  const events = [];
  const manager = new LspManager({ default: { command: process.execPath, args: [fixture], requestTimeoutMs: 1_000 } });
  try {
    const diagnostics = await manager.diagnostics({ path: "fixture.ts" }, root, new AbortController().signal, { appendEvent: async (type, payload) => events.push({ type, payload }) });
    assert(diagnostics.ok === true && diagnostics.output?.result?.items?.[0]?.message === "fixture diagnostic", "LSP diagnostics did not return the fixture result");
    const definition = await manager.definition({ path: "fixture.ts", line: 0, character: 0 }, root, new AbortController().signal);
    assert(definition.ok === true && definition.output?.result?.[0]?.uri === "file:///fixture.ts", "LSP definition did not return a source location");
  } finally { await manager.close(); }

  const marker = join(root, "crashed.marker");
  const restartEvents = [];
  const restarting = new LspManager({ default: { command: process.execPath, args: [fixture, marker, "crash-once"], requestTimeoutMs: 1_000 } });
  try {
    const result = await restarting.diagnostics({ path: "fixture.ts" }, root, new AbortController().signal, { appendEvent: async (type, payload) => restartEvents.push({ type, payload }) });
    assert(result.ok === true && restartEvents.some((event) => event.payload.action === "restart_requested"), "LSP crash recovery did not restart once");
  } finally { await restarting.close(); }

  const slow = new LspManager({ default: { command: process.execPath, args: [fixture, "", "slow"], requestTimeoutMs: 2_000 } });
  try {
    const controller = new AbortController();
    const pending = slow.diagnostics({ path: "fixture.ts" }, root, controller.signal);
    setTimeout(() => controller.abort(), 30);
    const cancelled = await pending;
    assert(cancelled.error?.code === "LSP_CANCELLED", "LSP cancellation did not settle with LSP_CANCELLED");
  } finally { await slow.close(); }

  console.log(JSON.stringify({ phase: "8.3", gate: "lsp-codemode-safety-recovery", passed: true, lspEvents: events.length }));
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
