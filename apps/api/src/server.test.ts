import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createApiServer, createConfiguredApiServer } from "./server.js";
import { InMemoryEventStore } from "@code-review-agent/storage";
import { sessionId } from "@code-review-agent/runtime";
import { DEEPSEEK_MODELS, OpenAICompatibleChatModel } from "@code-review-agent/llm";
import { SubagentRuntime } from "@code-review-agent/subagent";
import { createDelegationFixtureProvider, seedDelegationFixture } from "./fixtures/delegation.js";

describe("Phase 2 API", () => {
  let server: Server;
  let baseUrl: string;
  const store = new InMemoryEventStore();

  beforeAll(async () => {
    server = createApiServer({ store });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("API did not bind to a TCP port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("creates a session, streams a turn, and serves the web shell", async () => {
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/workspace" }),
    });
    const session = (await created.json()) as { id: string };
    const sent = await fetch(`${baseUrl}/v1/sessions/${session.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(sent.status).toBe(202);
    let projection: { status: string; messages: { content: string }[] };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      projection = (await (await fetch(`${baseUrl}/v1/sessions/${session.id}`)).json()) as typeof projection;
      if (projection.status === "idle" && projection.messages.some((message) => message.content === "Echo: hello")) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(projection!.messages.at(-1)?.content).toBe("Echo: hello");
    const shell = await fetch(`${baseUrl}/`);
    expect(await shell.text()).toContain("Code Review Agent");
  });

  it("persists Goal CAS, Plan review, and Todo commands through the API", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/workspace/planning-api" }) });
    const session = await created.json() as { id: string };
    await store.append({ sessionId: sessionId(session.id), type: "goal/created", payload: { goalId: "goal_api", title: "Review", successCriteria: ["Plan approved"], status: "active" } });
    const baseline = await (await fetch(`${baseUrl}/v1/sessions/${session.id}`)).json() as { goals: { lastSequence: number; status: string }[]; plan: { lastSequence: number } };
    const pause = await fetch(`${baseUrl}/v1/sessions/${session.id}/goals/goal_api`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "goal-api-1" }, body: JSON.stringify({ status: "paused", expectedSequence: baseline.goals[0]!.lastSequence }) });
    expect(pause.status).toBe(200);
    expect((await pause.json() as { goals: { status: string }[] }).goals[0]?.status).toBe("paused");
    const stale = await fetch(`${baseUrl}/v1/sessions/${session.id}/goals/goal_api`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "active", expectedSequence: baseline.goals[0]!.lastSequence }) });
    expect(stale.status).toBe(409);
    const plan = await fetch(`${baseUrl}/v1/sessions/${session.id}/plan`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "plan-api-1" }, body: JSON.stringify({ content: "Inspect and test", status: "approved", expectedSequence: baseline.plan.lastSequence }) });
    expect((await plan.json() as { plan: { status: string } }).plan.status).toBe("approved");
    const todos = await fetch(`${baseUrl}/v1/sessions/${session.id}/todos`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "todo-api-1" }, body: JSON.stringify({ todos: [{ id: "one", content: "Test", status: "pending" }] }) });
    expect((await todos.json() as { todos: { id: string }[] }).todos).toEqual([{ id: "one", content: "Test", status: "pending" }]);
  });

  it("exposes durable Git worktree create, attach, switch, cleanup and replay", async () => {
    const parent = mkdtempSync(join(tmpdir(), "cra-api-worktree-"));
    const root = join(parent, "repo");
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "config", "user.email", "agent@example.test"]);
      execFileSync("git", ["-C", root, "config", "user.name", "Coding Agent"]);
      writeFileSync(join(root, "README.md"), "initial\n");
      execFileSync("git", ["-C", root, "add", "README.md"]);
      execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
      const session = await (await fetch(`${baseUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: root }) })).json() as { id: string };
      const initial = await (await fetch(`${baseUrl}/v1/sessions/${session.id}/worktrees`)).json() as { worktrees: { path: string }[] };
      expect(initial.worktrees).toHaveLength(1);
      const created = await fetch(`${baseUrl}/v1/sessions/${session.id}/worktrees`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "api-worktree-create-1" }, body: JSON.stringify({ id: "api-feature", branch: "feature/api" }) });
      expect(created.status).toBe(201);
      const projection = await created.json() as { worktrees: { id: string; path: string }[] };
      const item = projection.worktrees.find((worktree) => worktree.id === "api-feature");
      expect(item?.path).toBeTruthy();
      expect((await fetch(`${baseUrl}/v1/sessions/${session.id}/worktrees/api-feature/attach`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "api-worktree-attach-1" }, body: "{}" })).status).toBe(200);
      const switched = await fetch(`${baseUrl}/v1/sessions/${session.id}/worktrees/api-feature/switch`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "api-worktree-switch-1" }, body: "{}" });
      expect((await switched.json() as { activeWorktreeId?: string }).activeWorktreeId).toBe("api-feature");
      writeFileSync(join(item!.path, "dirty.txt"), "dirty\n");
      const refused = await fetch(`${baseUrl}/v1/sessions/${session.id}/worktrees/api-feature/cleanup`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "api-worktree-cleanup-1" }, body: "{}" });
      expect(refused.status).toBe(409);
      const cleaned = await fetch(`${baseUrl}/v1/sessions/${session.id}/worktrees/api-feature/cleanup`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "api-worktree-cleanup-2" }, body: JSON.stringify({ force: true }) });
      const events = await (await fetch(`${baseUrl}/v1/sessions/${session.id}/events?format=json`)).json() as { type: string }[];
      expect((await cleaned.json() as { activeWorktreeId?: string }).activeWorktreeId).toBeUndefined();
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["worktree/created", "worktree/attached", "worktree/switched", "worktree/cleaned"]));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("serves latest and older event pages while keeping unpaged JSON replay compatible", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/workspace/paging" }) });
    const session = await created.json() as { id: string };
    for (let index = 0; index < 5; index += 1) await store.append({ sessionId: sessionId(session.id), type: "session/updated", payload: { index } });
    const latestResponse = await fetch(`${baseUrl}/v1/sessions/${session.id}/events?format=json&limit=3`);
    const latest = await latestResponse.json() as { events: { sequence: number }[]; hasMoreBefore: boolean; oldestSequence: number };
    expect(latest.events.map((event) => event.sequence)).toEqual([4, 5, 6]);
    expect(latest.hasMoreBefore).toBe(true);
    const olderResponse = await fetch(`${baseUrl}/v1/sessions/${session.id}/events?format=json&before_sequence=${latest.oldestSequence}&limit=3`);
    const older = await olderResponse.json() as { events: { sequence: number }[]; hasMoreBefore: boolean };
    expect(older.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(older.hasMoreBefore).toBe(false);
    const full = await (await fetch(`${baseUrl}/v1/sessions/${session.id}/events?format=json`)).json() as { sequence: number }[];
    expect(full.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("exposes durable subagent catalog, task output, cancel, and scoped replay", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/workspace", permissionPreset: "read-only" }) });
    const session = await created.json() as { id: string };
    const spawned = await fetch(`${baseUrl}/v1/sessions/${session.id}/subagents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "child fixture", mode: "one-shot", background: false, permissionPreset: "read-only", toolAllowlist: [], mcpAllowlist: [] }) });
    expect(spawned.status).toBe(200);
    const receipt = await spawned.json() as { taskId: string; childSessionId: string; report?: { summary: string } };
    expect(receipt.report?.summary).toContain("Echo: child fixture");
    const catalog = await (await fetch(`${baseUrl}/v1/sessions/${session.id}/subagents`)).json() as { agents: { task: { id: string; childSessionId?: string; status: string } }[] };
    expect(catalog.agents.some((entry) => entry.task.id === receipt.taskId && entry.task.childSessionId === receipt.childSessionId)).toBe(true);
    const output = await (await fetch(`${baseUrl}/v1/sessions/${session.id}/tasks/${receipt.taskId}/output`)).json() as { report?: { summary: string } };
    expect(output.report?.summary).toContain("Echo: child fixture");
    const scoped = await (await fetch(`${baseUrl}/v1/sessions/${session.id}/subagents/events?format=json`)).json() as { sessionId: string; event: { type: string } }[];
    expect(scoped.some((entry) => entry.sessionId === receipt.childSessionId && entry.event.type === "subagent/descriptor")).toBe(true);
  });

  it("replays a non-empty isolated delegation fixture and prevents sibling task history access", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-review-agent-delegation-fixture-"));
    const childCompletedRoot = join(root, "completed-child");
    const childCancellableRoot = join(root, "cancellable-child");
    const siblingRoot = join(root, "sibling");
    const fixtureStore = new InMemoryEventStore();
    const fixtureRuntime = new SubagentRuntime({ store: fixtureStore });
    fixtureRuntime.registerProvider(createDelegationFixtureProvider({ store: fixtureStore }));
    const fixtureServer = createApiServer({ store: fixtureStore, subagentRuntime: fixtureRuntime });
    await new Promise<void>((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
    try {
      const address = fixtureServer.address();
      if (address === null || typeof address === "string") throw new Error("Delegation fixture API did not bind");
      const url = `http://127.0.0.1:${address.port}`;
      const parent = await (await fetch(`${url}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: root, permissionPreset: "read-only" }) })).json() as { id: string };
      const sibling = await (await fetch(`${url}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: siblingRoot, permissionPreset: "read-only" }) })).json() as { id: string };
      const seeded = await seedDelegationFixture({ store: fixtureStore, runtime: fixtureRuntime, parentSessionId: sessionId(parent.id), workspaceRoot: root, completedWorkspaceRoot: childCompletedRoot, cancellableWorkspaceRoot: childCancellableRoot, commandPrefix: "api-delegation-fixture" });

      const catalog = await (await fetch(`${url}/v1/sessions/${parent.id}/subagents?scope=children`)).json() as { agents: { task: { id: string; status: string; childSessionId?: string; workspaceRoot?: string; permissionPreset?: string; report?: { summary: string; artifacts: { id: string; kind: string }[] }; artifacts: { id: string; kind: string }[] }; live: boolean; resumable: boolean }[] };
      const completed = catalog.agents.find((entry) => entry.task.id === seeded.completed.taskId);
      const cancellable = catalog.agents.find((entry) => entry.task.id === seeded.cancellable.taskId);
      expect(completed?.task.status).toBe("completed");
      expect(completed?.task.childSessionId).toBe(seeded.completed.childSessionId);
      expect(completed?.task.workspaceRoot).toBe(childCompletedRoot);
      expect(completed?.task.permissionPreset).toBe("read-only");
      expect(completed?.task.report?.summary).toContain("Fixture completed");
      expect(completed?.task.artifacts).toHaveLength(3);
      expect(completed?.task.artifacts.map((artifact) => artifact.kind)).toEqual(["json", "url", "file"]);
      expect(completed?.live).toBe(false);
      expect(cancellable?.live).toBe(true);
      expect(cancellable?.task.childSessionId).toBe(seeded.cancellable.childSessionId);

      const childProjection = await (await fetch(`${url}/v1/sessions/${seeded.completed.childSessionId}`)).json() as { parentSessionId?: string; workspaceRoot: string; permissionPreset: string; messages: { role: string; content: string }[] };
      expect(childProjection).toMatchObject({ parentSessionId: parent.id, workspaceRoot: childCompletedRoot, permissionPreset: "read-only" });
      expect(childProjection.messages.some((message) => message.role === "user" && message.content.includes("fixture:completed"))).toBe(true);
      expect(childProjection.messages.some((message) => message.role === "assistant" && message.content.includes("Fixture completed"))).toBe(true);

      const output = await (await fetch(`${url}/v1/sessions/${parent.id}/tasks/${seeded.completed.taskId}/output`)).json() as { report?: { summary: string; artifacts: { id: string; kind: string }[] }; events: { type: string; payload: Record<string, unknown> }[] };
      expect(output.report?.summary).toContain("Fixture completed");
      expect(output.report?.artifacts).toHaveLength(3);
      expect(output.events.length).toBeGreaterThan(4);
      expect(output.events.some((event) => event.type === "user/message")).toBe(true);
      expect(output.events.some((event) => event.type === "assistant/message")).toBe(true);

      const descriptor = output.events.find((event) => event.type === "subagent/descriptor")?.payload["descriptor"] as { workspaceRoot?: string; permissionPreset?: string; toolAllowlist?: string[]; mcpAllowlist?: string[] } | undefined;
      expect(descriptor).toMatchObject({ workspaceRoot: childCompletedRoot, permissionPreset: "read-only", toolAllowlist: ["read_file"], mcpAllowlist: [] });

      const parentEvents = await (await fetch(`${url}/v1/sessions/${parent.id}/events?format=json`)).json() as { sequence: number; type: string }[];
      const reportEvent = parentEvents.find((event) => event.type === "task/report");
      expect(reportEvent).toBeDefined();
      const replayed = await (await fetch(`${url}/v1/sessions/${parent.id}/events?format=json&after_sequence=${Math.max(0, (reportEvent?.sequence ?? 1) - 1)}`)).json() as { sequence: number; type: string }[];
      expect(replayed.some((event) => event.type === "task/report")).toBe(true);
      const scoped = await (await fetch(`${url}/v1/sessions/${parent.id}/subagents/events?format=json`)).json() as { sessionId: string; event: { type: string } }[];
      expect(scoped.some((entry) => entry.sessionId === seeded.completed.childSessionId && entry.event.type === "assistant/message")).toBe(true);
      expect(scoped.some((entry) => entry.sessionId === seeded.cancellable.childSessionId && entry.event.type === "subagent/descriptor")).toBe(true);

      const workspaceArtifactId = `artifact_${seeded.completed.taskId}`;
      const artifactInfo = await (await fetch(`${url}/v1/sessions/${parent.id}/artifacts/${workspaceArtifactId}`)).json() as { availability: string; sizeBytes?: number; contentType?: string; taskId: string };
      expect(artifactInfo).toMatchObject({ availability: "available", taskId: seeded.completed.taskId, contentType: "application/json" });
      expect(artifactInfo.sizeBytes).toBeGreaterThan(0);
      const artifactContent = await fetch(`${url}/v1/sessions/${parent.id}/artifacts/${workspaceArtifactId}/content`);
      expect(artifactContent.status).toBe(200);
      expect(artifactContent.headers.get("content-disposition")).toContain("inline");
      expect(await artifactContent.text()).toContain(String(seeded.completed.taskId));
      const artifactDownload = await fetch(`${url}/v1/sessions/${parent.id}/artifacts/${workspaceArtifactId}/content?download=true`);
      expect(artifactDownload.status).toBe(200);
      expect(artifactDownload.headers.get("content-disposition")).toContain("attachment");

      const externalId = `artifact_${seeded.completed.taskId}_external`;
      const externalInfo = await (await fetch(`${url}/v1/sessions/${parent.id}/artifacts/${externalId}`)).json() as { availability: string; reason: string };
      expect(externalInfo).toMatchObject({ availability: "external" });
      const externalContent = await fetch(`${url}/v1/sessions/${parent.id}/artifacts/${externalId}/content`);
      expect(externalContent.status).toBe(409);
      expect((await externalContent.json()).error).toContain("External artifacts");

      const unsafeId = `artifact_${seeded.completed.taskId}_unsafe`;
      const unsafeInfo = await (await fetch(`${url}/v1/sessions/${parent.id}/artifacts/${unsafeId}`)).json() as { availability: string; reason: string };
      expect(unsafeInfo).toMatchObject({ availability: "blocked" });
      const unsafeContent = await fetch(`${url}/v1/sessions/${parent.id}/artifacts/${unsafeId}/content`);
      expect(unsafeContent.status).toBe(403);
      expect((await unsafeContent.json()).error).toContain("workspace");
      const childArtifactLookup = await fetch(`${url}/v1/sessions/${seeded.completed.childSessionId}/artifacts/${workspaceArtifactId}`);
      expect(childArtifactLookup.status).toBe(404);

      const outsideRoot = mkdtempSync(join(tmpdir(), "code-review-agent-artifact-outside-"));
      try {
        writeFileSync(join(outsideRoot, "secret.txt"), "secret");
        const link = join(childCompletedRoot, "escape-link");
        symlinkSync(outsideRoot, link, process.platform === "win32" ? "junction" : "dir");
        await fixtureStore.append({
          sessionId: sessionId(parent.id),
          type: "task/artifact",
          payload: {
            taskId: seeded.completed.taskId,
            artifact: { id: `artifact_${seeded.completed.taskId}_symlink`, kind: "file", label: "symlink escape", path: path.join(path.relative(root, link), "secret.txt") },
          },
        });
        const symlinkContent = await fetch(`${url}/v1/sessions/${parent.id}/artifacts/artifact_${seeded.completed.taskId}_symlink/content`);
        expect(symlinkContent.status).toBe(403);
      } finally {
        rmSync(outsideRoot, { recursive: true, force: true });
      }

      const forbidden = await fetch(`${url}/v1/sessions/${sibling.id}/tasks/${seeded.completed.taskId}/output`);
      expect(forbidden.status, await forbidden.text()).toBe(404);

      const cancelled = await fetch(`${url}/v1/sessions/${parent.id}/tasks/${seeded.cancellable.taskId}/cancel`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "api-delegation-fixture-cancel" }, body: "{}" });
      expect(cancelled.status).toBe(200);
      let cancelledTask: { status: string } | undefined;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const current = await (await fetch(`${url}/v1/sessions/${parent.id}/tasks/${seeded.cancellable.taskId}`)).json() as { status: string };
        cancelledTask = current;
        if (current.status === "cancelled") break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(cancelledTask?.status).toBe("cancelled");
      const afterCancel = await (await fetch(`${url}/v1/sessions/${parent.id}/subagents?scope=children`)).json() as { agents: { task: { id: string; status: string }; live: boolean }[] };
      const cancelledEntry = afterCancel.agents.find((entry) => entry.task.id === seeded.cancellable.taskId);
      expect(cancelledEntry).toMatchObject({ task: { status: "cancelled" }, live: false });
    } finally {
      await new Promise<void>((resolve, reject) => fixtureServer.close((error) => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates a local workspace directory before creating a session", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-review-agent-workspace-"));
    try {
      const valid = await fetch(`${baseUrl}/v1/workspaces/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceRoot: root }),
      });
      expect(valid.status).toBe(200);
      expect(await valid.json()).toMatchObject({ valid: true, workspaceRoot: root, isGitRepository: false });

      const invalid = await fetch(`${baseUrl}/v1/workspaces/validate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceRoot: join(root, "missing") }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: "workspaceRoot directory does not exist or is not accessible" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves a durable workspace catalog and idempotent reorder command", async () => {
    await fetch(`${baseUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/workspace-order-first" }) });
    await fetch(`${baseUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/workspace-order-second" }) });
    const before = await (await fetch(`${baseUrl}/v1/workspaces`)).json() as { workspaces: { key: string; root: string }[] };
    expect(before.workspaces.map((workspace) => workspace.root)).toEqual(expect.arrayContaining(["D:/workspace-order-first", "D:/workspace-order-second"]));
    const order = before.workspaces.map((workspace) => workspace.key).reverse();
    const headers = { "content-type": "application/json", "idempotency-key": "api-workspace-order-1" };
    const moved = await fetch(`${baseUrl}/v1/workspaces/reorder`, { method: "POST", headers, body: JSON.stringify({ order }) });
    expect(moved.status).toBe(200);
    const movedBody = await moved.json();
    expect(movedBody.workspaces.map((workspace: { key: string }) => workspace.key)).toEqual(order);
    const repeated = await fetch(`${baseUrl}/v1/workspaces/reorder`, { method: "POST", headers, body: JSON.stringify({ order }) });
    expect(await repeated.json()).toEqual(movedBody);
    const allSessions = await (await fetch(`${baseUrl}/v1/sessions?include_archived=true`)).json() as { sessions: { id: string }[] };
    const allEvents = await Promise.all(allSessions.sessions.map(async (session) => await (await fetch(`${baseUrl}/v1/sessions/${session.id}/events?format=json`)).json() as { type: string }[]));
    expect(allEvents.flat().some((event) => event.type === "workspace/reordered")).toBe(true);
  });

  it("serves workspace rename/archive/delete lifecycle with durable replay", async () => {
    const first = await (await fetch(`${baseUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/workspace-lifecycle-api" }) })).json() as { id: string };
    await fetch(`${baseUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/workspace-lifecycle-api" }) });
    const key = "d:/workspace-lifecycle-api";
    const renamedResponse = await fetch(`${baseUrl}/v1/workspaces/${encodeURIComponent(key)}/label`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "api-workspace-rename-1" }, body: JSON.stringify({ label: "API review" }) });
    expect(renamedResponse.status).toBe(200);
    expect((await renamedResponse.json()).workspaces.find((workspace: { key: string }) => workspace.key === key)).toMatchObject({ label: "API review" });
    const archivedResponse = await fetch(`${baseUrl}/v1/workspaces/${encodeURIComponent(key)}/archive`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "api-workspace-archive-1" }, body: JSON.stringify({ archived: true }) });
    expect((await archivedResponse.json()).workspaces.some((workspace: { key: string }) => workspace.key === key)).toBe(false);
    const archivedCatalog = await (await fetch(`${baseUrl}/v1/workspaces?include_archived=true`)).json() as { workspaces: { key: string; label?: string; archived?: boolean }[] };
    expect(archivedCatalog.workspaces.find((workspace) => workspace.key === key)).toMatchObject({ label: "API review", archived: true });
    const restored = await fetch(`${baseUrl}/v1/workspaces/${encodeURIComponent(key)}/archive`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "api-workspace-restore-1" }, body: JSON.stringify({ archived: false }) });
    expect((await restored.json()).workspaces.some((workspace: { key: string }) => workspace.key === key)).toBe(true);
    const deleted = await fetch(`${baseUrl}/v1/workspaces/${encodeURIComponent(key)}`, { method: "DELETE", headers: { "idempotency-key": "api-workspace-delete-1" } });
    expect((await deleted.json()).workspaces.some((workspace: { key: string }) => workspace.key === key)).toBe(false);
    const events = await (await fetch(`${baseUrl}/v1/sessions/${first.id}/events?format=json`)).json() as { type: string }[];
    expect(events.filter((event) => event.type === "workspace/updated")).toHaveLength(4);
  });

  it("persists scoped MCP settings and exposes catalog diagnostics without secrets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "code-review-agent-api-mcp-"));
    const databasePath = join(directory, "agent.sqlite");
    let owned: Server | undefined;
    try {
      owned = createApiServer({ databasePath });
      await new Promise<void>((resolve) => owned!.listen(0, "127.0.0.1", resolve));
      const address = owned.address();
      if (address === null || typeof address === "string") throw new Error("MCP API did not bind");
      const url = `http://127.0.0.1:${address.port}`;
      const created = await fetch(`${url}/v1/mcp/servers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "api-durable", scope: "project", workspaceRoot: "D:/workspace", transport: "stdio", command: "fixture", enabled: false, start: false, env: { AUTH_TOKEN: "must-not-leak", SAFE_VALUE: "ok" }, credentialRef: { id: "cred-api", kind: "oauth" } }) });
      expect(created.status).toBe(201);
      const body = await created.json() as { revision: number; config: { env?: Record<string, string>; credentialRef?: { id: string } } };
      expect(body.revision).toBe(1);
      expect(body.config.env?.AUTH_TOKEN).toBe("[redacted]");
      expect(body.config.credentialRef?.id).toBe("cred-api");
      await new Promise<void>((resolve, reject) => owned!.close((error) => error ? reject(error) : resolve()));
      owned = undefined;

      const reopened = createApiServer({ databasePath });
      await new Promise<void>((resolve) => reopened.listen(0, "127.0.0.1", resolve));
      const reopenedAddress = reopened.address();
      if (reopenedAddress === null || typeof reopenedAddress === "string") throw new Error("reopened MCP API did not bind");
      const listed = await (await fetch(`http://127.0.0.1:${reopenedAddress.port}/v1/mcp/servers`)).json() as { servers: { config: { credentialRef?: { id: string }; env?: Record<string, string> }; revision: number }[] };
      expect(listed.servers[0]).toMatchObject({ revision: 1, config: { credentialRef: { id: "cred-api" } } });
      expect(listed.servers[0]?.config.env?.AUTH_TOKEN).toBeUndefined();
      await new Promise<void>((resolve, reject) => reopened.close((error) => error ? reject(error) : resolve()));
    } finally {
      if (owned?.listening) await new Promise<void>((resolve) => owned!.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates, switches, archives, and restores a session work mode", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/workspace", permissionPreset: "workspace-write" }),
    });
    expect(created.status).toBe(201);
    const session = await created.json() as { id: string; permissionPreset: string; archived: boolean };
    expect(session).toMatchObject({ permissionPreset: "workspace-write", archived: false });

    const switched = await fetch(`${baseUrl}/v1/sessions/${session.id}/mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permissionPreset: "read-only" }),
    });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toMatchObject({ permissionPreset: "read-only" });

    const archived = await fetch(`${baseUrl}/v1/sessions/${session.id}/archive`, { method: "POST" });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ archived: true });
    expect((await (await fetch(`${baseUrl}/v1/sessions`)).json() as { sessions: { id: string }[] }).sessions.some((item) => item.id === session.id)).toBe(false);

    const restored = await fetch(`${baseUrl}/v1/sessions/${session.id}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    expect(await restored.json()).toMatchObject({ archived: false });
  });

  it("renames a session through a durable idempotent command", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/workspace/rename-fixture" }),
    });
    const session = await created.json() as { id: string };
    const headers = { "content-type": "application/json", "idempotency-key": "api-rename-1" };
    const renamed = await fetch(`${baseUrl}/v1/sessions/${session.id}/title`, { method: "POST", headers, body: JSON.stringify({ title: "  Review queue  " }) });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: session.id, title: "Review queue" });
    const repeated = await fetch(`${baseUrl}/v1/sessions/${session.id}/title`, { method: "POST", headers, body: JSON.stringify({ title: "Review queue" }) });
    expect(await repeated.json()).toMatchObject({ title: "Review queue" });
    const history = await (await fetch(`${baseUrl}/v1/sessions/${session.id}/events?format=json`)).json() as { type: string; payload: Record<string, unknown> }[];
    expect(history.filter((event) => event.type === "session/updated" && event.payload.title === "Review queue")).toHaveLength(1);
  });

  it("serves the host-backed queue reorder command", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/workspace/queue-fixture" }),
    });
    const session = await created.json() as { id: string };
    const response = await fetch(`${baseUrl}/v1/sessions/${session.id}/queue`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "api-queue-1" },
      body: JSON.stringify({ turnId: "turn_not_queued", position: 0 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reordered: false, queuedTurnIds: [] });
  });

  it("serves the host-backed steer command with validation and idempotency", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/workspace/steer-fixture" }),
    });
    const session = await created.json() as { id: string };
    const missing = await fetch(`${baseUrl}/v1/sessions/${session.id}/turns/turn_missing/steer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    const headers = { "content-type": "application/json", "idempotency-key": "api-steer-1" };
    const response = await fetch(`${baseUrl}/v1/sessions/${session.id}/turns/turn_missing/steer`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "focus on the failing test" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: false, turnId: "turn_missing" });
    const repeated = await fetch(`${baseUrl}/v1/sessions/${session.id}/turns/turn_missing/steer`, { method: "POST", headers, body: JSON.stringify({ content: "focus on the failing test" }) });
    expect(await repeated.json()).toEqual({ accepted: false, turnId: "turn_missing" });
  });

  it("serves attachment capability, bounded upload receipts and rejection replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-review-agent-api-attachment-"));
    try {
      const capability = await (await fetch(`${baseUrl}/v1/capabilities`)).json() as { attachments: { enabled: boolean; maxBytes: number; imagesEnabled: boolean } };
      expect(capability.attachments).toMatchObject({ enabled: true, maxBytes: 524288, imagesEnabled: false });
      const created = await fetch(`${baseUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: root }) });
      const session = await created.json() as { id: string };
      const headers = { "content-type": "application/json", "idempotency-key": "api-attachment-1" };
      const body = { fileName: "notes.md", mediaType: "text/markdown", data: Buffer.from("hello").toString("base64") };
      const uploaded = await fetch(`${baseUrl}/v1/sessions/${session.id}/attachments`, { method: "POST", headers, body: JSON.stringify(body) });
      expect(uploaded.status).toBe(201);
      const receipt = await uploaded.json() as { status: string; relativePath: string; sizeBytes: number };
      expect(receipt).toMatchObject({ status: "accepted", sizeBytes: 5 });
      expect(readFileSync(join(root, receipt.relativePath), "utf8")).toBe("hello");
      const repeated = await fetch(`${baseUrl}/v1/sessions/${session.id}/attachments`, { method: "POST", headers, body: JSON.stringify(body) });
      expect(await repeated.json()).toEqual(receipt);
      const rejected = await fetch(`${baseUrl}/v1/sessions/${session.id}/attachments`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "api-attachment-2" }, body: JSON.stringify({ fileName: "run.exe", mediaType: "application/x-msdownload", data: Buffer.from("x").toString("base64") }) });
      expect(await rejected.json()).toMatchObject({ status: "rejected", code: "ATTACHMENT_MEDIA_TYPE_DENIED" });
      const events = await (await fetch(`${baseUrl}/v1/sessions/${session.id}/events?format=json`)).json() as { type: string; payload: Record<string, unknown> }[];
      expect(events.filter((event) => event.type === "attachment/received" || event.type === "attachment/rejected")).toHaveLength(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("exposes configured context compaction budget metadata without leaking defaults", async () => {
    const configured = createApiServer({ store: new InMemoryEventStore(), contextBudget: { maxTokens: 120, recentMessageTokens: 40, maxToolResultChars: 200, maxSummaryChars: 100 } });
    await new Promise<void>((resolve) => configured.listen(0, "127.0.0.1", resolve));
    try {
      const address = configured.address();
      if (address === null || typeof address === "string") throw new Error("Context API did not bind");
      const capability = await (await fetch(`http://127.0.0.1:${address.port}/v1/capabilities`)).json() as { context: { enabled: boolean; configured: boolean; budget?: { maxTokens?: number; recentMessageTokens?: number } }; plugins: { configured: boolean; enabled: boolean; status: string; reason: string }; productization: { enabled: boolean; status: string; reason: string; auth: { status: string; mode: string }; tenantIsolation: { status: string }; quota: { status: string; enforcement: string } } };
      expect(capability.context).toMatchObject({ enabled: true, configured: true, budget: { maxTokens: 120, recentMessageTokens: 40 } });
      expect(capability.plugins).toMatchObject({ configured: false, enabled: false, status: "deferred", reason: expect.stringContaining("Phase 8.5") });
      expect(capability.productization).toMatchObject({ enabled: false, status: "deferred", auth: { status: "deferred", mode: "disabled" }, tenantIsolation: { status: "deferred" }, quota: { status: "disabled", enforcement: "disabled" } });
    } finally {
      await new Promise<void>((resolve, reject) => configured.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("soft-deletes a session and keeps its event history out of active lists", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/workspace/delete-fixture" }),
    });
    const session = await created.json() as { id: string };
    const deleted = await fetch(`${baseUrl}/v1/sessions/${session.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ deleted: true, sessionId: session.id });
    const active = await (await fetch(`${baseUrl}/v1/sessions?include_archived=true`)).json() as { sessions: { id: string }[] };
    expect(active.sessions.some((item) => item.id === session.id)).toBe(false);
    const history = await fetch(`${baseUrl}/v1/sessions/${session.id}/events?format=json`);
    expect(history.status).toBe(200);
    expect((await history.json() as { type: string }[]).at(-1)?.type).toBe("session/deleted");
  });

  it("replays session events over SSE", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/workspace" }),
    });
    const session = (await created.json()) as { id: string };
    await store.append({ sessionId: sessionId(session.id), type: "user/message", payload: { content: "after cursor" } });
    const response = await fetch(`${baseUrl}/v1/sessions/${session.id}/events?after_sequence=1`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("SSE response did not have a body");
    let text = "";
    for (let attempt = 0; attempt < 5 && !text.includes("event: user/message"); attempt += 1) {
      const chunk = await reader.read();
      text += new TextDecoder().decode(chunk.value);
      if (chunk.done) break;
    }
    expect(text).toContain("event: user/message");
    expect(text).not.toContain("event: session/created");
    await reader.cancel();
  });

  it("lists tools and completes an approved workspace edit", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-review-agent-tools-"));
    writeFileSync(join(root, "note.txt"), "before", "utf8");
    try {
      const created = await fetch(`${baseUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: root }) });
      const session = (await created.json()) as { id: string };
      const tools = await (await fetch(`${baseUrl}/v1/tools`)).json() as { tools: { name: string }[] };
      expect(tools.tools.map((tool) => tool.name)).toContain("edit_file");
      const read = await fetch(`${baseUrl}/v1/sessions/${session.id}/tools`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "tool-read-1" }, body: JSON.stringify({ name: "read_file", input: { path: "note.txt" } }) });
      expect(read.status).toBe(200);
      expect((await read.json()).result.output).toMatchObject({ path: "note.txt", lines: [{ number: 1, text: "before" }], truncated: false });
      const edit = await fetch(`${baseUrl}/v1/sessions/${session.id}/tools`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "tool-edit-1" }, body: JSON.stringify({ name: "edit_file", input: { path: "note.txt", oldText: "before", newText: "after" } }) });
      expect(edit.status).toBe(202);
      const pending = await edit.json() as { toolCallId: string; permission: { id: string } };
      const repeatedEdit = await fetch(`${baseUrl}/v1/sessions/${session.id}/tools`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "tool-edit-1" }, body: JSON.stringify({ name: "edit_file", input: { path: "note.txt", oldText: "before", newText: "after" } }) });
      expect(await repeatedEdit.json()).toMatchObject({ toolCallId: pending.toolCallId, permission: { id: pending.permission.id } });
      const approved = await fetch(`${baseUrl}/v1/sessions/${session.id}/permissions/${pending.permission.id}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "permission-edit-1" }, body: JSON.stringify({ status: "approved" }) });
      expect(approved.status).toBe(200);
      const repeatedApproval = await fetch(`${baseUrl}/v1/sessions/${session.id}/permissions/${pending.permission.id}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "permission-edit-1" }, body: JSON.stringify({ status: "approved" }) });
      expect(await repeatedApproval.json()).toMatchObject({ toolCallId: pending.toolCallId, status: "completed" });
      expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("after");
      const cancelCandidate = await fetch(`${baseUrl}/v1/sessions/${session.id}/tools`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "tool-edit-cancel-1" }, body: JSON.stringify({ name: "edit_file", input: { path: "note.txt", oldText: "after", newText: "cancelled" } }) });
      const cancelBody = await cancelCandidate.json() as { toolCallId: string };
      const cancelled = await fetch(`${baseUrl}/v1/sessions/${session.id}/tools/${cancelBody.toolCallId}/cancel`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "cancel-tool-1" }, body: "{}" });
      expect(cancelled.status).toBe(200); expect((await cancelled.json()).cancelled).toBe(true);
      const repeatedCancel = await fetch(`${baseUrl}/v1/sessions/${session.id}/tools/${cancelBody.toolCallId}/cancel`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "cancel-tool-1" }, body: "{}" });
      expect((await repeatedCancel.json()).cancelled).toBe(true); expect(readFileSync(join(root, "note.txt"), "utf8")).toBe("after");
      const projection = await (await fetch(`${baseUrl}/v1/sessions/${session.id}`)).json() as { toolCalls: { id: string; status: string; caller?: string; workspaceRoot?: string }[]; permissions: { toolCallId: string; status: string }[] };
      expect(projection.toolCalls.find((call) => call.id === cancelBody.toolCallId)).toMatchObject({ status: "cancelled", caller: "user", workspaceRoot: root });
      expect(projection.permissions.find((permission) => permission.toolCallId === cancelBody.toolCallId)?.status).toBe("cancelled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pauses a model turn for ask_user and resumes through the interaction API", async () => {
    const interactionStore = new InMemoryEventStore(); let modelCalls = 0;
    const interactionServer = createApiServer({
      store: interactionStore,
      model: {
        async *stream() {
          if (modelCalls++ === 0) {
            yield { type: "tool_call_start" as const, index: 0, id: "call_ask", name: "ask_user" };
            yield { type: "tool_call_delta" as const, index: 0, arguments: JSON.stringify({ question: "Continue?", options: [{ label: "Yes", value: "yes" }] }) };
            yield { type: "done" as const };
          } else {
            yield { type: "text_delta" as const, text: "Continuing with your answer." };
            yield { type: "done" as const };
          }
        },
      },
    });
    await new Promise<void>((resolve) => interactionServer.listen(0, "127.0.0.1", resolve));
    try {
      const address = interactionServer.address(); if (address === null || typeof address === "string") throw new Error("Interaction API did not bind"); const url = `http://127.0.0.1:${address.port}`;
      const session = await (await fetch(`${url}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: process.cwd() }) })).json() as { id: string };
      await fetch(`${url}/v1/sessions/${session.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Ask me before continuing" }) });
      let interaction: { id: string } | undefined;
      for (let attempt = 0; attempt < 100 && interaction === undefined; attempt += 1) { const projection = await (await fetch(`${url}/v1/sessions/${session.id}`)).json() as { interactions?: { id: string; status: string }[] }; const pending = projection.interactions?.find((item) => item.status === "pending"); if (pending !== undefined) interaction = pending; else await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
      expect(interaction).toBeDefined();
      const answered = await fetch(`${url}/v1/sessions/${session.id}/interactions/${interaction!.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "answered", answer: "yes" }) });
      expect(answered.status).toBe(200); expect((await answered.json()).status).toBe("answered");
      let projection: { messages: { content: string }[] } = { messages: [] };
      for (let attempt = 0; attempt < 100; attempt += 1) { projection = await (await fetch(`${url}/v1/sessions/${session.id}`)).json() as typeof projection; if (projection.messages.some((message) => message.content.includes("Continuing"))) break; await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
      expect(projection.messages.some((message) => message.content.includes("Continuing"))).toBe(true);
    } finally { await new Promise<void>((resolve, reject) => interactionServer.close((error) => (error ? reject(error) : resolve()))); }
  });

  it("exposes MCP server configuration without leaking secrets", async () => {
    const created = await fetch(`${baseUrl}/v1/mcp/servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "api-fixture", scope: "user", transport: "stdio", command: "fixture", env: { AUTH_TOKEN: "secret-value" }, start: false }),
    });
    expect(created.status).toBe(201);
    const server = await created.json() as { config: { env?: Record<string, string> }; status: string };
    expect(server.status).toBe("stopped");
    expect(server.config.env?.AUTH_TOKEN).toBe("[redacted]");
    const listed = await (await fetch(`${baseUrl}/v1/mcp/servers`)).json() as { servers: { config: { name: string } }[] };
    expect(listed.servers.some((item) => item.config.name === "api-fixture")).toBe(true);
    const disabled = await fetch(`${baseUrl}/v1/mcp/servers/api-fixture/disable`, { method: "POST" });
    expect((await disabled.json()).status).toBe("disabled");
    const removed = await fetch(`${baseUrl}/v1/mcp/servers/api-fixture`, { method: "DELETE" });
    expect((await removed.json()).removed).toBe(true);
  });

  it("runs an explicitly configured DeepSeek-compatible model without exposing its key", async () => {
    let requestInit: RequestInit | undefined;
    const modelFetch: typeof fetch = async (_input, init) => {
      requestInit = init;
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"real model response\"}}]}\n\ndata: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const configured = createApiServer({
      store: new InMemoryEventStore(),
      model: new OpenAICompatibleChatModel({ baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "sk-test-only", fetch: modelFetch }),
      modelInfo: { provider: "deepseek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com", configured: true },
    });
    await new Promise<void>((resolve) => configured.listen(0, "127.0.0.1", resolve));
    try {
      const address = configured.address();
      if (address === null || typeof address === "string") throw new Error("Configured API did not bind");
      const configuredUrl = `http://127.0.0.1:${address.port}`;
      const health = await (await fetch(`${configuredUrl}/health`)).json() as { model: Record<string, unknown> };
      expect(health.model).toEqual({ provider: "deepseek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com", configured: true });
      expect(JSON.stringify(health)).not.toContain("sk-test-only");

      const session = await (await fetch(`${configuredUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/workspace" }) })).json() as { id: string };
      await fetch(`${configuredUrl}/v1/sessions/${session.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "hello" }) });
      let projection: { status: string; messages: { content: string }[] };
      for (let attempt = 0; attempt < 50; attempt += 1) {
        projection = await (await fetch(`${configuredUrl}/v1/sessions/${session.id}`)).json() as typeof projection;
        if (projection.status === "idle") break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(projection!.messages.at(-1)?.content).toBe("real model response");
      expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer sk-test-only");
      expect(String(requestInit?.body)).not.toContain("sk-test-only");
    } finally {
      await new Promise<void>((resolve, reject) => configured.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("lists and switches the supported DeepSeek models for subsequent turns", async () => {
    const makeModel = (name: string) => ({
      async *stream() {
        yield { type: "text_delta" as const, text: name };
        yield { type: "done" as const };
      },
    });
    const configured = createApiServer({
      store: new InMemoryEventStore(),
      model: makeModel("deepseek-v4-flash"),
      modelInfo: { provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", configured: true },
      availableModels: DEEPSEEK_MODELS,
      modelSelector: (model) => ({
        model: makeModel(model),
        config: { provider: "deepseek", model, baseUrl: "https://api.deepseek.com", configured: true },
      }),
    });
    await new Promise<void>((resolve) => configured.listen(0, "127.0.0.1", resolve));
    try {
      const address = configured.address();
      if (address === null || typeof address === "string") throw new Error("Model API did not bind");
      const configuredUrl = `http://127.0.0.1:${address.port}`;
      const models = await (await fetch(`${configuredUrl}/v1/models`)).json() as { current: string; models: string[]; reasoning: { supported: boolean; current?: string; options: { id: string }[] } };
      expect(models).toMatchObject({ current: "deepseek-v4-flash", models: [...DEEPSEEK_MODELS], reasoning: { supported: true } });
      expect(models.reasoning.options.map((option) => option.id)).toEqual(["default", "off", "high", "max"]);
      const effort = await fetch(`${configuredUrl}/v1/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reasoningEffort: "high" }) });
      expect(effort.status).toBe(200);
      expect(await effort.json()).toMatchObject({ reasoning: { supported: true, current: "high" } });
      const effortReadback = await (await fetch(`${configuredUrl}/v1/models`)).json() as { reasoning: { current?: string } };
      expect(effortReadback.reasoning.current).toBe("high");
      const switched = await fetch(`${configuredUrl}/v1/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-v4-pro" }) });
      expect(switched.status).toBe(200);
      expect(await switched.json()).toMatchObject({ model: { model: "deepseek-v4-pro" } });
      const standardCapabilities = await (await fetch(`${configuredUrl}/v1/capabilities`)).json() as { attachments: { imagesEnabled: boolean } };
      expect(standardCapabilities.attachments.imagesEnabled).toBe(false);
      const session = await (await fetch(`${configuredUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/workspace" }) })).json() as { id: string };
      await fetch(`${configuredUrl}/v1/sessions/${session.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "use selected model" }) });
      let projection: { status: string; messages: { content: string }[] };
      for (let attempt = 0; attempt < 50; attempt += 1) {
        projection = await (await fetch(`${configuredUrl}/v1/sessions/${session.id}`)).json() as typeof projection;
        if (projection.status === "idle") break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(projection!.messages.at(-1)?.content).toBe("deepseek-v4-pro");
      const vision = await fetch(`${configuredUrl}/v1/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-v4-flash-vision-exp" }) });
      expect(vision.status).toBe(200);
      const visionCapabilities = await (await fetch(`${configuredUrl}/v1/capabilities`)).json() as { attachments: { imagesEnabled: boolean } };
      expect(visionCapabilities.attachments.imagesEnabled).toBe(true);
      const rejected = await fetch(`${configuredUrl}/v1/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "not-a-deepseek-model" }) });
      expect(rejected.status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => configured.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("gets its configured model catalog and selector from the LLM bootstrap", async () => {
    const configured = createConfiguredApiServer({
      store: new InMemoryEventStore(),
      modelEnvironment: { MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-test-only" },
    });
    await new Promise<void>((resolve) => configured.listen(0, "127.0.0.1", resolve));
    try {
      const address = configured.address();
      if (address === null || typeof address === "string") throw new Error("Configured bootstrap API did not bind");
      const configuredUrl = `http://127.0.0.1:${address.port}`;
      const models = await (await fetch(`${configuredUrl}/v1/models`)).json() as { provider: string; current: string; models: string[] };
      expect(models).toMatchObject({ provider: "deepseek", current: "deepseek-v4-flash", models: [...DEEPSEEK_MODELS] });

      const switched = await fetch(`${configuredUrl}/v1/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-pro" }),
      });
      expect(switched.status).toBe(200);
      expect(await switched.json()).toMatchObject({ model: { provider: "deepseek", model: "deepseek-v4-pro" } });
    } finally {
      await new Promise<void>((resolve, reject) => configured.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("exposes a bounded model catalog failure that recovers on retry", async () => {
    const fixture = createApiServer({ store: new InMemoryEventStore(), modelCatalogFailures: 1, availableModels: ["fixture-model"], modelInfo: { provider: "echo", model: "fixture-model", configured: false } });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    try {
      const address = fixture.address();
      if (address === null || typeof address === "string") throw new Error("Model fixture API did not bind");
      const url = `http://127.0.0.1:${address.port}/v1/models`;
      expect((await fetch(url)).status).toBe(503);
      const recovered = await fetch(url);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ provider: "echo", models: ["fixture-model"] });
    } finally {
      await new Promise<void>((resolve, reject) => fixture.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("isolates tenant model routes, records route metadata, and restores them from SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cra-api-model-routing-"));
    const databasePath = join(directory, "agent.sqlite");
    const selectedTenants: string[] = [];
    const makeModel = (text: string) => ({
      async *stream() {
        yield { type: "text_delta" as const, text };
        yield { type: "done" as const };
      },
    });
    const productization = {
      auth: {
        required: true,
        tokens: [
          { token: "tenant-a-token", principalId: "user-a", tenantId: "tenant-a" },
          { token: "tenant-b-token", principalId: "user-b", tenantId: "tenant-b" },
        ],
      },
    };
    const createRoutingServer = () => createApiServer({
      databasePath,
      model: makeModel("host-model"),
      modelInfo: { provider: "deepseek", model: "host-model", baseUrl: "https://host.example.test", configured: true },
      availableModels: ["tenant-model-a", "tenant-model-b"],
      modelSelector: (model, tenantId) => {
        if (tenantId !== undefined) selectedTenants.push(tenantId);
        return {
          model: makeModel(`${tenantId ?? "local"}:${model}`),
          config: { provider: "deepseek", model, baseUrl: `https://${tenantId ?? "local"}.example.test`, configured: true },
        };
      },
      productization,
    });
    const auth = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
    let scoped = createRoutingServer();
    await new Promise<void>((resolve) => scoped.listen(0, "127.0.0.1", resolve));
    const address = scoped.address();
    if (address === null || typeof address === "string") throw new Error("Routing API did not bind");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${url}/v1/models`)).status).toBe(401);
      const sessionA = await (await fetch(`${url}/v1/sessions`, { method: "POST", headers: auth("tenant-a-token"), body: JSON.stringify({ workspaceRoot: "D:/tenant-a-routing" }) })).json() as { id: string };
      const sessionB = await (await fetch(`${url}/v1/sessions`, { method: "POST", headers: auth("tenant-b-token"), body: JSON.stringify({ workspaceRoot: "D:/tenant-b-routing" }) })).json() as { id: string };
      const initialA = await (await fetch(`${url}/v1/models`, { headers: { authorization: "Bearer tenant-a-token" } })).json() as { route?: unknown; current: string };
      expect(initialA).toMatchObject({ current: "host-model" });
      expect(initialA.route).toBeUndefined();
      const selected = await fetch(`${url}/v1/models`, { method: "POST", headers: auth("tenant-a-token"), body: JSON.stringify({ model: "tenant-model-a" }) });
      expect(selected.status).toBe(200);
      expect(await selected.json()).toMatchObject({ model: { model: "tenant-model-a" }, route: { provider: "deepseek", model: "tenant-model-a", baseUrl: "https://tenant-a.example.test" } });
      const visibleA = await (await fetch(`${url}/v1/models`, { headers: { authorization: "Bearer tenant-a-token" } })).json() as { route?: { model: string } };
      const visibleB = await (await fetch(`${url}/v1/models`, { headers: { authorization: "Bearer tenant-b-token" } })).json() as { route?: unknown; current: string };
      expect(visibleA.route?.model).toBe("tenant-model-a");
      expect(visibleB.route).toBeUndefined();
      expect(visibleB.current).toBe("host-model");

      await fetch(`${url}/v1/sessions/${sessionA.id}`, { method: "POST", headers: auth("tenant-a-token"), body: JSON.stringify({ content: "tenant A turn" }) });
      await fetch(`${url}/v1/sessions/${sessionB.id}`, { method: "POST", headers: auth("tenant-b-token"), body: JSON.stringify({ content: "tenant B turn" }) });
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const [projectionA, projectionB] = await Promise.all([
          fetch(`${url}/v1/sessions/${sessionA.id}`, { headers: { authorization: "Bearer tenant-a-token" } }).then((response) => response.json()) as Promise<{ status: string }>,
          fetch(`${url}/v1/sessions/${sessionB.id}`, { headers: { authorization: "Bearer tenant-b-token" } }).then((response) => response.json()) as Promise<{ status: string }>,
        ]);
        if (projectionA.status === "idle" && projectionB.status === "idle") break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      const eventsA = await (await fetch(`${url}/v1/sessions/${sessionA.id}/events?format=json`, { headers: { authorization: "Bearer tenant-a-token" } })).json() as { type: string; payload: Record<string, unknown> }[];
      const eventsB = await (await fetch(`${url}/v1/sessions/${sessionB.id}/events?format=json`, { headers: { authorization: "Bearer tenant-b-token" } })).json() as { type: string; payload: Record<string, unknown> }[];
      expect(eventsA.find((event) => event.type === "turn/started")?.payload).toMatchObject({ provider: "deepseek", model: "tenant-model-a", baseUrl: "https://tenant-a.example.test" });
      expect(eventsB.find((event) => event.type === "turn/started")?.payload).not.toHaveProperty("provider");
    } finally {
      await new Promise<void>((resolve, reject) => scoped.close((error) => error ? reject(error) : resolve()));
    }

    scoped = createRoutingServer();
    await new Promise<void>((resolve) => scoped.listen(0, "127.0.0.1", resolve));
    const reopenedAddress = scoped.address();
    if (reopenedAddress === null || typeof reopenedAddress === "string") throw new Error("Reopened routing API did not bind");
    try {
      const reopened = await (await fetch(`http://127.0.0.1:${reopenedAddress.port}/v1/models`, { headers: { authorization: "Bearer tenant-a-token" } })).json() as { route?: { model: string; baseUrl?: string } };
      expect(reopened.route).toMatchObject({ model: "tenant-model-a", baseUrl: "https://tenant-a.example.test" });
      expect(selectedTenants).toContain("tenant-a");
    } finally {
      await new Promise<void>((resolve, reject) => scoped.close((error) => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists a Session-scoped model selection and exposes it without credentials", async () => {
    const store = new InMemoryEventStore();
    const selectedModels: string[] = [];
    const makeModel = (text: string) => ({
      async *stream() {
        selectedModels.push(text);
        yield { type: "text_delta" as const, text };
        yield { type: "done" as const };
      },
    });
    const server = createApiServer({
      store,
      model: makeModel("default"),
      modelInfo: { provider: "fixture", model: "default", configured: true },
      availableModels: ["one", "two"],
      modelSelector: (model) => ({ model: makeModel(model), config: { provider: "fixture", model, configured: true } }),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Session model API did not bind");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const session = await (await fetch(`${url}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/session-model-api" }) })).json() as { id: string };
      const selected = await fetch(`${url}/v1/sessions/${session.id}/model`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "session-model-1" }, body: JSON.stringify({ model: "two" }) });
      expect(selected.status).toBe(200);
      expect(await selected.json()).toMatchObject({ selection: { provider: "fixture", model: "two" } });
      const repeated = await fetch(`${url}/v1/sessions/${session.id}/model`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "session-model-1" }, body: JSON.stringify({ model: "two" }) });
      expect(repeated.status).toBe(200);
      const visible = await (await fetch(`${url}/v1/sessions/${session.id}/model`)).json() as { selection: { model: string } };
      expect(visible.selection.model).toBe("two");
      await fetch(`${url}/v1/sessions/${session.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "use selected model" }) });
      for (let attempt = 0; attempt < 50 && selectedModels.length === 0; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      expect(selectedModels).toContain("two");
      const events = await (await fetch(`${url}/v1/sessions/${session.id}/events?format=json`)).json() as { type: string }[];
      expect(events.filter((event) => event.type === "session/model_selected")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("secret");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("restores a Session model selection after an API restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cra-api-session-model-restart-"));
    const databasePath = join(directory, "agent.sqlite");
    const makeModel = (text: string) => ({
      async *stream() {
        yield { type: "text_delta" as const, text };
        yield { type: "done" as const };
      },
    });
    const options = {
      databasePath,
      model: makeModel("default"),
      modelInfo: { provider: "fixture", model: "default", configured: true },
      availableModels: ["one", "two"],
      modelSelector: (model: string) => ({ model: makeModel(model), config: { provider: "fixture", model, configured: true } }),
    };
    const start = async () => {
      const server = createApiServer(options);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Restart fixture API did not bind");
      return { server, url: `http://127.0.0.1:${address.port}` };
    };
    let current = await start();
    try {
      const created = await (await fetch(`${current.url}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: "D:/session-model-restart" }) })).json() as { id: string };
      expect((await fetch(`${current.url}/v1/sessions/${created.id}/model`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "two" }) })).status).toBe(200);
      await new Promise<void>((resolve, reject) => current.server.close((error) => error ? reject(error) : resolve()));
      current = await start();
      const visible = await (await fetch(`${current.url}/v1/sessions/${created.id}/model`)).json() as { selection: { model: string } };
      expect(visible.selection.model).toBe("two");
      await fetch(`${current.url}/v1/sessions/${created.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "after restart" }) });
      let projection: { messages: { content: string }[] } | undefined;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        projection = await (await fetch(`${current.url}/v1/sessions/${created.id}`)).json() as typeof projection;
        if (projection?.messages.at(-1)?.content === "two") break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(projection?.messages.at(-1)?.content).toBe("two");
    } finally {
      await new Promise<void>((resolve, reject) => current.server.close((error) => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("manages tenant credential references without exposing material and invalidates consumers on rotation or revoke", async () => {
    const scopedStore = new InMemoryEventStore();
    let lastMaterial: Record<string, unknown> | undefined;
    const makeModel = (text: string) => ({
      async *stream() {
        yield { type: "text_delta" as const, text };
        yield { type: "done" as const };
      },
    });
    const scoped = createApiServer({
      store: scopedStore,
      model: makeModel("host-model"),
      modelInfo: { provider: "deepseek", model: "host-model", baseUrl: "https://host.example.test", configured: true },
      availableModels: ["tenant-model"],
      modelSelector: (model, tenantId, credential) => {
        lastMaterial = credential?.headers as Record<string, unknown> | undefined;
        return { model: makeModel(`${tenantId ?? "local"}:${model}`), config: { provider: "deepseek", model, baseUrl: "https://tenant.example.test", configured: true } };
      },
      productization: { auth: { required: true, tokens: [{ token: "tenant-a-token", principalId: "user-a", tenantId: "tenant-a" }] } },
    });
    await new Promise<void>((resolve) => scoped.listen(0, "127.0.0.1", resolve));
    const address = scoped.address();
    if (address === null || typeof address === "string") throw new Error("Credential API did not bind");
    const url = `http://127.0.0.1:${address.port}`;
    const auth = { authorization: "Bearer tenant-a-token", "content-type": "application/json" };
    try {
      const createdResponse = await fetch(`${url}/v1/credentials`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "header", label: "Provider", material: { headers: { authorization: "Bearer secret-value" } } }) });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { credential: { id: string; kind: string; version: number } };
      expect(JSON.stringify(created)).not.toContain("secret-value");
      const listed = await (await fetch(`${url}/v1/credentials`, { headers: { authorization: auth.authorization } })).json() as { credentials: Record<string, unknown>[] };
      expect(JSON.stringify(listed)).not.toContain("secret-value");

      const selected = await fetch(`${url}/v1/models`, { method: "POST", headers: auth, body: JSON.stringify({ model: "tenant-model", credentialRef: { id: created.credential.id, kind: "header", version: created.credential.version } }) });
      expect(selected.status).toBe(200);
      expect(await selected.json()).toMatchObject({ route: { model: "tenant-model", credentialRef: { id: created.credential.id, version: 1 } } });
      expect(lastMaterial).toEqual({ authorization: "Bearer secret-value" });
      expect((await fetch(`${url}/v1/credentials/${encodeURIComponent(created.credential.id)}`, { method: "DELETE", headers: { authorization: auth.authorization } })).status).toBe(409);

      const rotatedResponse = await fetch(`${url}/v1/credentials/${encodeURIComponent(created.credential.id)}/rotate`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "header", material: { headers: { authorization: "Bearer rotated-value" } } }) });
      expect(rotatedResponse.status).toBe(200);
      expect((await rotatedResponse.json() as { credential: { version: number } }).credential.version).toBe(2);
      const afterRotate = await (await fetch(`${url}/v1/models`, { headers: { authorization: auth.authorization } })).json() as { route?: { credentialRef?: { version?: number } } };
      expect(afterRotate.route?.credentialRef?.version).toBe(2);
      expect(lastMaterial).toEqual({ authorization: "Bearer rotated-value" });

      const revokedResponse = await fetch(`${url}/v1/credentials/${encodeURIComponent(created.credential.id)}/revoke`, { method: "POST", headers: auth });
      expect(revokedResponse.status).toBe(200);
      const afterRevoke = await (await fetch(`${url}/v1/models`, { headers: { authorization: auth.authorization } })).json() as { current: string; route?: unknown };
      expect(afterRevoke).toMatchObject({ current: "host-model" });
      expect(afterRevoke.route).toBeUndefined();
      expect((await fetch(`${url}/v1/credentials/${encodeURIComponent(created.credential.id)}`, { method: "DELETE", headers: { authorization: auth.authorization } })).status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => scoped.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("enforces bearer auth, durable tenant isolation, quota, and restart replay", async () => {
    const scopedStore = new InMemoryEventStore();
    const scoped = createApiServer({
      store: scopedStore,
      productization: {
        auth: {
          required: true,
          tokens: [
            { token: "tenant-a-token", principalId: "user-a", tenantId: "tenant-a" },
            { token: "tenant-b-token", principalId: "user-b", tenantId: "tenant-b" },
          ],
        },
        quota: { maxSessionsPerTenant: 1, maxTurnsPerTenant: 1 },
      },
    });
    await new Promise<void>((resolve) => scoped.listen(0, "127.0.0.1", resolve));
    const address = scoped.address();
    if (address === null || typeof address === "string") throw new Error("Scoped API did not bind");
    const url = `http://127.0.0.1:${address.port}`;
    const auth = (token: string) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });
    try {
      const unauthenticated = await fetch(`${url}/v1/sessions`);
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get("www-authenticate")).toBe("Bearer");
      const capabilities = await (await fetch(`${url}/v1/capabilities`, { headers: { authorization: "Bearer tenant-a-token" } })).json() as { productization: { enabled: boolean; auth: { mode: string }; tenantIsolation: { sessionOwnership: string }; quota: { status: string; enforcement: string } } };
      expect(capabilities.productization).toMatchObject({ enabled: true, auth: { mode: "bearer" }, tenantIsolation: { sessionOwnership: "durable" }, quota: { status: "configured", enforcement: "hard" } });

      const first = await fetch(`${url}/v1/sessions`, { method: "POST", headers: auth("tenant-a-token"), body: JSON.stringify({ workspaceRoot: "D:/tenant-a" }) });
      expect(first.status).toBe(201);
      const firstSession = await first.json() as { id: string; ownership: { principalId: string; tenantId: string } };
      expect(firstSession.ownership).toEqual({ principalId: "user-a", tenantId: "tenant-a" });
      const deniedByQuota = await fetch(`${url}/v1/sessions`, { method: "POST", headers: auth("tenant-a-token"), body: JSON.stringify({ workspaceRoot: "D:/tenant-a-two" }) });
      expect(deniedByQuota.status).toBe(429);

      const second = await fetch(`${url}/v1/sessions`, { method: "POST", headers: auth("tenant-b-token"), body: JSON.stringify({ workspaceRoot: "D:/tenant-b" }) });
      expect(second.status).toBe(201);
      const secondSession = await second.json() as { id: string };
      const visibleToA = await (await fetch(`${url}/v1/sessions`, { headers: { authorization: "Bearer tenant-a-token" } })).json() as { sessions: { id: string }[] };
      expect(visibleToA.sessions.map((session) => session.id)).toEqual([firstSession.id]);
      expect((await fetch(`${url}/v1/sessions/${secondSession.id}`, { headers: { authorization: "Bearer tenant-a-token" } })).status).toBe(404);

      const workspacesA = await (await fetch(`${url}/v1/workspaces`, { headers: { authorization: "Bearer tenant-a-token" } })).json() as { workspaces: { root: string; label?: string }[] };
      const workspacesB = await (await fetch(`${url}/v1/workspaces`, { headers: { authorization: "Bearer tenant-b-token" } })).json() as { workspaces: { root: string; label?: string }[] };
      expect(workspacesA.workspaces.map((workspace) => workspace.root)).toEqual(["D:/tenant-a"]);
      expect(workspacesB.workspaces.map((workspace) => workspace.root)).toEqual(["D:/tenant-b"]);
      const renamedWorkspace = await fetch(`${url}/v1/workspaces/${encodeURIComponent("D:/tenant-a")}/label`, { method: "POST", headers: { ...auth("tenant-a-token"), "idempotency-key": "tenant-a-workspace-rename" }, body: JSON.stringify({ label: "Tenant A workspace" }) });
      expect(renamedWorkspace.status).toBe(200);
      expect(((await renamedWorkspace.json()) as { workspaces: { root: string; label?: string }[] }).workspaces[0]).toMatchObject({ root: "D:/tenant-a", label: "Tenant A workspace" });
      const crossTenantWorkspaceMutation = await fetch(`${url}/v1/workspaces/${encodeURIComponent("D:/tenant-a")}/label`, { method: "POST", headers: { ...auth("tenant-b-token"), "idempotency-key": "tenant-b-cross-tenant-workspace" }, body: JSON.stringify({ label: "Must not leak" }) });
      expect(crossTenantWorkspaceMutation.status).toBe(404);

      const mcpAdded = await fetch(`${url}/v1/mcp/servers`, { method: "POST", headers: { ...auth("tenant-a-token"), "content-type": "application/json" }, body: JSON.stringify({ name: "tenant-a-mcp", scope: "user", transport: "stdio", command: "fixture", enabled: false, start: false, env: { AUTH_TOKEN: "must-not-leak" } }) });
      expect(mcpAdded.status).toBe(201);
      const tenantAMcp = await (await fetch(`${url}/v1/mcp/servers`, { headers: { authorization: "Bearer tenant-a-token" } })).json() as { servers: { config: { name: string; tenantId?: string; env?: Record<string, string> } }[] };
      expect(tenantAMcp.servers).toHaveLength(1);
      expect(tenantAMcp.servers[0]?.config).toMatchObject({ name: "tenant-a-mcp", tenantId: "tenant-a", env: { AUTH_TOKEN: "[redacted]" } });
      const tenantBMcp = await (await fetch(`${url}/v1/mcp/servers`, { headers: { authorization: "Bearer tenant-b-token" } })).json() as { servers: unknown[] };
      expect(tenantBMcp.servers).toEqual([]);
      const foreignMcpCatalog = await fetch(`${url}/v1/mcp/servers/tenant-a-mcp/catalog`, { headers: { authorization: "Bearer tenant-b-token" } });
      expect(foreignMcpCatalog.status).toBe(404);
      const foreignMcpDelete = await fetch(`${url}/v1/mcp/servers/tenant-a-mcp`, { method: "DELETE", headers: { authorization: "Bearer tenant-b-token" } });
      expect(foreignMcpDelete.status).toBe(404);

      expect((await fetch(`${url}/v1/sessions/${firstSession.id}`, { method: "POST", headers: auth("tenant-a-token"), body: JSON.stringify({ content: "one turn" }) })).status).toBe(202);
      expect((await fetch(`${url}/v1/sessions/${firstSession.id}`, { method: "POST", headers: auth("tenant-a-token"), body: JSON.stringify({ content: "second turn" }) })).status).toBe(429);
    } finally {
      await new Promise<void>((resolve, reject) => scoped.close((error) => error ? reject(error) : resolve()));
    }

    const reopened = createApiServer({
      store: scopedStore,
      productization: { auth: { required: true, tokens: [{ token: "tenant-a-token", principalId: "user-a", tenantId: "tenant-a" }, { token: "tenant-b-token", principalId: "user-b", tenantId: "tenant-b" }] }, quota: { maxSessionsPerTenant: 1, maxTurnsPerTenant: 1 } },
    });
    await new Promise<void>((resolve) => reopened.listen(0, "127.0.0.1", resolve));
    const reopenedAddress = reopened.address();
    if (reopenedAddress === null || typeof reopenedAddress === "string") throw new Error("Reopened scoped API did not bind");
    try {
      const replayed = await (await fetch(`http://127.0.0.1:${reopenedAddress.port}/v1/sessions`, { headers: { authorization: "Bearer tenant-a-token" } })).json() as { sessions: { ownership?: { tenantId?: string } }[] };
      expect(replayed.sessions).toHaveLength(1);
      expect(replayed.sessions[0]?.ownership?.tenantId).toBe("tenant-a");
    } finally {
      await new Promise<void>((resolve, reject) => reopened.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("supports idempotent commands and session lifecycle endpoints", async () => {
    const created = await fetch(`${baseUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/workspace" }),
    });
    const session = (await created.json()) as { id: string };
    const first = await fetch(`${baseUrl}/v1/sessions/${session.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "api-send-1" },
      body: JSON.stringify({ content: "idempotent" }),
    });
    const firstBody = (await first.json()) as { turnId: string };
    const repeated = await fetch(`${baseUrl}/v1/sessions/${session.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "api-send-1" },
      body: JSON.stringify({ content: "idempotent" }),
    });
    expect((await repeated.json()).turnId).toBe(firstBody.turnId);

    let projection: { status: string; messages: { content: string }[] };
    for (let attempt = 0; attempt < 50; attempt += 1) {
      projection = (await (await fetch(`${baseUrl}/v1/sessions/${session.id}`)).json()) as typeof projection;
      if (projection.status === "idle" && projection.messages.some((message) => message.content === "Echo: idempotent")) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(projection!.messages.at(-1)?.content).toBe("Echo: idempotent");
    await store.append({ sessionId: sessionId(session.id), type: "agent/status", payload: { status: "interrupted" } });
    const resumed = await fetch(`${baseUrl}/v1/sessions/${session.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "api-resume-1" },
      body: "{}",
    });
    expect(resumed.status).toBe(200);
    const forked = await fetch(`${baseUrl}/v1/sessions/${session.id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "api-fork-1" },
      body: JSON.stringify({ workspaceRoot: "D:/fork" }),
    });
    expect(forked.status).toBe(201);
    const forkedBody = (await forked.json()) as { sessionId: string };
    const forkedProjection = (await (await fetch(`${baseUrl}/v1/sessions/${forkedBody.sessionId}`)).json()) as { workspaceRoot: string; status: string; messages: { content: string }[] };
    expect(forkedProjection.workspaceRoot).toBe("D:/fork");
    expect(forkedProjection.status).toBe("idle");
    expect(forkedProjection.messages.at(-1)?.content).toBe("Echo: idempotent");
  });

  it("reopens the same SQLite database with session history intact", async () => {
    const directory = mkdtempSync(join(tmpdir(), "code-review-agent-api-"));
    const databasePath = join(directory, "agent.sqlite");
    const first = createApiServer({ databasePath });
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
    const firstAddress = first.address();
    if (firstAddress === null || typeof firstAddress === "string") throw new Error("API did not bind");
    const firstUrl = `http://127.0.0.1:${firstAddress.port}`;
    const created = await fetch(`${firstUrl}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRoot: "D:/restart" }),
    });
    const session = (await created.json()) as { id: string };
    await new Promise<void>((resolve, reject) => first.close((error) => (error ? reject(error) : resolve())));

    const second = createApiServer({ databasePath });
    await new Promise<void>((resolve) => second.listen(0, "127.0.0.1", resolve));
    const secondAddress = second.address();
    if (secondAddress === null || typeof secondAddress === "string") throw new Error("API did not bind");
    const restored = await (await fetch(`http://127.0.0.1:${secondAddress.port}/v1/sessions/${session.id}`)).json() as { workspaceRoot: string; lastSequence: number };
    expect(restored.workspaceRoot).toBe("D:/restart");
    expect(restored.lastSequence).toBe(1);
    await new Promise<void>((resolve, reject) => second.close((error) => (error ? reject(error) : resolve())));
    rmSync(directory, { recursive: true, force: true });
  });

  it("restores a pending tool permission after an API restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "code-review-agent-permission-recovery-"));
    const databasePath = join(directory, "agent.sqlite");
    const first = createApiServer({ databasePath });
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
    const firstAddress = first.address();
    if (firstAddress === null || typeof firstAddress === "string") throw new Error("API did not bind");
    const firstUrl = `http://127.0.0.1:${firstAddress.port}`;
    const session = await (await fetch(`${firstUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: directory }) })).json() as { id: string };
    const pending = await (await fetch(`${firstUrl}/v1/sessions/${session.id}/tools`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "restart-write-1" }, body: JSON.stringify({ name: "write_file", input: { path: "restored.txt", content: "restored" } }) })).json() as { permission: { id: string } };
    await new Promise<void>((resolve, reject) => first.close((error) => (error ? reject(error) : resolve())));

    const second = createApiServer({ databasePath });
    await new Promise<void>((resolve) => second.listen(0, "127.0.0.1", resolve));
    const secondAddress = second.address();
    if (secondAddress === null || typeof secondAddress === "string") throw new Error("API did not bind");
    const approved = await fetch(`http://127.0.0.1:${secondAddress.port}/v1/sessions/${session.id}/permissions/${pending.permission.id}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "restart-approve-1" }, body: JSON.stringify({ status: "approved" }) });
    expect(approved.status).toBe(200); expect(readFileSync(join(directory, "restored.txt"), "utf8")).toBe("restored");
    await new Promise<void>((resolve, reject) => second.close((error) => (error ? reject(error) : resolve())));
    rmSync(directory, { recursive: true, force: true });
  });

  it("restores a pending user interaction after an API restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "code-review-agent-interaction-recovery-"));
    const databasePath = join(directory, "agent.sqlite");
    let modelCalls = 0;
    const model = {
      async *stream() {
        if (modelCalls++ === 0) {
          yield { type: "tool_call_start" as const, index: 0, id: "call_api_interaction_restart", name: "ask_user" };
          yield { type: "tool_call_delta" as const, index: 0, arguments: JSON.stringify({ question: "Continue after API restart?", options: [{ label: "Yes", value: "yes" }] }) };
          yield { type: "done" as const };
        } else {
          yield { type: "text_delta" as const, text: "API interaction recovered." };
          yield { type: "done" as const };
        }
      },
    };
    const first = createApiServer({ databasePath, model });
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
    try {
      const firstAddress = first.address();
      if (firstAddress === null || typeof firstAddress === "string") throw new Error("API did not bind");
      const firstUrl = `http://127.0.0.1:${firstAddress.port}`;
      const session = await (await fetch(`${firstUrl}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: directory }) })).json() as { id: string };
      await fetch(`${firstUrl}/v1/sessions/${session.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "ask before continuing" }) });
      let interactionId: string | undefined;
      for (let attempt = 0; attempt < 100 && interactionId === undefined; attempt += 1) {
        const projection = await (await fetch(`${firstUrl}/v1/sessions/${session.id}`)).json() as { interactions?: { id: string; status: string }[] };
        interactionId = projection.interactions?.find((item) => item.status === "pending")?.id;
        if (interactionId === undefined) await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(interactionId).toBeDefined();
      await new Promise<void>((resolve, reject) => first.close((error) => (error ? reject(error) : resolve())));

      const second = createApiServer({ databasePath, model });
      await new Promise<void>((resolve) => second.listen(0, "127.0.0.1", resolve));
      try {
        const secondAddress = second.address();
        if (secondAddress === null || typeof secondAddress === "string") throw new Error("API did not bind");
        const secondUrl = `http://127.0.0.1:${secondAddress.port}`;
        const restored = await (await fetch(`${secondUrl}/v1/sessions/${session.id}`)).json() as { status: string; interactions?: { id: string; status: string }[] };
        expect(restored.status).toBe("interrupted");
        expect(restored.interactions?.find((item) => item.id === interactionId)?.status).toBe("pending");
        const answered = await fetch(`${secondUrl}/v1/sessions/${session.id}/interactions/${interactionId}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "restart-interaction-answer-1" }, body: JSON.stringify({ status: "answered", answer: "yes" }) });
        expect(answered.status).toBe(200);
        let projection: { messages: { content: string }[] } = { messages: [] };
        for (let attempt = 0; attempt < 100; attempt += 1) { projection = await (await fetch(`${secondUrl}/v1/sessions/${session.id}`)).json() as typeof projection; if (projection.messages.some((message) => message.content.includes("API interaction recovered"))) break; await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
        expect(projection.messages.some((message) => message.content.includes("API interaction recovered"))).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) => second.close((error) => (error ? reject(error) : resolve())));
      }
    } finally {
      if ((first as { listening?: boolean }).listening) await new Promise<void>((resolve, reject) => first.close((error) => (error ? reject(error) : resolve())));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
