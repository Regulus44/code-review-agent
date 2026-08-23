/** Phase 8.4 reliability gate for retry, deadline, shutdown, export, and diagnostics. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../packages/tools/dist/index.js";
import { InMemoryEventStore } from "../packages/storage/dist/index.js";
import { createApiServer } from "../apps/api/dist/server.js";

const root = await mkdtemp(join(tmpdir(), "code-review-agent-phase8-reliability-"));
const assert = (condition, message) => { if (!condition) throw new Error(`Phase 8.4 gate: ${message}`); };
const waitFor = async (predicate, attempts = 100, delayMs = 15) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("timed out waiting for reliability fixture");
};

let server;
try {
  const jobs = new JobManager();
  const marker = join(root, "retry.marker").replaceAll("\\", "/");
  const script = `const fs=require('node:fs'); if(!fs.existsSync('${marker}')){fs.writeFileSync('${marker}','1'); process.exit(2)}; process.stdout.write('retry-ok')`;
  const first = await jobs.start({ sessionId: "ses_phase8_reliability", workspaceRoot: root, cwd: root, executable: process.execPath, args: ["-e", script], command: "node retry", retry: { maxAttempts: 2 } });
  const firstId = first.output.jobId;
  await waitFor(() => jobs.list("ses_phase8_reliability", root)[0]?.status !== "running");
  assert(jobs.list("ses_phase8_reliability", root)[0]?.retryable === true, "failed job did not expose a retryable durable summary");
  const retried = await jobs.retry("ses_phase8_reliability", firstId, { backoffMs: 0 });
  const replacementId = retried.output.replacementJobId;
  assert(typeof replacementId === "string", "retry did not return a replacement job id");
  await waitFor(() => jobs.list("ses_phase8_reliability", root).find((job) => job.jobId === replacementId)?.status === "completed");

  const deadline = await jobs.start({ sessionId: "ses_phase8_reliability", workspaceRoot: root, cwd: root, executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], command: "node deadline", deadlineMs: 25 });
  const deadlineId = deadline.output.jobId;
  await waitFor(() => jobs.list("ses_phase8_reliability", root).find((job) => job.jobId === deadlineId)?.status !== "running");
  assert(jobs.list("ses_phase8_reliability", root).find((job) => job.jobId === deadlineId)?.lastError?.code === "JOB_DEADLINE_EXCEEDED", "deadline did not produce structured diagnostics");

  const running = await jobs.start({ sessionId: "ses_phase8_reliability", workspaceRoot: root, cwd: root, executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], command: "node shutdown" });
  await jobs.shutdown();
  assert(jobs.list("ses_phase8_reliability", root).find((job) => job.jobId === running.output.jobId)?.status === "cancelled", "shutdown did not cancel running jobs");

  const store = new InMemoryEventStore();
  const sessionId = await store.createSession(root);
  server = createApiServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const exportResponse = await fetch(`${baseUrl}/v1/sessions/${sessionId}/export`);
  assert(exportResponse.status === 200 && (await exportResponse.json()).session.id === sessionId, "session export route did not return replayable session state");
  const diagnosticsResponse = await fetch(`${baseUrl}/v1/diagnostics?sessionId=${sessionId}`);
  assert(diagnosticsResponse.status === 200 && (await diagnosticsResponse.json()).session.id === sessionId, "structured diagnostics route did not return session scope");
  const metricsResponse = await fetch(`${baseUrl}/v1/metrics`);
  assert(metricsResponse.status === 200 && typeof (await metricsResponse.json()).metrics?.turnsStarted === "number", "metrics route did not return runtime counters");
  const browserBundle = await readFile(join(process.cwd(), "apps", "web", "dist", "browser.js"), "utf8");
  for (const symbol of ["cancelJob", "retryJob", "presentRuntimeDiagnostics"]) assert(browserBundle.includes(symbol), `browser bundle is missing ${symbol}`);

  console.log(JSON.stringify({ phase: "8.4", gate: "reliability-retry-deadline-shutdown-export", passed: true, retry: true, deadline: true, shutdown: true }));
} finally {
  if (server !== undefined) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
