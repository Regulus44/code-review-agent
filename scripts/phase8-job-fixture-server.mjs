/**
 * Phase 8.4 browser fixture for real Job Center actions.
 *
 * The fixture starts jobs through AgentHost.executeTool("pwsh"), so the same
 * ToolRuntime permission and durable job event path is used by the browser.
 */
import { mkdir, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../apps/api/dist/server.js";
import { AgentHost } from "../packages/runtime/dist/index.js";
import { SqliteEventStore } from "../packages/storage/dist/index.js";

const root = await mkdtemp(join(tmpdir(), "coding-agent-phase8-jobs-"));
const databasePath = join(root, "events.sqlite");
const workspaceRoot = join(root, "workspace");
await mkdir(workspaceRoot, { recursive: true });
const webRoot = process.env.PHASE8_WEB_ROOT;

const store = new SqliteEventStore({ databasePath });
const host = new AgentHost({ store });
const session = await host.createSession(workspaceRoot, "danger-full-access");
await store.append({ sessionId: session.id, type: "user/message", payload: { content: "Phase 8 Job Center browser fixture" } });

const pwsh = process.env.CODING_AGENT_PWSH ?? process.env.CODE_REVIEW_AGENT_PWSH ?? "pwsh";
const runningCommand = "Write-Output 'phase8-running'; Start-Sleep -Seconds 120";
const running = await host.executeTool(session.id, "pwsh", { command: runningCommand, description: "Phase 8 running job", run_in_background: true }, undefined, "phase8-job-start-running", undefined, "system");
if (!running.result?.ok && running.status !== "completed") throw new Error(`Unable to start running job: ${JSON.stringify(running)}`);
const runningJobId = typeof running.result?.output === "object" && running.result.output !== null && typeof running.result.output.jobId === "string" ? running.result.output.jobId : undefined;
if (runningJobId === undefined) throw new Error(`Running job did not return a durable job id: ${JSON.stringify(running)}`);

const marker = join(workspaceRoot, "retry.marker").replaceAll("'", "''");
const retryCommand = `$marker='${marker}'; if (!(Test-Path $marker)) { Set-Content -Path $marker -Value '1'; exit 2 }; Write-Output 'phase8-retry-ok'`;
const failed = await host.executeTool(session.id, "pwsh", { command: retryCommand, description: "Phase 8 retryable job", run_in_background: true, maxAttempts: 2 }, undefined, "phase8-job-start-retry", undefined, "system");
if (!failed.result?.ok && failed.status !== "completed") throw new Error(`Unable to start retry fixture: ${JSON.stringify(failed)}`);
const retryJobId = typeof failed.result?.output === "object" && failed.result.output !== null && typeof failed.result.output.jobId === "string" ? failed.result.output.jobId : undefined;
if (retryJobId === undefined) throw new Error(`Retry job did not return a durable job id: ${JSON.stringify(failed)}`);

const server = createApiServer({ store, host, ...(webRoot === undefined ? {} : { webRoot }) });
await new Promise((resolve) => server.listen(Number(process.env.PHASE8_JOB_FIXTURE_PORT ?? 0), "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Phase 8 job fixture server did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;
console.log(JSON.stringify({ baseUrl, databasePath, workspaceRoot, sessionId: session.id, runningJobId, retryJobId, pwsh }));

async function cleanup() {
  await new Promise((resolve) => server.close(() => resolve()));
  store.close();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
process.once("SIGINT", () => { void cleanup().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void cleanup().finally(() => process.exit(0)); });
await new Promise(() => undefined);
