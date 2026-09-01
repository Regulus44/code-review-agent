/** Phase 8.3 deployment/isolation audit.
 *
 * This is a source-and-deployment policy gate. It proves that the repository
 * has an explicit OS/container adapter and that the default Docker deployment
 * does not grant ambient container privileges. It does not claim that a
 * particular host has Docker or unshare available at runtime.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const read = (relative) => readFile(join(root, relative), "utf8");
const [codeMode, codeModeTests, dockerfile, compose] = await Promise.all([
  read("packages/tools/src/code-mode.ts"),
  read("packages/tools/src/code-mode.test.ts"),
  read("Dockerfile"),
  read("docker-compose.yml"),
]);
const assert = (condition, message) => { if (!condition) throw new Error(`Phase 8.3 deployment audit: ${message}`); };

const checks = [
  ["explicit-isolation-contract", codeMode.includes("CodeModeIsolationAdapter") && codeMode.includes("networkEnforcement === \"os-required\"" )],
  ["linux-network-namespace-adapter", codeMode.includes("LinuxNetworkNamespaceIsolationAdapter") && codeMode.includes("--map-root-user") && codeMode.includes("--net")],
  ["container-network-none-adapter", codeMode.includes("ContainerNetworkNoneIsolationAdapter") && codeMode.includes('"--network", "none"') && codeMode.includes('"--read-only"')],
  ["container-privilege-drop", codeMode.includes("no-new-privileges:true") && codeMode.includes('"--cap-drop", "ALL"') && codeMode.includes('"--user", "10001:10001"')],
  ["isolation-test-evidence", codeModeTests.includes("container-network-none") && codeModeTests.includes("LinuxNetworkNamespaceIsolationAdapter")],
  ["non-root-image", dockerfile.includes("useradd --system --uid 10001") && dockerfile.includes("USER app")],
  ["compose-read-only", compose.includes("read_only: true") && compose.includes("no-new-privileges:true") && compose.includes("cap_drop:") && compose.includes("- ALL")],
  ["compose-no-host-network", !/network_mode:\s*host/i.test(compose) && !/privileged:\s*true/i.test(compose)],
];
for (const [name, passed] of checks) assert(passed, `${name} evidence is missing`);

assert(codeMode.includes("CODE_MODE_OS_ISOLATION_UNAVAILABLE"), "missing fail-closed error for unavailable host isolation");
assert(compose.includes("${CODING_AGENT_WORKSPACE_HOST_ROOT:-${CODE_REVIEW_WORKSPACE_HOST_ROOT:-.}}:/workspaces/project"), "workspace bind is not explicit, bounded, and backward compatible in compose");

console.log(JSON.stringify({
  phase: "8.3",
  gate: "deployment-isolation-audit",
  passed: true,
  status: "evidence-available-host-dependent",
  checks: checks.map(([name]) => name),
  runtimeNote: "The Linux namespace or Docker adapter must be explicitly configured by the host; unavailable capabilities remain fail-closed.",
}));
