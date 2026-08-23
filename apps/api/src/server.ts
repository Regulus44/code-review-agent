import { createReadStream, existsSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createInProcessSubagentProvider, sessionId, AgentHost, turnId } from "@code-review-agent/runtime";
import { SqliteEventStore } from "@code-review-agent/storage";
import { brand, type AgentEvent, type ChatModel, type GoalStatus, type InteractionId, type PermissionId, type PlanStatus, type SessionEventStore, type TodoItem } from "@code-review-agent/contracts";
import { SubagentRuntime } from "@code-review-agent/subagent";
import { createConfiguredChatModel, DEEPSEEK_MODELS, type ModelConfigView } from "@code-review-agent/llm";
import { McpConnectionManager, type McpServerConfig } from "@code-review-agent/mcp-client";
import type { CodeModeSandbox, PermissionPreset } from "@code-review-agent/tools";
import { artifactAccessResponse, inspectArtifact, isAvailableArtifact, type ArtifactAccess } from "./artifacts.js";
import { attachmentCapability, AttachmentInputError, stageAttachment, type AttachmentPolicy } from "./attachments.js";

export interface ModelSelection {
  readonly model: ChatModel;
  readonly config: ModelConfigView;
}

export interface ApiServerOptions {
  readonly store?: SessionEventStore;
  readonly databasePath?: string;
  readonly host?: AgentHost;
  readonly model?: ChatModel;
  readonly modelInfo?: ModelConfigView;
  readonly availableModels?: readonly string[];
  readonly modelSelector?: (model: string) => ModelSelection;
  readonly permissionPreset?: PermissionPreset;
  readonly mcp?: McpConnectionManager;
  readonly subagentRuntime?: SubagentRuntime;
  readonly attachmentPolicy?: AttachmentPolicy;
  readonly contextBudget?: {
    readonly maxTokens?: number;
    readonly recentMessageTokens?: number;
    readonly maxToolResultChars?: number;
    readonly maxSummaryChars?: number;
  };
  readonly codeMode?: CodeModeSandbox;
  readonly webRoot?: string;
}

export function createApiServer(options: ApiServerOptions = {}): Server {
  const ownsStore = options.store === undefined && options.host === undefined;
  const store = options.store ?? (options.host === undefined ? new SqliteEventStore({ databasePath: options.databasePath ?? defaultDatabasePath() }) : undefined);
  const subagentRuntime = options.subagentRuntime ?? new SubagentRuntime({ store: store as SessionEventStore });
  const host = options.host ?? new AgentHost({ store: store as SessionEventStore, ...(options.model === undefined ? {} : { model: options.model }), ...(options.permissionPreset === undefined ? {} : { permissionPreset: options.permissionPreset }), ...(options.contextBudget === undefined ? {} : { contextBudget: options.contextBudget }), ...(options.codeMode === undefined ? {} : { codeMode: options.codeMode }), subagentRuntime });
  if (!subagentRuntime.providerCatalog().some((provider) => provider.name === "in-process")) subagentRuntime.registerProvider(createInProcessSubagentProvider({ store: store as SessionEventStore, ...(options.model === undefined ? {} : { model: options.model }), baseToolDefinitions: host.toolRegistry().listAll(), subagentRuntime }));
  const modelRuntime: ModelRuntimeState = {
    availableModels: options.availableModels ?? [],
    ...(options.modelInfo === undefined ? {} : { info: options.modelInfo }),
    ...(options.modelSelector === undefined ? {} : { selector: options.modelSelector }),
  };
  const ownsMcp = options.mcp === undefined;
  const mcp = options.mcp ?? new McpConnectionManager({
    registry: host.toolRegistry(),
    ...(store === undefined ? {} : { store }),
    ...(store instanceof SqliteEventStore ? { configBackend: store } : {}),
  });
  void mcp.startConfigured();
  const persistence = store instanceof SqliteEventStore ? "sqlite" : "custom";
  const webRoot = options.webRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
  const server = createServer((request, response) => {
    void handleRequest(request, response, host, mcp, subagentRuntime, webRoot, persistence, modelRuntime, options.attachmentPolicy);
  });
  if (ownsStore && store instanceof SqliteEventStore) server.on("close", () => store.close());
  if (ownsMcp) server.on("close", () => { void mcp.close(); });
  return server;
}

function defaultDatabasePath(): string {
  // Keep the local database stable when the API is started from the repository
  // root, apps/api, or a process manager with a different working directory.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.data/code-review-agent.sqlite");
}

/** CLI/runtime entry that opts into local `.env` model configuration. Tests stay deterministic via createApiServer(). */
export function createConfiguredApiServer(options: ApiServerOptions = {}): Server {
  if (options.host !== undefined || options.model !== undefined) return createApiServer(options);
  const configured = createConfiguredChatModel();
  const switchOptions: ApiServerOptions = configured.config.provider === "deepseek" ? {
    ...(options.availableModels === undefined ? { availableModels: DEEPSEEK_MODELS } : { availableModels: options.availableModels }),
    ...(options.modelSelector === undefined ? {
      modelSelector: (model: string) => {
        const selected = createConfiguredChatModel({ ...process.env, MODEL_PROVIDER: "deepseek", DEEPSEEK_MODEL: model });
        return { model: selected.model, config: selected.config };
      },
    } : { modelSelector: options.modelSelector }),
  } : {
    ...(options.availableModels === undefined ? { availableModels: [] } : { availableModels: options.availableModels }),
  };
  return createApiServer({
    ...options,
    model: configured.model,
    modelInfo: options.modelInfo ?? configured.config,
    ...switchOptions,
  });
}

interface ModelRuntimeState {
  info?: ModelConfigView;
  readonly availableModels: readonly string[];
  readonly selector?: (model: string) => ModelSelection;
}

function currentAttachmentCapability(policy: AttachmentPolicy | undefined, modelRuntime: ModelRuntimeState) {
  return attachmentCapability(policy, modelRuntime.info?.model.includes("vision") === true);
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, host: AgentHost, mcp: McpConnectionManager, subagents: SubagentRuntime, webRoot: string, persistence: string, modelRuntime: ModelRuntimeState, attachmentPolicy: AttachmentPolicy | undefined): Promise<void> {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type, idempotency-key, last-event-id");
  response.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "code-review-agent", runtime: "typescript", persistence, ...(modelRuntime.info === undefined ? {} : { model: modelRuntime.info }) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      sendJson(response, 200, {
        provider: modelRuntime.info?.provider ?? "custom",
        current: modelRuntime.info?.model ?? "custom",
        configured: modelRuntime.info?.configured ?? false,
        models: modelRuntime.availableModels,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/models") {
      if (modelRuntime.selector === undefined) throw new HttpError(409, "model switching is not configured");
      const body = await readJson(request);
      if (typeof body.model !== "string" || body.model.length === 0) throw new HttpError(400, "model is required");
      if (!modelRuntime.availableModels.includes(body.model)) throw new HttpError(400, "unsupported model");
      const selected = modelRuntime.selector(body.model);
      host.setModel(selected.model);
      modelRuntime.info = selected.config;
      sendJson(response, 200, { model: selected.config });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/tools") {
      sendJson(response, 200, { tools: host.listTools() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      sendJson(response, 200, { attachments: currentAttachmentCapability(attachmentPolicy, modelRuntime), context: host.contextSettings(), codeMode: host.codeModeSettings(), lsp: host.lspSettings() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/workspaces") {
      sendJson(response, 200, await host.listWorkspaces(url.searchParams.get("include_archived") === "true"));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/workspaces/reorder") {
      const body = await readJson(request);
      if (!Array.isArray(body.order) || body.order.some((value: unknown) => typeof value !== "string")) throw new HttpError(400, "order must be an array of workspace keys");
      sendJson(response, 200, await host.reorderWorkspaces(body.order as string[], commandId(request, body)));
      return;
    }
    const workspaceRenameMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/label$/u);
    if (request.method === "POST" && workspaceRenameMatch?.[1] !== undefined) {
      const body = await readJson(request);
      if (typeof body.label !== "string") throw new HttpError(400, "label is required");
      sendJson(response, 200, await host.renameWorkspace(decodeURIComponent(workspaceRenameMatch[1]), body.label, commandId(request, body)));
      return;
    }
    const workspaceArchiveMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/archive$/u);
    if (request.method === "POST" && workspaceArchiveMatch?.[1] !== undefined) {
      const body = await readJson(request);
      const archived = body.archived === undefined ? true : body.archived;
      if (typeof archived !== "boolean") throw new HttpError(400, "archived must be a boolean");
      sendJson(response, 200, await host.archiveWorkspace(decodeURIComponent(workspaceArchiveMatch[1]), archived, commandId(request, body)));
      return;
    }
    const workspaceDeleteMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)$/u);
    if (request.method === "DELETE" && workspaceDeleteMatch?.[1] !== undefined) {
      sendJson(response, 200, await host.deleteWorkspace(decodeURIComponent(workspaceDeleteMatch[1]), commandId(request)));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/mcp/servers") {
      sendJson(response, 200, { servers: mcp.list() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/mcp/servers") {
      const body = await readJson(request);
      const { start, ...configBody } = body;
      const existing = typeof configBody.name === "string" ? mcp.get(configBody.name) : undefined;
      if (typeof body.expectedRevision === "number" && existing?.revision !== body.expectedRevision) throw new HttpError(409, "MCP config revision conflict");
      sendJson(response, 201, await mcp.add(configBody as unknown as McpServerConfig, start !== false));
      return;
    }
    const mcpMatch = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)$/u);
    const mcpResourceMatch = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)\/resources$/u);
    const mcpCatalogMatch = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)\/catalog$/u);
    if (mcpCatalogMatch?.[1] !== undefined && request.method === "GET") {
      const name = decodeURIComponent(mcpCatalogMatch[1]);
      const server = mcp.get(name);
      if (server === undefined) throw new HttpError(404, "MCP server not found");
      sendJson(response, 200, { server, discovery: mcp.discovery(name) ?? { tools: [], resources: [], prompts: [] } });
      return;
    }
    if (mcpResourceMatch?.[1] !== undefined && request.method === "GET") {
      const uri = url.searchParams.get("uri");
      if (uri === null || uri.length === 0) throw new HttpError(400, "uri is required");
      sendJson(response, 200, await mcp.readResource(decodeURIComponent(mcpResourceMatch[1]), uri));
      return;
    }
    const mcpPromptMatch = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)\/prompts$/u);
    if (mcpPromptMatch?.[1] !== undefined && request.method === "POST") {
      const body = await readJson(request);
      if (typeof body.name !== "string") throw new HttpError(400, "name is required");
      sendJson(response, 200, await mcp.getPrompt(decodeURIComponent(mcpPromptMatch[1]), body.name, body.arguments as Record<string, string> | undefined));
      return;
    }
    if (mcpMatch?.[1] !== undefined && request.method === "DELETE") {
      sendJson(response, 200, { removed: await mcp.remove(decodeURIComponent(mcpMatch[1])) });
      return;
    }
    const mcpActionMatch = url.pathname.match(/^\/v1\/mcp\/servers\/([^/]+)\/(reconnect|enable|disable)$/u);
    if (mcpActionMatch?.[1] !== undefined && mcpActionMatch[2] !== undefined && request.method === "POST") {
      const name = decodeURIComponent(mcpActionMatch[1]);
      const action = mcpActionMatch[2];
      const result = action === "reconnect" ? await mcp.reconnect(name) : await mcp.setEnabled(name, action === "enable");
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      serveIndex(response, webRoot);
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/web/")) {
      serveWebAsset(response, webRoot, url.pathname.slice("/web/".length));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/workspaces/validate") {
      const body = await readJson(request);
      if (typeof body.workspaceRoot !== "string" || body.workspaceRoot.trim().length === 0) throw new HttpError(400, "workspaceRoot is required");
      const requested = body.workspaceRoot.trim();
      try {
        const resolved = await realpath(requested);
        const info = await stat(resolved);
        if (!info.isDirectory()) throw new HttpError(400, "workspaceRoot must be a directory");
        sendJson(response, 200, { valid: true, workspaceRoot: resolved, name: path.basename(resolved), isGitRepository: existsSync(path.join(resolved, ".git")) });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "workspaceRoot directory does not exist or is not accessible");
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/sessions") {
      const body = await readJson(request);
      const workspaceRoot = typeof body.workspaceRoot === "string" && body.workspaceRoot.length > 0 ? body.workspaceRoot : process.cwd();
      const permissionPreset = body.permissionPreset === undefined ? undefined : parsePermissionPreset(body.permissionPreset);
      sendJson(response, 201, await host.createSession(workspaceRoot, permissionPreset));
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/sessions") {
      sendJson(response, 200, { sessions: await host.listSessions(url.searchParams.get("include_archived") === "true") });
      return;
    }
    const attachmentMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/attachments$/u);
    if (request.method === "POST" && attachmentMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(attachmentMatch[1]));
      const session = await host.getSession(id);
      if (session === undefined) throw new HttpError(404, "session not found");
      const body = await readJson(request);
      if (typeof body.fileName !== "string") throw new HttpError(400, "fileName is required");
      if (typeof body.mediaType !== "string") throw new HttpError(400, "mediaType is required");
      if (typeof body.data !== "string") throw new HttpError(400, "data is required");
      const idempotencyKey = commandId(request, body) ?? `attachment_${randomUUID()}`;
      let receipt;
      try {
        receipt = await stageAttachment(session, { fileName: body.fileName, mediaType: body.mediaType, data: body.data }, currentAttachmentCapability(attachmentPolicy, modelRuntime), idempotencyKey);
      } catch (error) {
        if (error instanceof AttachmentInputError) throw new HttpError(400, error.message);
        throw error;
      }
      sendJson(response, receipt.status === "accepted" ? 201 : 200, await host.recordAttachment(id, receipt, idempotencyKey));
      return;
    }
    const eventsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/u);
    if (request.method === "GET" && eventsMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(eventsMatch[1]));
      const after = parseSequence(url.searchParams.get("after_sequence") ?? request.headers["last-event-id"]);
      const before = parseOptionalSequence(url.searchParams.get("before_sequence"));
      const limit = parsePageLimit(url.searchParams.get("limit"));
      const session = await host.getSession(id);
      if (session === undefined) throw new HttpError(404, "session not found");
      if (url.searchParams.get("format") === "json") {
        if (before !== undefined || limit !== undefined) {
          sendJson(response, 200, await host.eventsPage(id, { afterSequence: after, ...(before === undefined ? {} : { beforeSequence: before }), ...(limit === undefined ? {} : { limit }) }));
        } else {
          sendJson(response, 200, await host.events(id, after));
        }
        return;
      }
      await streamEvents(request, response, host, id, after);
      return;
    }
    const artifactMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/artifacts\/([^/]+)(?:\/(content))?$/u);
    if (request.method === "GET" && artifactMatch?.[1] !== undefined && artifactMatch[2] !== undefined) {
      const id = sessionId(decodeURIComponent(artifactMatch[1]));
      const session = await host.getSession(id);
      if (session === undefined) throw new HttpError(404, "session not found");
      const access = await inspectArtifact(session, decodeURIComponent(artifactMatch[2]));
      if (access === undefined) throw new HttpError(404, "artifact not found");
      if (artifactMatch[3] === "content") {
        if (!isAvailableArtifact(access)) throw new HttpError(artifactFailureStatus(access), access.reason);
        serveArtifactContent(response, access, url.searchParams.get("download") === "true");
      } else {
        sendJson(response, 200, artifactAccessResponse(access));
      }
      return;
    }
    const scopedEventsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/subagents\/events$/u);
    if (request.method === "GET" && scopedEventsMatch?.[1] !== undefined) {
      const parentSessionId = sessionId(decodeURIComponent(scopedEventsMatch[1]));
      const after = parseSequence(url.searchParams.get("after_sequence") ?? request.headers["last-event-id"]);
      const parent = await host.getSession(parentSessionId);
      if (parent === undefined) throw new HttpError(404, "session not found");
      const children = await subagents.agentCatalog(parentSessionId, "descendants");
      const childSessionIds = children.flatMap((entry) => entry.task.childSessionId === undefined ? [] : [entry.task.childSessionId]);
      if (url.searchParams.get("format") === "json") {
        const events = await scopedEvents(host, parentSessionId, childSessionIds, after);
        sendJson(response, 200, events);
      } else {
        await streamScopedEvents(request, response, host, parentSessionId, childSessionIds, after);
      }
      return;
    }
    const modeMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/mode$/u);
    if (request.method === "POST" && modeMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(modeMatch[1]));
      const body = await readJson(request);
      sendJson(response, 200, await host.setSessionPermissionPreset(id, parsePermissionPreset(body.permissionPreset)));
      return;
    }
    const titleMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/title$/u);
    if (request.method === "POST" && titleMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(titleMatch[1]));
      const body = await readJson(request);
      if (typeof body.title !== "string") throw new HttpError(400, "title is required");
      sendJson(response, 200, await host.renameSession(id, body.title, commandId(request, body)));
      return;
    }
    const goalMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/goals\/([^/]+)$/u);
    if (request.method === "POST" && goalMatch?.[1] !== undefined && goalMatch[2] !== undefined) {
      const id = sessionId(decodeURIComponent(goalMatch[1]));
      const body = await readJson(request);
      const input = {
        ...(body.status === undefined ? {} : { status: parseGoalStatus(body.status) }),
        ...(body.title === undefined ? {} : { title: requireString(body.title, "title") }),
        ...(body.successCriteria === undefined ? {} : { successCriteria: requireStringArray(body.successCriteria, "successCriteria") }),
        ...(body.budget === undefined ? {} : { budget: requireRecord(body.budget, "budget") }),
        ...(Object.prototype.hasOwnProperty.call(body, "result") ? { result: body.result } : {}),
        ...(body.reason === undefined ? {} : { reason: requireString(body.reason, "reason") }),
      };
      sendJson(response, 200, await host.updateGoal(id, decodeURIComponent(goalMatch[2]), input, optionalSequence(body.expectedSequence), commandId(request, body)));
      return;
    }
    const planMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/plan$/u);
    if (request.method === "POST" && planMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(planMatch[1]));
      const body = await readJson(request);
      sendJson(response, 200, await host.updatePlan(id, requireString(body.content, "content"), parsePlanStatus(body.status), optionalSequence(body.expectedSequence), commandId(request, body)));
      return;
    }
    const todoMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/todos$/u);
    if (request.method === "POST" && todoMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(todoMatch[1]));
      const body = await readJson(request);
      sendJson(response, 200, await host.updateTodos(id, parseTodoItems(body.todos), optionalSequence(body.expectedSequence), commandId(request, body)));
      return;
    }
    const worktreesMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/worktrees$/u);
    if (worktreesMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(worktreesMatch[1]));
      if (request.method === "GET") {
        sendJson(response, 200, { worktrees: await host.listWorktrees(id) });
        return;
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        sendJson(response, 201, await host.createWorktree(id, {
          ...(body.id === undefined ? {} : { id: requireString(body.id, "id") }),
          ...(body.path === undefined ? {} : { path: requireString(body.path, "path") }),
          ...(body.branch === undefined ? {} : { branch: requireString(body.branch, "branch") }),
          ...(body.taskId === undefined ? {} : { taskId: requireString(body.taskId, "taskId") }),
        }, commandId(request, body)));
        return;
      }
    }
    const worktreeActionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/worktrees\/([^/]+)\/(attach|switch|cleanup)$/u);
    if (request.method === "POST" && worktreeActionMatch?.[1] !== undefined && worktreeActionMatch[2] !== undefined && worktreeActionMatch[3] !== undefined) {
      const id = sessionId(decodeURIComponent(worktreeActionMatch[1]));
      const worktreeId = decodeURIComponent(worktreeActionMatch[2]);
      const body = await readJson(request);
      if (worktreeActionMatch[3] === "attach") sendJson(response, 200, await host.attachWorktree(id, worktreeId, commandId(request, body)));
      else if (worktreeActionMatch[3] === "switch") sendJson(response, 200, await host.switchWorktree(id, worktreeId, commandId(request, body)));
      else sendJson(response, 200, await host.cleanupWorktree(id, worktreeId, body.force === true, commandId(request, body)));
      return;
    }
    const archiveMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/archive$/u);
    if (request.method === "POST" && archiveMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(archiveMatch[1]));
      const body = await readJson(request);
      const archived = body.archived === undefined ? true : body.archived;
      if (typeof archived !== "boolean") throw new HttpError(400, "archived must be a boolean");
      sendJson(response, 200, await host.archiveSession(id, archived));
      return;
    }
    const restoreMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/restore$/u);
    if (request.method === "POST" && restoreMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(restoreMatch[1]));
      sendJson(response, 200, await host.archiveSession(id, false));
      return;
    }
    const resumeMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/resume$/u);
    if (request.method === "POST" && resumeMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(resumeMatch[1]));
      const body = await readJson(request);
      sendJson(response, 200, await host.resumeSession(id, commandId(request, body)));
      return;
    }
    const permissionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/permissions\/([^/]+)$/u);
    if (request.method === "POST" && permissionMatch?.[1] !== undefined && permissionMatch[2] !== undefined) {
      const id = sessionId(decodeURIComponent(permissionMatch[1]));
      const body = await readJson(request);
      const status = body.status;
      if (status !== "approved" && status !== "denied" && status !== "cancelled") throw new HttpError(400, "status must be approved, denied, or cancelled");
      sendJson(response, 200, await host.resolvePermission(id, brand<string, "PermissionId">(decodeURIComponent(permissionMatch[2])), status, commandId(request, body)));
      return;
    }
    const interactionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/interactions\/([^/]+)$/u);
    if (request.method === "POST" && interactionMatch?.[1] !== undefined && interactionMatch[2] !== undefined) {
      const id = sessionId(decodeURIComponent(interactionMatch[1]));
      const body = await readJson(request);
      const status = body.status ?? "answered";
      if (status !== "answered" && status !== "cancelled") throw new HttpError(400, "status must be answered or cancelled");
      if (status === "answered" && typeof body.answer !== "string") throw new HttpError(400, "answer is required when status is answered");
      sendJson(response, 200, await host.resolveInteraction(id, brand<string, "InteractionId">(decodeURIComponent(interactionMatch[2])), status, typeof body.answer === "string" ? body.answer : undefined, commandId(request, body)));
      return;
    }
    const cancelToolMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/tools\/([^/]+)\/cancel$/u);
    if (request.method === "POST" && cancelToolMatch?.[1] !== undefined && cancelToolMatch[2] !== undefined) {
      const id = sessionId(decodeURIComponent(cancelToolMatch[1]));
      const body = await readJson(request);
      const toolCallId = brand<string, "ToolCallId">(decodeURIComponent(cancelToolMatch[2]));
      sendJson(response, 200, { cancelled: await host.cancelTool(id, toolCallId, commandId(request, body)) });
      return;
    }
    const forkMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/fork$/u);
    if (request.method === "POST" && forkMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(forkMatch[1]));
      const body = await readJson(request);
      const workspaceRoot = typeof body.workspaceRoot === "string" ? body.workspaceRoot : undefined;
      sendJson(response, 201, { sessionId: await host.forkSession(id, workspaceRoot, commandId(request, body)) });
      return;
    }
    const subagentsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/subagents$/u);
    if (subagentsMatch?.[1] !== undefined) {
      const parentSessionId = sessionId(decodeURIComponent(subagentsMatch[1]));
      if (request.method === "GET") {
        const scope = url.searchParams.get("scope") === "descendants" ? "descendants" : "children";
        sendJson(response, 200, { agents: await subagents.agentCatalog(parentSessionId, scope) });
        return;
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        const parent = await host.getSession(parentSessionId);
        if (parent === undefined) throw new HttpError(404, "session not found");
        if (typeof body.prompt !== "string") throw new HttpError(400, "prompt is required");
        const permissionPreset = body.permissionPreset === undefined ? parent.permissionPreset : parsePermissionPreset(body.permissionPreset);
        const receipt = await subagents.spawn({
          parentSessionId,
          prompt: body.prompt,
          workspaceRoot: typeof body.workspaceRoot === "string" ? body.workspaceRoot : parent.workspaceRoot,
          permissionPreset,
          ...(body.mode === "one-shot" || body.mode === "continuable" ? { mode: body.mode } : {}),
          ...(typeof body.background === "boolean" ? { background: body.background } : {}),
          ...(typeof body.label === "string" ? { label: body.label } : {}),
          ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
          ...(Array.isArray(body.toolAllowlist) ? { toolAllowlist: body.toolAllowlist as string[] } : {}),
          ...(Array.isArray(body.mcpAllowlist) ? { mcpAllowlist: body.mcpAllowlist as string[] } : {}),
          ...(typeof body.model === "string" ? { model: body.model } : {}),
          ...(typeof body.delegationDepth === "number" ? { delegationDepth: body.delegationDepth } : {}),
          ...(typeof body.commandId === "string" ? { commandId: body.commandId } : {}),
        });
        sendJson(response, receipt.report === undefined ? 202 : 200, receipt);
        return;
      }
    }
    const subagentActionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/subagents\/([^/]+)\/(prompt|interrupt)$/u);
    if (subagentActionMatch?.[1] !== undefined && subagentActionMatch[2] !== undefined && subagentActionMatch[3] !== undefined && request.method === "POST") {
      const parentSessionId = sessionId(decodeURIComponent(subagentActionMatch[1]));
      const taskId = brand<string, "TaskId">(decodeURIComponent(subagentActionMatch[2]));
      const body = await readJson(request);
      if (subagentActionMatch[3] === "prompt") {
        if (typeof body.prompt !== "string") throw new HttpError(400, "prompt is required");
        sendJson(response, 202, await subagents.sendMessage(parentSessionId, taskId, body.prompt));
      } else {
        sendJson(response, 202, await subagents.interrupt(parentSessionId, taskId));
      }
      return;
    }
    const subagentHistoryMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/subagents\/([^/]+)$/u);
    if (subagentHistoryMatch?.[1] !== undefined && subagentHistoryMatch[2] !== undefined && request.method === "GET") {
      const parentSessionId = sessionId(decodeURIComponent(subagentHistoryMatch[1]));
      const taskId = brand<string, "TaskId">(decodeURIComponent(subagentHistoryMatch[2]));
      const output = await subagents.taskOutput(parentSessionId, taskId);
      if (output === undefined) throw new HttpError(404, "task not found");
      sendJson(response, 200, output);
      return;
    }
    const taskMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/tasks\/([^/]+)(?:\/(output|cancel))?$/u);
    if (taskMatch?.[1] !== undefined && taskMatch[2] !== undefined) {
      const parentSessionId = sessionId(decodeURIComponent(taskMatch[1]));
      const taskId = brand<string, "TaskId">(decodeURIComponent(taskMatch[2]));
      if (request.method === "GET" && taskMatch[3] === undefined) {
        const task = await subagents.taskQuery(parentSessionId, taskId);
        if (task === undefined) throw new HttpError(404, "task not found");
        sendJson(response, 200, task);
        return;
      }
      if (request.method === "GET" && taskMatch[3] === "output") {
        const output = await subagents.taskOutput(parentSessionId, taskId);
        if (output === undefined) throw new HttpError(404, "task not found");
        sendJson(response, 200, output);
        return;
      }
      if (request.method === "POST" && taskMatch[3] === "cancel") {
        const body = await readJson(request);
        sendJson(response, 200, await subagents.cancel(parentSessionId, taskId, commandId(request, body)));
        return;
      }
    }
    const cancelMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/cancel$/u);
    if (request.method === "POST" && cancelMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(cancelMatch[1]));
      const body = await readJson(request);
      const rawTurnId = body.turnId;
      if (typeof rawTurnId !== "string") throw new HttpError(400, "turnId is required");
      sendJson(response, 200, { cancelled: await host.cancelTurn(id, turnId(rawTurnId), commandId(request, body)) });
      return;
    }
    const queueMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/queue$/u);
    if (request.method === "POST" && queueMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(queueMatch[1]));
      const body = await readJson(request);
      if (typeof body.turnId !== "string") throw new HttpError(400, "turnId is required");
      if (typeof body.position !== "number" || !Number.isFinite(body.position)) throw new HttpError(400, "position is required");
      sendJson(response, 200, await host.reorderQueue(id, turnId(body.turnId), body.position, commandId(request, body)));
      return;
    }
    const steerMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/turns\/([^/]+)\/steer$/u);
    if (request.method === "POST" && steerMatch?.[1] !== undefined && steerMatch[2] !== undefined) {
      const id = sessionId(decodeURIComponent(steerMatch[1]));
      const targetTurn = turnId(decodeURIComponent(steerMatch[2]));
      const body = await readJson(request);
      if (typeof body.content !== "string") throw new HttpError(400, "content is required");
      sendJson(response, 200, await host.steerTurn(id, targetTurn, body.content, commandId(request, body)));
      return;
    }
    const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/u);
    if (sessionMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(sessionMatch[1]));
      if (request.method === "DELETE") {
        const deleted = await host.deleteSession(id);
        sendJson(response, 200, { deleted: true, sessionId: deleted.id });
        return;
      }
      if (request.method === "POST") {
        const body = await readJson(request);
        const content = body.content;
        if (typeof content !== "string") throw new HttpError(400, "content is required");
        sendJson(response, 202, { turnId: await host.sendMessage(id, content, commandId(request, body)) });
        return;
      }
      if (request.method === "GET") {
        const projection = await host.getSession(id);
        if (projection === undefined) throw new HttpError(404, "session not found");
        sendJson(response, 200, projection);
        return;
      }
    }
    const toolsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/tools$/u);
    if (request.method === "POST" && toolsMatch?.[1] !== undefined) {
      const id = sessionId(decodeURIComponent(toolsMatch[1]));
      const body = await readJson(request);
      if (typeof body.name !== "string") throw new HttpError(400, "name is required");
      const result = await host.executeTool(id, body.name, body.input, typeof body.turnId === "string" ? turnId(body.turnId) : undefined, commandId(request, body));
      sendJson(response, result.status === "awaiting_permission" ? 202 : 200, result);
      return;
    }
    throw new HttpError(404, "not found");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
    const status = error instanceof HttpError ? error.status : code === "INVALID_TOOL_INPUT" ? 400 : code === "TOOL_NOT_FOUND" ? 404 : code === "TOOL_DISABLED" ? 409 : code === "MODEL_CONFIGURATION_ERROR" ? 400 : code === "COMMAND_CONFLICT" || code === "WORKTREE_DIRTY" || code === "WORKTREE_INVALID" || code === "WORKTREE_EXISTS" ? 409 : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (!response.headersSent) sendJson(response, status, { error: message });
    else response.end();
  }
}

async function streamEvents(request: IncomingMessage, response: ServerResponse, host: AgentHost, id: ReturnType<typeof sessionId>, after: number): Promise<void> {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
  response.write(": connected\n\n");
  let replaying = true;
  let buffered: AgentEvent[] = [];
  let lastSent = after;
  const unsubscribe = host.subscribe(id, (event) => {
    if (replaying) buffered.push(event);
    else if (event.sequence > lastSent) {
      writeEvent(response, event);
      lastSent = event.sequence;
    }
  });
  const close = () => unsubscribe();
  request.on("close", close);
  try {
    const historical = await host.events(id, after);
    for (const event of historical) {
      if (event.sequence > lastSent) {
        writeEvent(response, event);
        lastSent = event.sequence;
      }
    }
    replaying = false;
    for (const event of buffered.sort((left, right) => left.sequence - right.sequence)) {
      if (event.sequence > lastSent) {
        writeEvent(response, event);
        lastSent = event.sequence;
      }
    }
    buffered = [];
  } catch (error) {
    unsubscribe();
    throw error;
  }
}

async function scopedEvents(host: AgentHost, parentSessionId: ReturnType<typeof sessionId>, childSessionIds: readonly ReturnType<typeof sessionId>[], after: number): Promise<readonly { readonly sessionId: string; readonly event: AgentEvent }[]> {
  const ids = [parentSessionId, ...childSessionIds];
  const items: { readonly sessionId: string; readonly event: AgentEvent }[] = [];
  for (const id of ids) for (const event of await host.events(id, after)) items.push({ sessionId: id, event });
  return items.sort((left, right) => left.event.createdAt.localeCompare(right.event.createdAt) || left.event.sequence - right.event.sequence);
}

async function streamScopedEvents(request: IncomingMessage, response: ServerResponse, host: AgentHost, parentSessionId: ReturnType<typeof sessionId>, childSessionIds: readonly ReturnType<typeof sessionId>[], after: number): Promise<void> {
  response.writeHead(200, { "cache-control": "no-cache", connection: "keep-alive", "content-type": "text/event-stream; charset=utf-8" });
  response.write(": connected\n\n");
  const ids = [parentSessionId, ...childSessionIds];
  const seen = new Set<string>();
  let replaying = true;
  const buffered: { readonly sessionId: string; readonly event: AgentEvent }[] = [];
  const unsubscribe = ids.map((id) => host.subscribe(id, (event) => {
    const key = `${id}:${event.sequence}`;
    if (seen.has(key)) return;
    if (replaying) buffered.push({ sessionId: id, event });
    else { seen.add(key); writeScopedEvent(response, id, event); }
  }));
  const close = () => unsubscribe.forEach((dispose) => dispose());
  request.on("close", close);
  const historical = await scopedEvents(host, parentSessionId, childSessionIds, after);
  for (const item of historical) {
    const key = `${item.sessionId}:${item.event.sequence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    writeScopedEvent(response, item.sessionId, item.event);
  }
  replaying = false;
  for (const item of buffered.sort((left, right) => left.event.createdAt.localeCompare(right.event.createdAt))) {
    const key = `${item.sessionId}:${item.event.sequence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    writeScopedEvent(response, item.sessionId, item.event);
  }
}

function commandId(request: IncomingMessage, body: Record<string, unknown> = {}): string | undefined {
  const header = request.headers["idempotency-key"];
  if (typeof header === "string" && header.length > 0) return header;
  return typeof body.commandId === "string" && body.commandId.length > 0 ? body.commandId : undefined;
}

function serveIndex(response: ServerResponse, webRoot: string): void {
  const file = path.join(webRoot, "index.html");
  if (!existsSync(file)) throw new HttpError(404, "web shell not found");
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  createReadStream(file).pipe(response);
}

function serveWebAsset(response: ServerResponse, webRoot: string, requestedPath: string): void {
  const assetRoot = path.resolve(webRoot, "dist");
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestedPath);
  } catch {
    throw new HttpError(400, "invalid web asset encoding");
  }
  const file = path.resolve(assetRoot, decodedPath);
  const relative = path.relative(assetRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new HttpError(403, "invalid web asset path");
  if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "web asset not found");
  const extension = path.extname(file).toLowerCase();
  const contentType = extension === ".js" ? "text/javascript; charset=utf-8"
    : extension === ".map" ? "application/json; charset=utf-8"
      : extension === ".css" ? "text/css; charset=utf-8"
        : "application/octet-stream";
  response.writeHead(200, { "cache-control": "no-cache", "content-type": contentType });
  createReadStream(file).pipe(response);
}

function serveArtifactContent(response: ServerResponse, access: Extract<ArtifactAccess, { availability: "available" }>, download: boolean): void {
  const disposition = download ? "attachment" : "inline";
  const filename = encodeURIComponent(access.fileName);
  const asciiFilename = access.fileName.replace(/[^\x20-\x7E]/gu, "_");
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-disposition": `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${filename}`,
    "content-length": String(access.sizeBytes),
    "content-type": access.contentType,
    "x-content-type-options": "nosniff",
  });
  const stream = createReadStream(access.filePath);
  stream.on("error", () => { if (!response.destroyed) response.destroy(); });
  stream.pipe(response);
}

function artifactFailureStatus(access: ArtifactAccess): number {
  switch (access.availability) {
    case "blocked": return 403;
    case "missing": return 404;
    case "too_large": return 413;
    case "external":
    case "not_file":
    case "unavailable": return 409;
    case "available": return 200;
  }
}

function writeEvent(response: ServerResponse, event: { sequence: number; type: string; payload: unknown }): void {
  if (response.destroyed) return;
  response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function writeScopedEvent(response: ServerResponse, sessionId: string, event: AgentEvent): void {
  if (response.destroyed) return;
  response.write(`id: ${sessionId}:${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ sessionId, event })}\n\n`);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const content = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(content) });
  response.end(content);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).byteLength > 1_048_576) throw new HttpError(413, "request body too large");
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "JSON object required");
  return value as Record<string, unknown>;
}

function parseSequence(value: string | string[] | null | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === null || raw === undefined || raw === "") return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseOptionalSequence(value: string | string[] | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parsePageLimit(value: string | string[] | null | undefined): number | undefined {
  const parsed = parseOptionalSequence(value);
  return parsed === undefined ? undefined : Math.min(1_000, Math.max(1, parsed));
}

function parsePermissionPreset(value: unknown): PermissionPreset {
  if (value === "read-only" || value === "workspace-write" || value === "ask-on-write" || value === "ask-on-execute" || value === "danger-full-access") return value;
  throw new HttpError(400, "permissionPreset must be read-only, workspace-write, ask-on-write, ask-on-execute, or danger-full-access");
}

function parseGoalStatus(value: unknown): GoalStatus {
  if (value === "active" || value === "paused" || value === "completed" || value === "blocked" || value === "cancelled") return value;
  throw new HttpError(400, "goal status must be active, paused, completed, blocked, or cancelled");
}

function parsePlanStatus(value: unknown): PlanStatus {
  if (value === "draft" || value === "active" || value === "approved" || value === "rejected" || value === "cleared") return value;
  throw new HttpError(400, "plan status must be draft, active, approved, rejected, or cleared");
}

function optionalSequence(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new HttpError(400, "expectedSequence must be a non-negative integer");
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  return value;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new HttpError(400, `${field} must be an array of strings`);
  return value as string[];
}

function requireRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, `${field} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

function parseTodoItems(value: unknown): readonly TodoItem[] {
  if (!Array.isArray(value)) throw new HttpError(400, "todos must be an array");
  return value.map((item): TodoItem => {
    if (typeof item !== "object" || item === null) throw new HttpError(400, "todo items must be objects");
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.content !== "string") throw new HttpError(400, "todo id and content are required");
    if (record.status !== "pending" && record.status !== "in_progress" && record.status !== "completed" && record.status !== "cancelled") throw new HttpError(400, "invalid todo status");
    return { id: record.id, content: record.content, status: record.status, ...(typeof record.activeForm === "string" ? { activeForm: record.activeForm } : {}) };
  });
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env["PORT"] ?? "3210", 10);
  createConfiguredApiServer().listen(port, "127.0.0.1", () => {
    console.log(`Code Review Agent API listening on http://127.0.0.1:${port}`);
  });
}
