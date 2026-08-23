/** Phase 8.4 API restart, SSE replay, orphaned/interrupted job gate. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "phase8-job-recovery-fixture-server.mjs");
const webRoot = join(root, "apps", "web");
const children = new Set();

function assert(condition, message) {
  if (!condition) throw new Error(`Phase 8.4 recovery gate: ${message}`);
}

async function startFixture(extraEnv = {}) {
  const child = spawn(process.execPath, [script], { cwd: root, env: { ...process.env, PHASE8_WEB_ROOT: webRoot, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const fixture = await new Promise((resolve, reject) => {
    const readline = createInterface({ input: child.stdout });
    const onExit = (code, signal) => reject(new Error(`Job recovery fixture exited (${code ?? signal}): ${stderr}`));
    child.once("exit", onExit);
    readline.once("line", (line) => {
      child.removeListener("exit", onExit);
      readline.close();
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
  });
  return { child, ...fixture };
}

async function stopFixture(fixture) {
  if (fixture === undefined || !children.has(fixture.child)) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    fixture.child.once("exit", () => { clearTimeout(timer); resolve(); });
    fixture.child.kill("SIGTERM");
  });
  children.delete(fixture.child);
}

async function request(baseUrl, pathname, init = {}, expected = 200) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let body = text;
  try { body = text.length === 0 ? undefined : JSON.parse(text); } catch { /* text response */ }
  assert(response.status === expected, `${init.method ?? "GET"} ${pathname} returned ${response.status}, expected ${expected}: ${text}`);
  return body;
}

async function readSsePrefix(baseUrl, pathname) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${pathname}`, { headers: { accept: "text/event-stream", "last-event-id": "0" }, signal: controller.signal });
  assert(response.status === 200 && response.body !== null, "SSE replay did not open after API restart");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < 1_500) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (text.includes("id: 1") && text.includes("event: session/created")) break;
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

let seed;
let reopened;
try {
  seed = await startFixture({ PHASE8_JOB_RECOVERY_MODE: "seed" });
  const sessionPath = `/v1/sessions/${encodeURIComponent(seed.sessionId)}`;
  const jobs = await request(seed.baseUrl, `${sessionPath}/jobs`);
  assert(jobs.jobs.some((job) => job.jobId === "job_orphaned_fixture" && job.status === "orphaned"), "seed API did not expose orphaned job state");
  assert(jobs.jobs.some((job) => job.jobId === "job_completed_fixture" && job.status === "completed"), "seed API did not expose completed job state");
  const beforeEvents = await request(seed.baseUrl, `${sessionPath}/events?format=json`);
  assert(beforeEvents.length >= 8, "seed event fixture is too small for recovery assertions");
  const sseBefore = await readSsePrefix(seed.baseUrl, `${sessionPath}/events`);
  assert(sseBefore.includes("event: job/started"), "seed SSE replay did not include job events");
  await stopFixture(seed);

  reopened = await startFixture({ PHASE8_JOB_RECOVERY_MODE: "reopen", PHASE8_JOB_RECOVERY_ROOT: seed.root, PHASE8_JOB_RECOVERY_DB: seed.databasePath, PHASE8_JOB_RECOVERY_WORKSPACE: seed.workspaceRoot, PHASE8_JOB_RECOVERY_SESSION: seed.sessionId });
  const replayedJobs = await request(reopened.baseUrl, `${sessionPath}/jobs`);
  const orphaned = replayedJobs.jobs.find((job) => job.jobId === "job_orphaned_fixture");
  const completed = replayedJobs.jobs.find((job) => job.jobId === "job_completed_fixture");
  assert(orphaned?.status === "orphaned" && orphaned.lastError === undefined, "API restart did not recover orphaned job metadata without inventing an error");
  assert(completed?.status === "completed" && completed.exitCode === 0, "API restart changed completed job state");
  assert(orphaned?.retryable === true, "recovered orphaned job lost its retryable metadata");

  const projection = await request(reopened.baseUrl, sessionPath);
  assert(projection.status === "interrupted", `reopened session status was ${projection.status}, expected interrupted`);
  const afterEvents = await request(reopened.baseUrl, `${sessionPath}/events?format=json`);
  assert(afterEvents.length === beforeEvents.length && afterEvents.at(-1)?.sequence === beforeEvents.at(-1)?.sequence, "API restart changed event sequence or duplicated events");
  const emptyTail = await request(reopened.baseUrl, `${sessionPath}/events?format=json&after_sequence=${beforeEvents.at(-1).sequence}`);
  assert(Array.isArray(emptyTail) && emptyTail.length === 0, "after_sequence replay did not preserve the disconnected tail cursor");
  const diagnostics = await request(reopened.baseUrl, `/v1/diagnostics?sessionId=${encodeURIComponent(reopened.sessionId)}`);
  assert(diagnostics.jobs.some((job) => job.jobId === "job_orphaned_fixture" && job.status === "orphaned"), "diagnostics lost orphaned job recovery");
  const exported = await request(reopened.baseUrl, `${sessionPath}/export`);
  assert(exported.events.length === afterEvents.length, "session export lost recovered job events");
  const sseAfter = await readSsePrefix(reopened.baseUrl, `${sessionPath}/events`);
  assert(sseAfter.includes("event: job/started") && sseAfter.includes("event: agent/status"), "SSE replay after API restart missed recovery events");
  const browser = await request(reopened.baseUrl, "/web/browser.js");
  assert(browser.includes("orphaned") && browser.includes("interrupted"), "typed browser bundle is missing recovery statuses");
  console.log(JSON.stringify({ phase: "8.4", gate: "api-restart-sse-orphaned-replay", passed: true, sessionId: reopened.sessionId, events: afterEvents.length, orphaned: orphaned.jobId, completed: completed.jobId }));
} finally {
  for (const fixture of [...children].map((child) => ({ child }))) await stopFixture(fixture);
}
