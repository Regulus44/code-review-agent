/**
 * Phase 8.4 restart/replay fixture for orphaned and interrupted jobs.
 *
 * Seed mode writes durable job/terminal events without keeping a live child
 * process. Reopen mode starts a fresh AgentHost/API over the same SQLite file,
 * exercising JobManager recovery and the normal Web replay boundary.
 */
import { mkdir, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../apps/api/dist/server.js";
import { AgentHost } from "../packages/runtime/dist/index.js";
import { SqliteEventStore } from "../packages/storage/dist/index.js";

const mode = process.env.PHASE8_JOB_RECOVERY_MODE ?? "seed";
const root = process.env.PHASE8_JOB_RECOVERY_ROOT ?? await mkdtemp(join(tmpdir(), "coding-agent-phase8-job-recovery-"));
const databasePath = process.env.PHASE8_JOB_RECOVERY_DB ?? join(root, "events.sqlite");
const workspaceRoot = process.env.PHASE8_JOB_RECOVERY_WORKSPACE ?? join(root, "workspace");
await mkdir(workspaceRoot, { recursive: true });

const store = new SqliteEventStore({ databasePath });
const host = new AgentHost({ store });
let sessionId = process.env.PHASE8_JOB_RECOVERY_SESSION;
let liveJobIds = [];
const liveItems = boundedInteger(process.env.PHASE8_JOB_RECOVERY_LIVE_ITEMS ?? "36", 1, 200, "PHASE8_JOB_RECOVERY_LIVE_ITEMS");
const liveDelayMs = boundedInteger(process.env.PHASE8_JOB_RECOVERY_LIVE_DELAY_MS ?? "120", 0, 5_000, "PHASE8_JOB_RECOVERY_LIVE_DELAY_MS");
if (mode === "seed") {
  const session = await host.createSession(workspaceRoot, "danger-full-access");
  sessionId = session.id;
  const startedAt = new Date(Date.now() - 5_000).toISOString();
  const endedAt = new Date(Date.now() - 2_000).toISOString();
  await store.append({ sessionId: session.id, type: "user/message", payload: { content: "Phase 8 job recovery fixture" } });
  await store.append({ sessionId: session.id, type: "agent/status", payload: { status: "interrupted", reason: "fixture_restart" } });
  await store.append({ sessionId: session.id, type: "job/started", payload: { jobId: "job_orphaned_fixture", status: "running", command: "phase8 orphaned job", cwd: workspaceRoot, workspaceRoot, executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], startedAt, attempt: 1, maxAttempts: 2, retryable: true, spillPath: ".agent-artifacts/jobs/job_orphaned_fixture.log" } });
  await store.append({ sessionId: session.id, type: "job/output", payload: { jobId: "job_orphaned_fixture", stream: "stdout", text: "partial orphaned output\n", totalBytes: 24, bufferedBytes: 24, spillPath: ".agent-artifacts/jobs/job_orphaned_fixture.log" } });
  await store.append({ sessionId: session.id, type: "job/started", payload: { jobId: "job_completed_fixture", status: "running", command: "phase8 completed job", cwd: workspaceRoot, workspaceRoot, executable: process.execPath, args: ["-e", "process.stdout.write('ok')"], startedAt, attempt: 1, maxAttempts: 1, totalBytes: 0, spillPath: ".agent-artifacts/jobs/job_completed_fixture.log" } });
  await store.append({ sessionId: session.id, type: "job/output", payload: { jobId: "job_completed_fixture", stream: "stdout", text: "ok", totalBytes: 2, bufferedBytes: 2, spillPath: ".agent-artifacts/jobs/job_completed_fixture.log" } });
  await store.append({ sessionId: session.id, type: "job/ended", payload: { jobId: "job_completed_fixture", status: "completed", command: "phase8 completed job", cwd: workspaceRoot, workspaceRoot, endedAt, exitCode: 0, totalBytes: 2, attempt: 1, maxAttempts: 1, retryable: false, spillPath: ".agent-artifacts/jobs/job_completed_fixture.log" } });
  await store.append({ sessionId: session.id, type: "terminal/session", payload: { terminalId: "terminal_interrupted_fixture", status: "interrupted", action: "host_restart", command: "phase8 terminal", cwd: workspaceRoot, workspaceRoot, bufferedBytes: 18 } });
}
if (mode === "live") {
  const session = await host.createSession(workspaceRoot, "danger-full-access");
  sessionId = session.id;
  await store.append({ sessionId: session.id, type: "user/message", payload: { content: "Phase 8 concurrent live recovery fixture" } });
  const commands = [
    `$items=1..${liveItems}; foreach ($item in $items) { Write-Output ('matrix-alpha-' + $item); Start-Sleep -Milliseconds ${liveDelayMs} }`,
    `$items=1..${liveItems}; foreach ($item in $items) { Write-Output ('matrix-beta-' + $item); Start-Sleep -Milliseconds ${liveDelayMs} }`,
    `$items=1..${liveItems}; foreach ($item in $items) { Write-Output ('matrix-gamma-' + $item); Start-Sleep -Milliseconds ${liveDelayMs} }`,
  ];
  const started = await Promise.all(commands.map((command, index) => host.executeTool(
    session.id,
    "pwsh",
    { command, description: `Phase 8 concurrent live job ${index + 1}`, run_in_background: true },
    undefined,
    `phase8-live-job-${index + 1}`,
    undefined,
    "system",
  )));
  liveJobIds = started.map((result, index) => {
    const output = result.result?.output;
    const jobId = typeof output === "object" && output !== null && typeof output.jobId === "string" ? output.jobId : undefined;
    if (jobId === undefined) throw new Error(`Live recovery fixture job ${index + 1} did not return a durable job id: ${JSON.stringify(result)}`);
    return jobId;
  });
}
if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("Phase 8 job recovery fixture is missing a session id");

const webRoot = process.env.PHASE8_WEB_ROOT;
const server = createApiServer({ store, host, ...(webRoot === undefined ? {} : { webRoot }) });
await new Promise((resolve) => server.listen(Number(process.env.PHASE8_JOB_RECOVERY_PORT ?? 0), "127.0.0.1", resolve));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Phase 8 job recovery fixture server did not bind");
const baseUrl = `http://127.0.0.1:${address.port}`;
console.log(JSON.stringify({ mode, baseUrl, root, databasePath, workspaceRoot, sessionId, liveJobIds, ...(mode === "live" ? { liveItems, liveDelayMs } : {}) }));

async function cleanup() {
  await new Promise((resolve) => server.close(() => resolve()));
  await host.shutdown().catch(() => undefined);
  store.close();
  if (mode === "reopen" || mode === "live") await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
process.once("SIGINT", () => { void cleanup().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void cleanup().finally(() => process.exit(0)); });
await new Promise(() => undefined);

function boundedInteger(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
}
