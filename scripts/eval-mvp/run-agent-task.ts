import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createConfiguredApiServer } from "../../apps/api/src/server.ts";
// This must be the same module identity used by the API server. The eval
// script runs from the repository root, where the workspace alias is not
// resolvable, whereas the API resolves this exact built package through its
// own node_modules junction. Importing the source file here makes
// `store instanceof SqliteEventStore` false inside the API and disables local
// provider profiles.
import { SqliteEventStore } from "../../apps/api/node_modules/@code-review-agent/storage/dist/index.js";

const execFileAsync = promisify(execFile);

type Task = {
  readonly id: string;
  readonly problemStatement: string;
};

type SessionProjection = {
  readonly status: string;
  readonly turns: readonly { readonly id: string; readonly status: string }[];
  readonly permissions?: readonly {
    readonly id: string;
    readonly status: string;
    readonly riskLevel?: string;
    readonly workspaceRoot?: string;
  }[];
};

type HealthResponse = {
  readonly ok: boolean;
  readonly model?: {
    readonly provider: string;
    readonly model: string;
    readonly baseUrl?: string;
    readonly configured: boolean;
  };
};

type SessionModelSelectionResponse = {
  readonly model: {
    readonly provider: string;
    readonly model: string;
    readonly baseUrl?: string;
  };
};

type AgentEvent = {
  readonly sequence: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const datasetRoot = process.env["CODING_AGENT_DATASET_ROOT"] ?? "D:/Develop/coding-agent-test/datasets/swebench-lite/pilot-01";
const datasetVersion = path.basename(datasetRoot);
const taskId = process.argv[2] ?? "pallets__flask-4045";
const taskPath = path.join(datasetRoot, "public", "tasks", taskId, "task.json");
const preparedWorkspace = path.join(datasetRoot, "runtime", "workspaces", taskId);
const resultGroup = sanitizePathSegment(process.env["CODING_AGENT_RUN_GROUP"] ?? "agent-smoke");
const runIdPrefix = sanitizePathSegment(process.env["CODING_AGENT_RUN_ID_PREFIX"] ?? "agent-smoke");
const runId = `${runIdPrefix}-${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 17)}`;
const runDirectory = path.join(datasetRoot, "results", resultGroup, taskId, runId);
const workspace = path.join(runDirectory, "workspace");
const databasePath = path.join(runDirectory, "agent.sqlite");
const eventsPath = path.join(runDirectory, "events.jsonl");
const diffPath = path.join(runDirectory, "agent.diff");
const statusPath = path.join(runDirectory, "git-status.json");
const resultPath = path.join(runDirectory, "result.json");
const autoApprovePermissions = process.env["EVAL_MVP_AUTO_APPROVE_PERMISSIONS"] !== "0";
// The benchmark runs with a fresh result database for every task, so its
// sessions cannot inherit the normal desktop session's model selection. These
// two variables select an already registered persistent provider profile for
// the isolated benchmark session without modifying the user's normal setting.
const evaluationProvider = process.env["EVAL_MVP_PROVIDER"]?.trim() || undefined;
const evaluationModel = process.env["EVAL_MVP_MODEL"]?.trim() || undefined;
const credentialMetadataPath = process.env["EVAL_MVP_CREDENTIAL_METADATA_PATH"]
  ?? path.join(repoRoot, "apps", "api", ".data", "code-review-agent.sqlite");

async function main(): Promise<void> {
  const task = JSON.parse(await readFile(taskPath, "utf8")) as Task;
  if (task.id !== taskId) throw new Error(`Task metadata id mismatch: ${task.id}`);
  if (!(await pathExists(preparedWorkspace))) throw new Error(`Prepared workspace does not exist: ${preparedWorkspace}`);

  await mkdir(runDirectory, { recursive: true });
  await execFileAsync("git", ["-c", "core.longpaths=true", "clone", "--no-local", "--quiet", preparedWorkspace, workspace], { cwd: repoRoot, windowsHide: true });
  await execFileAsync("git", ["-C", workspace, "config", "core.longpaths", "true"], { cwd: repoRoot, windowsHide: true });
  await assertCleanGit(workspace);

  const store = new SqliteEventStore(databasePath);
  // Task events stay isolated in `store`. Credential records are durable host
  // configuration, however, and must be read from the normal API metadata DB
  // so a profile credentialRef can be resolved against credentials.secrets.json.
  const credentialMetadataStore = new SqliteEventStore(credentialMetadataPath);
  // Use the same host-side `.env` model selection as the production API entrypoint.
  // `createConfiguredApiServer()` selects DeepSeek when MODEL_PROVIDER=auto and a
  // non-empty DEEPSEEK_API_KEY is available; tests can still force Echo by setting
  // MODEL_PROVIDER=echo explicitly.
  const server = createConfiguredApiServer({
    store,
    credentialBackend: credentialMetadataStore,
    permissionPreset: "danger-full-access",
  });
  let sessionId: string | undefined;
  const startedAt = new Date();
  let turnStatus = "failed";
  let turnId: string | undefined;
  let events: AgentEvent[] = [];
  let agentDiff = "";
  let gitStatus: string[] = [];
  let failureClass: string | null = null;
  let modelInfo: HealthResponse["model"];
  const autoApprovedPermissionIds: string[] = [];

  try {
    await listen(server);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Agent API did not bind to a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await requestJson<HealthResponse>(baseUrl, "/health");
    if (!health.ok) throw new Error("Health check returned ok=false");
    modelInfo = health.model;

    const created = await requestJson<{ id: string }>(baseUrl, "/v1/sessions", {
      method: "POST",
      body: { workspaceRoot: workspace, permissionPreset: "danger-full-access" },
    });
    sessionId = created.id;

    if (evaluationModel !== undefined) {
      const selection = await requestJson<SessionModelSelectionResponse>(baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/model`, {
        method: "POST",
        body: {
          model: evaluationModel,
          ...(evaluationProvider === undefined ? {} : { provider: evaluationProvider }),
        },
      });
      modelInfo = { ...selection.model, configured: true };
    }

    const sent = await requestJson<{ turnId: string }>(baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      // Keep the experiment equivalent to normal Web use: the task text is
      // the only task-specific prompt. Full workspace access is configured on
      // the session, not simulated through extra benchmark instructions.
      body: { content: task.problemStatement },
    });
    turnId = sent.turnId;

    // No benchmark-owned step or time budget. A human operator may interrupt
    // an unhealthy run just as they would in the Web UI; terminal turn state
    // is recorded below.
    while (true) {
      const projection = await requestJson<SessionProjection>(baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}`);
      if (autoApprovePermissions) {
        for (const permission of projection.permissions ?? []) {
          if (permission.status !== "pending" || !["execute", "write"].includes(permission.riskLevel ?? "") || permission.workspaceRoot !== workspace) continue;
          await requestJson(baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permission.id)}`, {
            method: "POST",
            body: { status: "approved" },
          });
          autoApprovedPermissionIds.push(permission.id);
        }
      }
      const turn = projection.turns.find((candidate) => candidate.id === turnId);
      if (turn !== undefined && ["completed", "failed", "stopped", "interrupted"].includes(turn.status)) {
        turnStatus = turn.status;
        break;
      }
      await delay(25);
    }
    if (turnStatus === "failed") failureClass = "agent_failed";
    if (turnStatus === "stopped" || turnStatus === "interrupted") failureClass = "interrupted";

    events = await requestJson<AgentEvent[]>(baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/events?format=json`);
    await writeFile(eventsPath, events.map((event) => JSON.stringify(event)).join("\n") + (events.length === 0 ? "" : "\n"), "utf8");
    agentDiff = (await execFileAsync("git", ["-C", workspace, "-c", "core.longpaths=true", "-c", "core.fileMode=false", "diff", "--binary"], { cwd: repoRoot, windowsHide: true })).stdout;
    const statusPorcelain = (await execFileAsync("git", ["-C", workspace, "-c", "core.longpaths=true", "status", "--porcelain=v1", "--untracked-files=all", "-z"], { cwd: repoRoot, windowsHide: true })).stdout;
    gitStatus = parseChangedPaths(statusPorcelain);
    await writeFile(diffPath, agentDiff, "utf8");
    await writeFile(statusPath, JSON.stringify({ workspace, changedFiles: gitStatus, porcelain: statusPorcelain }, null, 2) + "\n", "utf8");
  } catch (error) {
    failureClass ??= "agent_failed";
    await writeFile(path.join(runDirectory, "error.txt"), error instanceof Error ? error.stack ?? error.message : String(error), "utf8");
    throw error;
  } finally {
    const endedAt = new Date();
    const toolCalls = events.filter((event) => event.type === "tool/call").length;
    const steps = events.filter((event) => event.type === "step/started").length;
    const result = {
      schemaVersion: 1,
      runId,
      resultGroup,
      taskId,
      datasetVersion,
      agentVersion: "workspace-smoke",
      provider: modelInfo?.provider ?? "unknown",
      model: modelInfo?.model ?? "unknown",
      modelConfigured: modelInfo?.configured ?? false,
      autoApprovePermissions,
      autoApprovedPermissions: autoApprovedPermissionIds.length,
      status: turnStatus === "completed" ? "completed" : turnStatus,
      transportSmoke: (modelInfo?.provider ?? "unknown") === "echo",
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      sessionId: sessionId ?? null,
      turnId: turnId ?? null,
      turnStatus,
      steps,
      toolCalls,
      events: { path: eventsPath, count: events.length, lastSequence: events.at(-1)?.sequence ?? 0 },
      workspace,
      diff: {
        path: diffPath,
        changedFiles: gitStatus,
        bytes: Buffer.byteLength(agentDiff),
      },
      gitStatusPath: statusPath,
      failureClass,
    };
    await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");
    await closeServer(server);
    store.close();
    credentialMetadataStore.close();
  }

  console.log(`Agent run completed: task=${taskId} provider=${modelInfo?.provider ?? "unknown"} model=${modelInfo?.model ?? "unknown"} turn=${turnStatus}`);
  console.log(`Result: ${resultPath}`);
}

async function requestJson<T>(baseUrl: string, resource: string, options: { readonly method?: string; readonly body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${resource}`, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`API ${options.method ?? "GET"} ${resource} failed (${response.status}): ${text}`);
  return JSON.parse(text) as T;
}

async function assertCleanGit(directory: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["-C", directory, "-c", "core.longpaths=true", "status", "--porcelain"], { cwd: repoRoot, windowsHide: true });
  if (stdout.trim().length > 0) throw new Error(`Workspace is not clean: ${directory}`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await readFile(target);
    return true;
  } catch {
    try {
      await import("node:fs/promises").then(({ stat }) => stat(target));
      return true;
    } catch {
      return false;
    }
  }
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function parseChangedPaths(statusPorcelain: string): string[] {
  return statusPorcelain
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.length > 3 ? entry.slice(3) : entry);
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/gu, "-");
  return sanitized.length === 0 ? "agent-smoke" : sanitized.slice(0, 80);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
