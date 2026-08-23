/**
 * Phase 8.4 real Job Center browser/replay gate.
 *
 * This exercises the same SQLite/API/Web fixture consumed by the browser. It
 * deliberately uses the public HTTP surface so job state, actions, replay and
 * bounded Web presentation are verified together.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const child = spawn(process.execPath, [join(root, "scripts", "phase8-job-fixture-server.mjs")], {
  cwd: root,
  env: { ...process.env, PHASE8_WEB_ROOT: join(root, "apps", "web") },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

const fixture = await new Promise((resolve, reject) => {
  const readline = createInterface({ input: child.stdout });
  const onExit = (code, signal) => reject(new Error(`Phase 8 Job fixture exited (${code ?? signal}): ${stderr}`));
  child.once("exit", onExit);
  readline.once("line", (line) => {
    child.removeListener("exit", onExit);
    readline.close();
    try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
  });
});

function assert(condition, message) {
  if (!condition) throw new Error(`Phase 8.4 Job browser gate: ${message}`);
}

async function request(pathname, init = {}, expected = 200) {
  const response = await fetch(`${fixture.baseUrl}${pathname}`, init);
  const text = await response.text();
  let body = text;
  try { body = text.length === 0 ? undefined : JSON.parse(text); } catch { /* text response */ }
  assert(response.status === expected, `${init.method ?? "GET"} ${pathname} returned ${response.status}, expected ${expected}: ${text}`);
  return body;
}

async function waitFor(label, read, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

try {
  const health = await request("/health");
  assert(health.runtime === "typescript" && health.persistence === "sqlite", "fixture is not the durable TypeScript runtime");
  const shell = await request("/");
  assert(typeof shell === "string" && shell.includes("Terminal & long-running jobs"), "Web shell is missing the Job Center details surface");
  const browser = await request("/web/browser.js");
  assert(typeof browser === "string" && browser.includes("presentRuntimeDiagnostics") && browser.includes("cancelJob") && browser.includes("retryJob"), "typed browser bundle is missing Job Center actions");

  const sessionPath = `/v1/sessions/${encodeURIComponent(fixture.sessionId)}`;
  const jobsPath = `${sessionPath}/jobs`;
  const jobs = await waitFor("initial job states", () => request(jobsPath), (body) => Array.isArray(body?.jobs) && body.jobs.some((job) => job.jobId === fixture.runningJobId && job.status === "running") && body.jobs.some((job) => job.jobId === fixture.retryJobId && job.status === "failed" && job.retryable === true));
  const running = jobs.jobs.find((job) => job.jobId === fixture.runningJobId);
  const retryable = jobs.jobs.find((job) => job.jobId === fixture.retryJobId);
  assert(running?.status === "running", "running fixture job did not remain visible as running");
  assert(retryable?.status === "failed" && retryable.retryable === true, "retry fixture did not expose a durable retryable failure");
  assert(typeof retryable.spillPath === "string" && retryable.spillPath.includes(".agent-artifacts/jobs"), "retry fixture did not expose bounded spill metadata");

  const cancelHeaders = { "content-type": "application/json", "idempotency-key": "phase8-job-cancel" };
  const cancelled = await request(`${jobsPath}/${encodeURIComponent(fixture.runningJobId)}/cancel`, { method: "POST", headers: cancelHeaders, body: "{}" });
  assert(cancelled.ok === true, "Cancel job action did not return success");
  const afterCancel = await waitFor("job cancellation", () => request(jobsPath), (body) => body.jobs.some((job) => job.jobId === fixture.runningJobId && job.status === "cancelled"));
  assert(afterCancel.jobs.find((job) => job.jobId === fixture.runningJobId)?.status === "cancelled", "cancelled job did not reach a terminal state");
  const cancelEventCount = (await request(`${sessionPath}/events?format=json`)).filter((event) => event.type === "job/ended" && event.payload?.jobId === fixture.runningJobId).length;
  const repeatedCancel = await request(`${jobsPath}/${encodeURIComponent(fixture.runningJobId)}/cancel`, { method: "POST", headers: cancelHeaders, body: "{}" });
  assert(repeatedCancel.ok === true, "Repeated Cancel job action did not return the idempotent result");
  const cancelEventCountAfter = (await request(`${sessionPath}/events?format=json`)).filter((event) => event.type === "job/ended" && event.payload?.jobId === fixture.runningJobId).length;
  assert(cancelEventCountAfter === cancelEventCount, "Repeated Cancel job action emitted a duplicate terminal event");

  const retryHeaders = { "content-type": "application/json", "idempotency-key": "phase8-job-retry" };
  const retried = await request(`${jobsPath}/${encodeURIComponent(fixture.retryJobId)}/retry`, { method: "POST", headers: retryHeaders, body: JSON.stringify({ backoffMs: 0 }) });
  assert(retried.ok === true && retried.output?.replacementJobId, "Retry job action did not return a replacement job id");
  const replacementJobId = retried.output.replacementJobId;
  const retryStartCount = (await request(`${sessionPath}/events?format=json`)).filter((event) => event.type === "job/started" && event.payload?.jobId === replacementJobId).length;
  const repeatedRetry = await request(`${jobsPath}/${encodeURIComponent(fixture.retryJobId)}/retry`, { method: "POST", headers: retryHeaders, body: JSON.stringify({ backoffMs: 0 }) });
  assert(repeatedRetry.ok === true, "Repeated Retry job action did not return the idempotent result");
  const retryStartCountAfter = (await request(`${sessionPath}/events?format=json`)).filter((event) => event.type === "job/started" && event.payload?.jobId === replacementJobId).length;
  assert(retryStartCountAfter === retryStartCount, "Repeated Retry job action emitted a duplicate replacement start");
  const afterRetry = await waitFor("retry completion", () => request(jobsPath), (body) => body.jobs.some((job) => job.jobId === replacementJobId && job.status === "completed"));
  assert(afterRetry.jobs.find((job) => job.jobId === replacementJobId)?.status === "completed", "replacement job did not complete");

  const events = await request(`${sessionPath}/events?format=json`);
  const types = new Set(events.map((event) => event.type));
  assert(types.has("job/started") && types.has("job/output") && types.has("job/ended"), "job lifecycle events are not replayable");
  assert(events.filter((event) => event.type === "job/started" && event.payload?.jobId === replacementJobId).length === 1, "retry created duplicate replacement start events");

  const diagnostics = await request(`/v1/diagnostics?sessionId=${encodeURIComponent(fixture.sessionId)}`);
  assert(Array.isArray(diagnostics.jobs) && diagnostics.jobs.some((job) => job.jobId === replacementJobId && job.status === "completed"), "diagnostics did not include completed retry job");
  const exported = await request(`${sessionPath}/export`);
  assert(exported.session?.id === fixture.sessionId && exported.events.length === events.length, "session export did not preserve the replayable job event stream");

  const source = await readFile(join(root, "apps", "web", "index.html"), "utf8");
  assert(source.includes("Cancel job") && source.includes("Retry job") && source.includes("Terminal & long-running jobs"), "static Web Job Center action contract is incomplete");
  console.log(JSON.stringify({ phase: "8.4", gate: "job-browser-replay-actions", passed: true, sessionId: fixture.sessionId, jobs: afterRetry.jobs.length, events: events.length, replacementJobId }));
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}
