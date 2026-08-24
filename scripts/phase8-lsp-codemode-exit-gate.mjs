/** Phase 8.3 bounded security exit audit.
 *
 * This gate certifies the controls that are implemented and keeps the
 * unsupported OS-level network isolation boundary explicit. A passing gate
 * therefore reports `status: partial` until an approved OS isolation adapter
 * exists; it must never be interpreted as full 8.3 completion.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const read = (relative) => readFile(join(root, relative), "utf8");
const [codeMode, codeModeTests, lsp, lspGate, settingsPresenter, webShell, browser, dockerfile, compose] = await Promise.all([
  read("packages/tools/src/code-mode.ts"),
  read("packages/tools/src/code-mode.test.ts"),
  read("packages/tools/src/lsp.ts"),
  read("scripts/phase8-lsp-codemode-gate.mjs"),
  read("apps/web/src/presentation/settings-presenter.ts"),
  read("apps/web/index.html"),
  read("apps/web/dist/browser.js"),
  read("Dockerfile"),
  read("docker-compose.yml"),
]);
const assert = (condition, message) => { if (!condition) throw new Error(`Phase 8.3 exit audit: ${message}`); };

const checks = [
  ["workspace-boundary", codeMode.includes("WorkspaceResolver") && codeMode.includes("--allow-fs-read=") && codeMode.includes("--allow-fs-write=") && lsp.includes("resolveExisting")],
  ["process-boundary", codeMode.includes("shell: false") && codeMode.includes("--no-addons") && codeMode.includes("AGENT_CODE_MODE")],
  ["network-deny-by-default", codeMode.includes("NETWORK_IMPORT_PATTERN") && codeMode.includes("CODE_MODE_NETWORK_DENIED") && codeModeTests.includes("globalThis.fetch")],
  ["os-isolation-fail-closed", codeMode.includes("CODE_MODE_OS_ISOLATION_UNAVAILABLE") && codeModeTests.includes("osNetworkIsolation: false") && codeModeTests.includes("networkEnforcement: \"os-required\"" )],
  ["os-isolation-adapters", codeMode.includes("LinuxNetworkNamespaceIsolationAdapter") && codeMode.includes("ContainerNetworkNoneIsolationAdapter") && codeMode.includes("--map-root-user") && codeMode.includes('"--network", "none"')],
  ["deployment-security-evidence", dockerfile.includes("USER app") && compose.includes("read_only: true") && compose.includes("no-new-privileges:true") && compose.includes("cap_drop:")],
  ["resource-bounds", codeMode.includes("maxCodeBytes") && codeMode.includes("maxRuntimeMs") && codeMode.includes("maxOutputBytes") && codeModeTests.includes("CODE_MODE_OUTPUT_LIMIT")],
  ["lsp-lifecycle-restart", lsp.includes("restart_requested") && lsp.includes("LSP_SERVER_CRASHED") && lspGate.includes("crash-once")],
  ["lsp-timeout-cancel", lsp.includes("LSP_TIMEOUT") && lsp.includes("LSP_CANCELLED") && lspGate.includes("controller.abort()")],
  ["web-host-backed-surface", webShell.includes("LSP diagnostics & source locations") && browser.includes("presentLspTool")],
];
for (const [name, passed] of checks) assert(passed, `${name} control is missing from source or fixture coverage`);

assert(codeMode.includes('networkEnforcement === "os-required"'), "OS-required policy no longer fails closed before execution");
assert(settingsPresenter.includes("OS isolation") && settingsPresenter.includes("osNetworkIsolation === true"), "Settings no longer explains the OS isolation boundary");

const residualRisks = [
  "OS-level network isolation adapter is not available; process-policy remains the only supported boundary.",
  "A full 8.3 exit requires a host-specific OS isolation assessment and deployment evidence.",
];
console.log(JSON.stringify({ phase: "8.3", gate: "lsp-codemode-bounded-exit-audit", passed: true, status: "partial", checks: checks.map(([name]) => name), residualRisks }));
