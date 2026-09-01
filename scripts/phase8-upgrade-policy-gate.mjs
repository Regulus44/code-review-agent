/** Phase 8.5 upgrade/deployment policy evidence gate. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const policy = JSON.parse(await readFile(join(root, "docs/archive/phases/phase8-deployment-policy.json"), "utf8"));
const [dockerfile, compose] = await Promise.all([
  readFile(join(root, "Dockerfile"), "utf8"),
  readFile(join(root, "docker-compose.yml"), "utf8"),
]);
const assert = (condition, message) => { if (!condition) throw new Error(`Phase 8.5 upgrade policy gate: ${message}`); };

assert(policy.version === 1, "policy version is missing");
assert(policy.schema?.minimumSupported === 5 && policy.schema?.target === 7, "supported schema range is not explicit");
assert(policy.schema?.backupBeforeUpgrade === true, "upgrade must require a pre-upgrade backup");
assert(policy.schema?.migrationLock === "required", "upgrade must require a migration lock");
assert(Array.isArray(policy.schema?.readiness) && policy.schema.readiness.includes("health") && policy.schema.readiness.includes("sqlite-integrity") && policy.schema.readiness.includes("sse-replay"), "readiness checks are incomplete");
assert(policy.schema?.rollback === "retained-displaced-database", "rollback artifact policy is missing");
assert(policy.upgradeCapability === "deferred-until-deployment-smoke", "upgrade capability must remain deferred before deployment smoke");
assert(policy.runtimeSecurity?.nonRoot === true && policy.runtimeSecurity?.readOnlyRootFilesystem === true && policy.runtimeSecurity?.noNewPrivileges === true && policy.runtimeSecurity?.dropAllCapabilities === true && policy.runtimeSecurity?.boundedWorkspace === true, "runtime security policy is incomplete");
assert(dockerfile.includes("USER app") && dockerfile.includes("uid 10001"), "Dockerfile is not non-root");
assert(compose.includes("read_only: true") && compose.includes("no-new-privileges:true") && compose.includes("- ALL"), "Compose does not enforce runtime hardening");
assert(!/privileged:\s*true/i.test(compose) && !/network_mode:\s*host/i.test(compose), "Compose grants a forbidden ambient privilege");

console.log(JSON.stringify({ phase: "8.5", gate: "upgrade-deployment-policy", passed: true, schema: policy.schema, upgradeCapability: policy.upgradeCapability, runtimeSecurity: policy.runtimeSecurity }));
