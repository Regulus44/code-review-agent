/**
 * Phase 8.2 Worktree browser/replay gate.
 *
 * This exercises the real API against a temporary Git repository and a
 * SQLite restart. It covers linked-worktree discovery, active-root replay,
 * dirty cleanup protection, forced cleanup, and the typed Web surface.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createApiServer } from "../apps/api/dist/server.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "code-review-agent-phase8-worktree-"));
const repo = join(root, "repo");
const linked = join(root, "linked");
const sibling = join(root, "feature-worktree");
const databasePath = join(root, "events.sqlite");
const webRoot = fileURLToPath(new URL("../apps/web/", import.meta.url));
let server;

function assert(condition, message) {
  if (!condition) throw new Error(`Phase 8.2 worktree gate: ${message}`);
}

async function request(baseUrl, pathname, init = {}, expected = 200) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let body = text;
  try { body = text.length === 0 ? undefined : JSON.parse(text); } catch { /* text response */ }
  assert(response.status === expected, `${init.method ?? "GET"} ${pathname} returned ${response.status}, expected ${expected}: ${text}`);
  return { response, body };
}

async function listen() {
  server = createApiServer({ databasePath, webRoot });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Worktree gate API did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function close() {
  if (server === undefined || !server.listening) return;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  server = undefined;
}

try {
  await execFileAsync("git", ["init", "-q", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "agent@example.test"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Coding Agent"]);
  await writeFile(join(repo, "README.md"), "initial\n", "utf8");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-qm", "initial"]);
  await execFileAsync("git", ["-C", repo, "worktree", "add", "-q", "-b", "feature/linked", linked, "HEAD"]);

  let baseUrl = await listen();
  const shell = await request(baseUrl, "/");
  assert(typeof shell.body === "string" && shell.body.includes("Git worktrees"), "Web shell is missing the Worktree details surface");
  const browser = await request(baseUrl, "/web/browser.js");
  assert(typeof browser.body === "string" && browser.body.includes("presentWorktrees"), "typed browser bundle is missing the Worktree presenter");

  const session = (await request(baseUrl, "/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: linked }) }, 201)).body;
  const initial = (await request(baseUrl, `/v1/sessions/${session.id}/worktrees`)).body.worktrees;
  assert(initial.some((item) => item.path === resolve(repo)) && initial.some((item) => item.path === resolve(linked)), "linked worktree discovery did not expose main and linked roots");

  const created = (await request(baseUrl, `/v1/sessions/${session.id}/worktrees`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "phase8-worktree-create" },
    body: JSON.stringify({ id: "gate-feature", branch: "feature/gate", path: sibling }),
  }, 201)).body;
  const feature = created.worktrees.find((item) => item.id === "gate-feature");
  assert(feature?.status === "clean" && feature.path === resolve(sibling), "created Worktree projection is incomplete");
  const repeated = (await request(baseUrl, `/v1/sessions/${session.id}/worktrees`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "phase8-worktree-create" },
    body: JSON.stringify({ id: "gate-feature", branch: "feature/gate", path: sibling }),
  }, 201)).body;
  assert(JSON.stringify(repeated) === JSON.stringify(created), "repeated Worktree create was not idempotent");

  await request(baseUrl, `/v1/sessions/${session.id}/worktrees/gate-feature/attach`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "phase8-worktree-attach" }, body: "{}" });
  const switched = (await request(baseUrl, `/v1/sessions/${session.id}/worktrees/gate-feature/switch`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "phase8-worktree-switch" }, body: "{}" })).body;
  assert(switched.activeWorktreeId === "gate-feature" && switched.activeWorkspaceRoot === resolve(sibling), "switch did not update the active workspace root");
  await writeFile(join(sibling, "dirty.txt"), "uncommitted\n", "utf8");
  const dirty = (await request(baseUrl, `/v1/sessions/${session.id}/worktrees`)).body.worktrees.find((item) => item.id === "gate-feature");
  assert(dirty?.status === "dirty", "dirty Worktree status was not discovered");
  await request(baseUrl, `/v1/sessions/${session.id}/worktrees/gate-feature/cleanup`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "phase8-worktree-cleanup-refused" }, body: "{}" }, 409);

  await close();
  baseUrl = await listen();
  const restored = (await request(baseUrl, `/v1/sessions/${session.id}`)).body;
  assert(restored.activeWorktreeId === "gate-feature" && restored.activeWorkspaceRoot === resolve(sibling), "SQLite restart lost active Worktree state");
  const restoredDirty = (await request(baseUrl, `/v1/sessions/${session.id}/worktrees`)).body.worktrees.find((item) => item.id === "gate-feature");
  assert(restoredDirty?.status === "dirty", "SQLite restart lost dirty Worktree discovery");

  const cleaned = (await request(baseUrl, `/v1/sessions/${session.id}/worktrees/gate-feature/cleanup`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "phase8-worktree-cleanup-force" }, body: JSON.stringify({ force: true }) })).body;
  assert(cleaned.activeWorktreeId === undefined && cleaned.worktrees.some((item) => item.id === "gate-feature" && item.status === "removed"), "forced cleanup did not clear active state and persist removal");
  const events = (await request(baseUrl, `/v1/sessions/${session.id}/events?format=json`)).body;
  const types = new Set(events.map((event) => event.type));
  for (const type of ["worktree/created", "worktree/attached", "worktree/switched", "worktree/cleaned"]) assert(types.has(type), `replay is missing ${type}`);
  console.log(JSON.stringify({ phase: "8.2", gate: "worktree-browser-replay", passed: true, sessionId: session.id, events: events.length, worktrees: cleaned.worktrees.length }));
} finally {
  await close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
