/** Phase 8.4 repeated restart/replay matrix for the Web Job Center surface. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureScript = join(root, "scripts", "phase8-job-recovery-fixture-server.mjs");
const webRoot = join(root, "apps", "web");
const children = new Set();
const assert = (condition, message) => { if (!condition) throw new Error(`Phase 8.4 recovery matrix: ${message}`); };

async function startFixture(env) {
  const child = spawn(process.execPath, [fixtureScript], { cwd: root, env: { ...process.env, PHASE8_WEB_ROOT: webRoot, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const fixture = await new Promise((resolve, reject) => {
    const lineReader = createInterface({ input: child.stdout });
    const onExit = (code, signal) => reject(new Error(`recovery fixture exited (${code ?? signal}): ${stderr}`));
    child.once("exit", onExit);
    lineReader.once("line", (line) => {
      child.removeListener("exit", onExit);
      lineReader.close();
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

async function readSse(baseUrl, pathname, stopWhen) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${pathname}`, { headers: { accept: "text/event-stream", "last-event-id": "0" }, signal: controller.signal });
  assert(response.status === 200 && response.body !== null, "SSE stream did not open");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < 8_000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (stopWhen(text)) break;
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

let seed;
let reopen;
let reopenAgain;
try {
  seed = await startFixture({ PHASE8_JOB_RECOVERY_MODE: "seed" });
  const sessionPath = `/v1/sessions/${encodeURIComponent(seed.sessionId)}`;
  const seedEvents = await request(seed.baseUrl, `${sessionPath}/events?format=json`);
  const seedJobs = await request(seed.baseUrl, `${sessionPath}/jobs`);
  assert(seedJobs.jobs.some((job) => job.status === "orphaned") && seedJobs.jobs.some((job) => job.status === "completed"), "seed matrix does not contain orphaned and completed jobs");
  const shell = await request(seed.baseUrl, "/");
  assert(shell.includes("Terminal & long-running jobs"), "Web shell is missing the Job Center recovery surface");
  const browser = await request(seed.baseUrl, "/web/browser.js");
  assert(browser.includes("presentRuntimeDiagnostics") && browser.includes("orphaned") && browser.includes("interrupted"), "browser bundle is missing recovery presenters or statuses");
  const sseSeed = await readSse(seed.baseUrl, `${sessionPath}/events`, (text) => text.includes("event: job/started") && text.includes("event: terminal/session"));
  assert(sseSeed.includes("event: job/started") && sseSeed.includes("event: terminal/session"), "seed SSE replay missed job/terminal events");
  await stopFixture(seed);

  const reopenEnv = { PHASE8_JOB_RECOVERY_MODE: "reopen", PHASE8_JOB_RECOVERY_ROOT: seed.root, PHASE8_JOB_RECOVERY_DB: seed.databasePath, PHASE8_JOB_RECOVERY_WORKSPACE: seed.workspaceRoot, PHASE8_JOB_RECOVERY_SESSION: seed.sessionId };
  reopen = await startFixture(reopenEnv);
  const reopenedProjection = await request(reopen.baseUrl, sessionPath);
  const reopenedEvents = await request(reopen.baseUrl, `${sessionPath}/events?format=json`);
  const reopenedJobs = await request(reopen.baseUrl, `${sessionPath}/jobs`);
  assert(reopenedProjection.status === "interrupted", "first reopen did not preserve interrupted session status");
  assert(reopenedEvents.length === seedEvents.length, "first reopen changed durable event count");
  assert(reopenedJobs.jobs.find((job) => job.jobId === "job_orphaned_fixture")?.status === "orphaned", "first reopen lost orphaned job status");
  const lastSequence = reopenedEvents.at(-1)?.sequence;
  assert(Number.isInteger(lastSequence), "reopened event stream has no terminal sequence");
  const emptyTail = await request(reopen.baseUrl, `${sessionPath}/events?format=json&after_sequence=${lastSequence}`);
  assert(Array.isArray(emptyTail) && emptyTail.length === 0, "reopen tail cursor was not empty at the terminal sequence");
  const exported = await request(reopen.baseUrl, `${sessionPath}/export`);
  const diagnostics = await request(reopen.baseUrl, `/v1/diagnostics?sessionId=${encodeURIComponent(reopen.sessionId)}`);
  assert(exported.events.length === reopenedEvents.length, "first reopen export changed event count");
  assert(diagnostics.jobs.some((job) => job.jobId === "job_orphaned_fixture" && job.status === "orphaned"), "first reopen diagnostics lost orphaned job");
  const sseReopen = await readSse(reopen.baseUrl, `${sessionPath}/events`, (text) => text.includes("event: agent/status") && text.includes("event: job/started"));
  assert(sseReopen.includes("event: agent/status") && sseReopen.includes("event: job/started"), "first reopen SSE replay missed session/job events");
  await stopFixture(reopen);

  reopenAgain = await startFixture(reopenEnv);
  const secondProjection = await request(reopenAgain.baseUrl, sessionPath);
  const secondEvents = await request(reopenAgain.baseUrl, `${sessionPath}/events?format=json`);
  const secondJobs = await request(reopenAgain.baseUrl, `${sessionPath}/jobs`);
  assert(secondProjection.status === "interrupted", "second reopen changed interrupted session status");
  assert(secondEvents.length === reopenedEvents.length && secondEvents.at(-1)?.sequence === lastSequence, "second reopen changed event sequence");
  assert(secondJobs.jobs.filter((job) => job.status === "orphaned").length === 1, "second reopen duplicated orphaned job projection");
  console.log(JSON.stringify({ phase: "8.4", gate: "job-recovery-restart-matrix", passed: true, scenarios: ["seed", "reopen", "reopen-again", "sse-replay", "tail-cursor", "export-diagnostics"], events: secondEvents.length, jobs: secondJobs.jobs.length }));
} finally {
  for (const child of [...children]) await stopFixture({ child });
}
