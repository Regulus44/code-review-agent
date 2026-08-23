/**
 * Phase 7.10 unified browser/replay gate.
 *
 * The fixture servers expose the same API and static Web shell used by the
 * normal app. This gate keeps the browser scenarios reproducible in CI even
 * when a graphical browser is unavailable: it asserts the host-backed
 * snapshots, event replay, permission/recovery commands, delegation scope,
 * artifact access and bounded trajectory pages that the browser consumes.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = fileURLToPath(new URL("..", import.meta.url));
const scripts = join(root, "scripts");
const webRoot = join(root, "apps", "web");
const children = new Set();
const metrics = {};

function assert(condition, message) {
  if (!condition) throw new Error(`Phase 7 browser gate: ${message}`);
}

async function startFixture(script, extraEnv = {}) {
  const child = spawn(process.execPath, [join(scripts, script)], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const line = await new Promise((resolve, reject) => {
    const readline = createInterface({ input: child.stdout });
    const onExit = (code, signal) => reject(new Error(`${script} exited before startup (${code ?? signal}): ${stderr}`));
    child.once("exit", onExit);
    readline.once("line", (value) => {
      child.removeListener("exit", onExit);
      readline.close();
      resolve(value);
    });
  });
  try {
    return { child, ...JSON.parse(line) };
  } catch (error) {
    throw new Error(`${script} returned invalid startup JSON: ${error.message}`);
  }
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
  const started = performance.now();
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const elapsed = performance.now() - started;
  metrics.httpMs = Math.max(metrics.httpMs ?? 0, elapsed);
  const text = await response.text();
  let body = text;
  try { body = text.length === 0 ? undefined : JSON.parse(text); } catch { /* text response */ }
  assert(response.status === expected, `${init.method ?? "GET"} ${pathname} returned ${response.status}, expected ${expected}`);
  return { response, body, elapsed };
}

async function waitFor(label, read, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Phase 7 browser gate timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

function eventTypes(events) {
  return new Set(events.map((event) => event.type));
}

async function runCodingScenarios() {
  const fixture = await startFixture("phase7-coding-fixture-server.mjs", { PHASE7_WEB_ROOT: webRoot });
  try {
    const health = await request(fixture.baseUrl, "/health");
    assert(health.body?.runtime === "typescript", "coding fixture is not using the TypeScript runtime");
    const shell = await request(fixture.baseUrl, "/");
    assert(typeof shell.body === "string" && shell.body.includes("/web/browser.js"), "Web shell does not reference the typed browser bridge");
    const browserAsset = await request(fixture.baseUrl, "/web/browser.js");
    assert(typeof browserAsset.body === "string" && browserAsset.body.length > 10_000, "browser bundle is missing or unexpectedly small");
    assert(browserAsset.body.includes("reorderWorkspaces"), "browser bundle is missing the typed workspace reorder command");

    const workspaceCatalog = (await request(fixture.baseUrl, "/v1/workspaces")).body;
    assert(Array.isArray(workspaceCatalog.workspaces) && workspaceCatalog.workspaces.length >= 3, "Coding fixture workspace catalog is incomplete");
    const workspaceOrder = workspaceCatalog.workspaces.map((workspace) => workspace.key).reverse();
    const workspaceHeaders = { "content-type": "application/json", "idempotency-key": "phase7-gate-workspace-order" };
    const workspaceMoved = await request(fixture.baseUrl, "/v1/workspaces/reorder", { method: "POST", headers: workspaceHeaders, body: JSON.stringify({ order: workspaceOrder }) });
    assert(workspaceMoved.body.workspaces.map((workspace) => workspace.key).join("|") === workspaceOrder.join("|"), "Workspace reorder response did not preserve the requested order");
    const workspaceRepeated = await request(fixture.baseUrl, "/v1/workspaces/reorder", { method: "POST", headers: workspaceHeaders, body: JSON.stringify({ order: workspaceOrder }) });
    assert(JSON.stringify(workspaceRepeated.body) === JSON.stringify(workspaceMoved.body), "Repeated workspace reorder did not return the durable catalog");
    assert(browserAsset.body.includes("presentRuntimeDiagnostics"), "browser bundle is missing typed terminal/job diagnostics presenter");

    const readId = fixture.scenarios.readOnly.sessionId;
    const read = (async () => (await request(fixture.baseUrl, `/v1/sessions/${readId}`)).body) ;
    const readProjection = await read();
    assert(readProjection.messages.some((message) => message.role === "assistant" && message.content.includes("fixtureValue = 42")), "Read-only assistant summary is missing");
    assert(readProjection.toolCalls.some((call) => call.name === "read_file" && call.status === "completed"), "Read-only tool result is not completed");
    assert(readProjection.turns.some((turn) => turn.status === "completed"), "Read-only turn did not complete");
    const readEvents = (await request(fixture.baseUrl, `/v1/sessions/${readId}/events?format=json`)).body;
    assert(Array.isArray(readEvents) && eventTypes(readEvents).has("tool/call") && eventTypes(readEvents).has("tool/result"), "Read-only replay is incomplete");

    const capabilities = (await request(fixture.baseUrl, "/v1/capabilities")).body;
    assert(capabilities.attachments?.enabled === true && capabilities.attachments.maxBytes === 524_288, "Attachment capability metadata is missing or unbounded");
    const attachmentHeaders = { "content-type": "application/json", "idempotency-key": "phase7-gate-attachment-accepted" };
    const attachmentBody = { fileName: "browser-note.txt", mediaType: "text/plain", data: Buffer.from("phase7 browser attachment\n", "utf8").toString("base64") };
    const attachment = await request(fixture.baseUrl, `/v1/sessions/${readId}/attachments`, { method: "POST", headers: attachmentHeaders, body: JSON.stringify(attachmentBody) }, 201);
    assert(attachment.body?.status === "accepted" && typeof attachment.body.relativePath === "string", "Accepted attachment receipt is incomplete");
    const attachmentRepeat = await request(fixture.baseUrl, `/v1/sessions/${readId}/attachments`, { method: "POST", headers: attachmentHeaders, body: JSON.stringify(attachmentBody) }, 201);
    assert(JSON.stringify(attachmentRepeat.body) === JSON.stringify(attachment.body), "Repeated attachment upload did not return the durable receipt");
    const attachmentRejected = await request(fixture.baseUrl, `/v1/sessions/${readId}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "phase7-gate-attachment-rejected" },
      body: JSON.stringify({ fileName: "browser-note.exe", mediaType: "application/x-msdownload", data: Buffer.from("blocked", "utf8").toString("base64") }),
    });
    assert(attachmentRejected.body?.status === "rejected" && attachmentRejected.body.code === "ATTACHMENT_MEDIA_TYPE_DENIED", "Attachment rejection receipt is missing the type policy code");
    const attachmentEvents = (await request(fixture.baseUrl, `/v1/sessions/${readId}/events?format=json`)).body;
    assert(eventTypes(attachmentEvents).has("attachment/received") && eventTypes(attachmentEvents).has("attachment/rejected"), "Attachment receipts are not present in event replay");

    const editId = fixture.scenarios.edit.sessionId;
    const editBefore = await (await request(fixture.baseUrl, `/v1/sessions/${editId}`)).body;
    const editPermission = editBefore.permissions.find((permission) => permission.status === "pending");
    assert(editPermission?.toolName === "edit_file", "Edit fixture did not expose a pending edit permission");
    const editKey = `phase7-gate-edit-${editPermission.id}`;
    await request(fixture.baseUrl, `/v1/sessions/${editId}/permissions/${editPermission.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": editKey },
      body: JSON.stringify({ status: "approved" }),
    });
    const editAfter = await waitFor("Edit approval", async () => (await request(fixture.baseUrl, `/v1/sessions/${editId}`)).body, (projection) => projection.toolCalls.some((call) => call.name === "edit_file" && call.status === "completed") && projection.messages.some((message) => message.role === "assistant" && /approved|diff/iu.test(message.content)));
    assert(editAfter.messages.some((message) => message.role === "assistant" && /approved|diff/iu.test(message.content)), "Edit summary does not mention the approved change or resulting diff");
    const editEvents = (await request(fixture.baseUrl, `/v1/sessions/${editId}/events?format=json`)).body;
    const editTypes = eventTypes(editEvents);
    assert(editTypes.has("tool/result") && [...editTypes].some((type) => type.startsWith("permission/")), `Edit replay misses permission/tool settlement events: ${[...editTypes].join(",")}`);

    const recoveryId = fixture.scenarios.testRecovery.sessionId;
    const recoveryBefore = await (await request(fixture.baseUrl, `/v1/sessions/${recoveryId}`)).body;
    const recoveryPermission = recoveryBefore.permissions.find((permission) => permission.status === "pending");
    assert(recoveryBefore.status === "interrupted", `Test/Recovery session status is ${recoveryBefore.status}, expected interrupted after restart`);
    assert(recoveryPermission?.toolName === "run_tests", "Test/Recovery pending run_tests permission is missing");
    const recoveryKey = `phase7-gate-recovery-${recoveryPermission.id}`;
    const approved = await request(fixture.baseUrl, `/v1/sessions/${recoveryId}/permissions/${recoveryPermission.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": recoveryKey },
      body: JSON.stringify({ status: "approved" }),
    });
    const recoveryAfter = await waitFor("Test/Recovery approval and replay", async () => (await request(fixture.baseUrl, `/v1/sessions/${recoveryId}`)).body, (projection) => projection.toolCalls.some((call) => call.name === "run_tests" && call.status === "completed"));
    assert(recoveryAfter.turns.some((turn) => turn.status === "interrupted" || turn.status === "completed"), "Test/Recovery turn projection disappeared after approval");
    const recoveryEvents = (await request(fixture.baseUrl, `/v1/sessions/${recoveryId}/events?format=json`)).body;
    const recoveryToolCallCount = recoveryEvents.filter((event) => event.type === "tool/call").length;
    const duplicate = await request(fixture.baseUrl, `/v1/sessions/${recoveryId}/permissions/${recoveryPermission.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": recoveryKey },
      body: JSON.stringify({ status: "approved" }),
    });
    assert(JSON.stringify(duplicate.body) === JSON.stringify(approved.body), "Repeated recovery approval did not return the idempotent result");
    const recoveryEventsAfter = (await request(fixture.baseUrl, `/v1/sessions/${recoveryId}/events?format=json`)).body;
    assert(recoveryEventsAfter.filter((event) => event.type === "tool/call").length === recoveryToolCallCount, "Repeated recovery approval executed the tool again");
    assert(eventTypes(recoveryEventsAfter).has("agent/status"), "Recovery replay lacks agent status transition");

    return {
      readOnly: { sessionId: readId, events: attachmentEvents.length, attachment: attachment.body.id },
      edit: { sessionId: editId, events: editEvents.length, permission: editPermission.id },
      testRecovery: { sessionId: recoveryId, events: recoveryEventsAfter.length, permission: recoveryPermission.id },
    };
  } finally {
    await stopFixture(fixture);
  }
}

async function runDelegationScenario() {
  const fixture = await startFixture("phase7-delegation-fixture-server.mjs");
  try {
    const parentId = fixture.parentSessionId;
    const catalog = () => request(fixture.baseUrl, `/v1/sessions/${parentId}/subagents`).then((result) => result.body.agents);
    const agents = await waitFor("Delegation child settlement", catalog, (entries) => entries.length === 2 && entries.some((entry) => entry.task.report?.status === "completed"));
    const completed = agents.find((entry) => entry.task.report?.status === "completed");
    const cancellable = agents.find((entry) => entry.live);
    assert(completed?.task.childSessionId !== undefined, "Delegation completed child session is missing");
    assert(cancellable?.task.id !== undefined, "Delegation cancellable child is missing");
    const childOutput = (await request(fixture.baseUrl, `/v1/sessions/${parentId}/subagents/${completed.task.id}`)).body;
    assert(Array.isArray(childOutput.events) && childOutput.events.length > 0, "Delegation child history is empty");
    assert(childOutput.report?.status === "completed", "Delegation child report is not completed");
    const scopedEvents = (await request(fixture.baseUrl, `/v1/sessions/${parentId}/subagents/events?format=json`)).body;
    assert(scopedEvents.some((item) => item.sessionId === parentId) && scopedEvents.some((item) => item.sessionId === completed.task.childSessionId), "Scoped parent/child replay is incomplete");

    const reportArtifact = completed.task.artifacts.find((artifact) => artifact.id.endsWith("_external") === false && artifact.id.endsWith("_unsafe") === false);
    const externalArtifact = completed.task.artifacts.find((artifact) => artifact.id.endsWith("_external"));
    const unsafeArtifact = completed.task.artifacts.find((artifact) => artifact.id.endsWith("_unsafe"));
    assert(reportArtifact?.id !== undefined && externalArtifact?.id !== undefined && unsafeArtifact?.id !== undefined, "Delegation artifact boundary fixture is incomplete");
    const metadata = (await request(fixture.baseUrl, `/v1/sessions/${parentId}/artifacts/${encodeURIComponent(reportArtifact.id)}`)).body;
    assert(metadata.availability === "available" && typeof metadata.artifact?.path === "string", "Workspace artifact is not available within the parent workspace");
    const inline = await request(fixture.baseUrl, `/v1/sessions/${parentId}/artifacts/${encodeURIComponent(reportArtifact.id)}/content`);
    assert(inline.response.headers.get("content-disposition")?.startsWith("inline"), "Artifact inline disposition is missing");
    const download = await request(fixture.baseUrl, `/v1/sessions/${parentId}/artifacts/${encodeURIComponent(reportArtifact.id)}/content?download=true`);
    assert(download.response.headers.get("content-disposition")?.startsWith("attachment"), "Artifact download disposition is missing");
    const external = (await request(fixture.baseUrl, `/v1/sessions/${parentId}/artifacts/${encodeURIComponent(externalArtifact.id)}`)).body;
    const unsafe = (await request(fixture.baseUrl, `/v1/sessions/${parentId}/artifacts/${encodeURIComponent(unsafeArtifact.id)}`)).body;
    assert(external.availability === "external" && unsafe.availability === "blocked", "External or unsafe artifact escaped the workspace policy");
    await request(fixture.baseUrl, `/v1/sessions/${parentId}/artifacts/${encodeURIComponent(externalArtifact.id)}/content`, {}, 409);

    await request(fixture.baseUrl, `/v1/sessions/${parentId}/tasks/${cancellable.task.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": `phase7-gate-cancel-${cancellable.task.id}` },
      body: JSON.stringify({}),
    });
    const cancelled = await waitFor("Delegation cancellation", catalog, (entries) => entries.some((entry) => entry.task.id === cancellable.task.id && entry.status === "cancelled" && !entry.live));
    assert(cancelled.some((entry) => entry.task.id === cancellable.task.id && entry.task.report?.status === "cancelled"), "Delegation cancellation report is missing");
    return { parentSessionId: parentId, childCount: agents.length, scopedEvents: scopedEvents.length, completedTaskId: completed.task.id, cancelledTaskId: cancellable.task.id };
  } finally {
    await stopFixture(fixture);
  }
}

async function runInspectionScenario() {
  const fixture = await startFixture("phase7-trajectory-fixture-server.mjs");
  try {
    const sessionId = fixture.sessionId;
    const projection = (await request(fixture.baseUrl, `/v1/sessions/${sessionId}`)).body;
    assert(projection.messages.length === 0 && projection.toolCalls.length === 1_250, "Inspection fixture projection is not bounded to the expected tool ledger");
    const latest = await request(fixture.baseUrl, `/v1/sessions/${sessionId}/events?format=json&limit=100`);
    assert(latest.body.events.length === 100 && latest.body.hasMoreBefore === true, "Inspection latest trajectory page is not bounded");
    const older = await request(fixture.baseUrl, `/v1/sessions/${sessionId}/events?format=json&before_sequence=${latest.body.oldestSequence}&limit=100`);
    assert(older.body.events.length === 100 && older.body.events.at(-1).sequence < latest.body.events[0].sequence, "Inspection older page did not prepend in sequence order");
    const all = await request(fixture.baseUrl, `/v1/sessions/${sessionId}/events?format=json`);
    assert(all.body.length === 2_501, `Inspection replay returned ${all.body.length} events, expected 2501 including session creation`);
    const sequences = all.body.map((event) => event.sequence);
    assert(new Set(sequences).size === sequences.length && sequences[0] === 1 && sequences.at(-1) === 2_501, "Inspection replay sequence is not monotonic and deduplicated");
    const types = eventTypes(all.body);
    assert(types.has("tool/call") && types.has("tool/result"), "Inspection replay lacks tool call/result records");
    metrics.trajectoryLatestPageMs = latest.elapsed;
    metrics.trajectoryOlderPageMs = older.elapsed;
    metrics.trajectoryFullReplayMs = all.elapsed;
    return { sessionId, records: fixture.records, events: all.body.length, latestPage: latest.body.events.length, olderPage: older.body.events.length };
  } finally {
    await stopFixture(fixture);
  }
}

try {
  const started = performance.now();
  const coding = await runCodingScenarios();
  const delegation = await runDelegationScenario();
  const inspection = await runInspectionScenario();
  metrics.totalMs = performance.now() - started;
  console.log(JSON.stringify({
    phase: "7.10",
    gate: "browser-replay",
    passed: true,
    scenarios: { ...coding, delegation, inspection },
    performance: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, Math.round(value * 100) / 100])),
    generatedAt: new Date().toISOString(),
  }, null, 2));
} catch (error) {
  for (const child of children) child.kill("SIGTERM");
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
