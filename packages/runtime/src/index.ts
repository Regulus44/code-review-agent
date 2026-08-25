import {
  brand,
  type AgentEvent,
  type AttachmentReceipt,
  type ChatMessage,
  type ChatModel,
  type ModelUsage,
  type ModelToolCall,
  type ModelToolDefinition,
  type SessionEventStore,
  type SessionId,
  type SessionProjection,
  type SessionSummary,
  type WorkspaceCatalog,
  type WorkspaceSummary,
  type TurnId,
  type InteractionId,
  type PermissionId,
  type PermissionRequest,
  type ToolCaller,
  type ToolCallId,
  type ToolResult,
  type UserInteractionAnswer,
  type UserInteractionRequest,
  type ChildSessionMetadata,
  type EventListOptions,
  type EventPage,
  type GoalStatus,
  type PlanStatus,
  type TodoItem,
  type WorktreeProjection,
  type ProductizationCapability,
  type SessionOwnership,
  type ModelRouteRecord,
  type ContextBudgetSnapshot,
  type ContextWarningState,
  type ModelContextCapability,
} from "@code-review-agent/contracts";
import { EchoChatModel } from "@code-review-agent/llm";
import { compactMessages, DEFAULT_CONTEXT_BUDGET, type ContextBudget } from "@code-review-agent/compaction";
import { calculateContextWarningState, countContextTokens, createTokenCounter, estimateContextTokens, fallbackModelContextCapability, resolveContextBudget, shouldCompactBeforeRequest, shouldUseExactTokenCount, type ContextBudgetConfig, type ModelContextView, type TokenCount } from "@code-review-agent/context";
import { randomUUID } from "node:crypto";
import { BUILTIN_TOOL_PROMPT_SPECS, createBuiltinTools, createSubagentTools, DefaultPermissionPolicy, JobManager, TerminalManager, ToolPromptRegistry, ToolRegistry, ToolRuntime, type CapabilityRegistry, type CodeModePolicySnapshot, type CodeModeSandbox, type ExecuteToolOutput, type JobSummary, type LspServerConfig, type PermissionPreset } from "@code-review-agent/tools";
import type { SubagentRuntime } from "@code-review-agent/subagent";
import { GitWorktreeManager } from "@code-review-agent/workspace";
import { buildAgentSystemPrompt } from "./system-prompt.js";

export interface AgentHostOptions {
  readonly store: SessionEventStore;
  readonly model?: ChatModel;
  /** Provider-owned reasoning level applied to future turns when supplied. */
  readonly reasoningEffort?: string;
  readonly fallbackModels?: readonly ChatModel[];
  readonly systemPrompt?: string;
  readonly maxSteps?: number;
  readonly toolRuntime?: ToolRuntime;
  readonly toolRegistry?: ToolRegistry;
  readonly permissionPreset?: PermissionPreset;
  readonly toolPromptRegistry?: ToolPromptRegistry;
  readonly visionEnabled?: boolean;
  readonly lspServers?: Readonly<Record<string, LspServerConfig>>;
  readonly codeMode?: CodeModeSandbox;
  readonly capabilities?: CapabilityRegistry;
  readonly subagentRuntime?: SubagentRuntime;
  readonly compactionEnabled?: boolean;
  readonly contextBudget?: Partial<ContextBudget>;
  /** Claude Code-style model window and threshold policy. */
  readonly contextPolicy?: Partial<ContextBudgetConfig>;
  readonly quota?: ProductizationQuotaPolicy;
  readonly operations?: ProductizationOperationsPolicy;
}

export interface ProductizationQuotaPolicy {
  readonly maxSessionsPerTenant?: number;
  readonly maxTurnsPerTenant?: number;
}

export interface ProductizationOperationsPolicy {
  readonly backup: "deferred" | "available";
  readonly migration: "deferred" | "available";
  readonly upgrade: "deferred" | "available";
}

export interface ContextSettings {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly budget?: Partial<ContextBudget>;
  readonly capability?: ModelContextCapability;
  readonly budgetSnapshot?: ContextBudgetSnapshot;
}

export interface CodeModeSettings {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly limits?: CodeModePolicySnapshot;
}

export interface LspSettings {
  readonly configured: boolean;
  readonly servers: readonly string[];
}

export interface PluginsSettings {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly status: "available" | "deferred" | "unavailable";
  readonly reason: string;
}

export type ProductizationSettings = ProductizationCapability;

export interface RuntimeMetricsSnapshot {
  readonly turnsStarted: number;
  readonly turnsCompleted: number;
  readonly turnsFailed: number;
  readonly turnsStopped: number;
  readonly modelFallbacks: number;
  readonly toolCalls: number;
  readonly toolFailures: number;
}

interface PendingTurn {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly content: string;
  readonly reasoningEffort?: string;
  readonly previousMessages: readonly ChatMessage[];
}

interface WorkspaceMetadata {
  readonly updatedAt: string;
  readonly label?: string;
  readonly archived?: boolean;
  readonly deleted?: boolean;
}

interface PendingPermissionWaiter {
  readonly resolve: (output: ExecuteToolOutput) => void;
  readonly reject: (error: unknown) => void;
}

interface RecoveredTurn {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly permissionIds: Set<PermissionId>;
  readonly interactionIds: Set<InteractionId>;
}

interface CollectedModelResponse {
  readonly text: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly usage?: ModelUsage;
}

export type TenantModelRoute = Pick<ModelRouteRecord, "provider" | "model" | "baseUrl" | "credentialRef" | "contextCapability">;

/** Coordinates durable sessions, queued turns and model execution behind storage/model interfaces. */
export class AgentHost {
  private model: ChatModel;
  private readonly fallbackModels: readonly ChatModel[];
  private readonly customSystemPrompt: string | undefined;
  private readonly permissionPreset: PermissionPreset | undefined;
  private reasoningEffort: string | undefined;
  private readonly controllers = new Map<TurnId, AbortController>();
  private readonly activeTurns = new Map<SessionId, TurnId>();
  private readonly queues = new Map<SessionId, PendingTurn[]>();
  private readonly queueChangeTails = new Map<SessionId, Promise<void>>();
  private readonly steerQueues = new Map<TurnId, string[]>();
  private readonly permissionWaiters = new Map<PermissionId, PendingPermissionWaiter>();
  private readonly recoveredTurns = new Map<TurnId, RecoveredTurn>();
  private readonly recoveredPermissionIndex = new Map<PermissionId, TurnId>();
  private readonly recoveredInteractionIndex = new Map<InteractionId, TurnId>();
  private readonly turnTraces = new Map<TurnId, string>();
  private readonly maxSteps: number;
  private readonly ready: Promise<void>;
  private readonly toolRuntime: ToolRuntime;
  private readonly terminalManager?: TerminalManager;
  private readonly jobManager?: JobManager;
  private readonly toolPromptRegistry: ToolPromptRegistry;
  private readonly compactionEnabled: boolean;
  private readonly contextBudget: Partial<ContextBudget> | undefined;
  private readonly contextPolicy: Partial<ContextBudgetConfig> | undefined;
  private readonly quota: ProductizationQuotaPolicy | undefined;
  private readonly operations: ProductizationOperationsPolicy;
  private readonly quotaTails = new Map<string, Promise<void>>();
  private readonly worktreeOperations = new Map<SessionId, Promise<void>>();
  private readonly metricCounters = { turnsStarted: 0, turnsCompleted: 0, turnsFailed: 0, turnsStopped: 0, modelFallbacks: 0, toolCalls: 0, toolFailures: 0 };
  private readonly tenantModels = new Map<string, ChatModel>();
  private readonly tenantModelRoutes = new Map<string, TenantModelRoute>();

  constructor(private readonly options: AgentHostOptions) {
    this.model = options.model ?? new EchoChatModel();
    this.reasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
    this.fallbackModels = options.fallbackModels ?? [];
    this.compactionEnabled = options.compactionEnabled !== false;
    this.contextBudget = options.contextBudget;
    this.contextPolicy = options.contextPolicy;
    this.quota = options.quota;
    this.operations = options.operations ?? { backup: "deferred", migration: "deferred", upgrade: "deferred" };
    this.customSystemPrompt = options.systemPrompt;
    this.maxSteps = options.maxSteps ?? 12;
    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1 || this.maxSteps > 100) throw new Error("maxSteps must be an integer between 1 and 100");
    const registry = options.toolRegistry ?? new ToolRegistry();
    this.toolPromptRegistry = options.toolPromptRegistry ?? new ToolPromptRegistry();
    if (options.toolPromptRegistry === undefined) this.toolPromptRegistry.registerMany(BUILTIN_TOOL_PROMPT_SPECS);
    if (options.toolRuntime === undefined) {
      this.terminalManager = new TerminalManager();
      this.jobManager = new JobManager({ eventStore: options.store });
      if (options.toolRegistry === undefined) registry.registerMany(createBuiltinTools({ terminalManager: this.terminalManager, jobManager: this.jobManager, eventStore: options.store, ...(options.visionEnabled === undefined ? {} : { visionEnabled: options.visionEnabled }), ...(options.lspServers === undefined ? {} : { lspServers: options.lspServers }), ...(options.codeMode === undefined ? {} : { codeMode: options.codeMode }), ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }) }));
      this.permissionPreset = options.permissionPreset ?? "ask-on-write";
    } else {
      this.permissionPreset = options.permissionPreset;
    }
    if (options.subagentRuntime !== undefined) registry.registerMany(createSubagentTools({ runtime: options.subagentRuntime }).filter((tool) => !registry.has(tool.name)));
    this.toolRuntime = options.toolRuntime ?? new ToolRuntime({ store: options.store, registry, ...(this.terminalManager === undefined ? {} : { terminalManager: this.terminalManager }), ...(options.permissionPreset === undefined ? {} : { policy: new DefaultPermissionPolicy({ preset: options.permissionPreset }) }) });
    this.ready = this.restoreQueuedTurns();
  }

  /** Replaces the model used for turns that have not started yet. */
  setModel(model: ChatModel): void {
    this.model = model;
  }

  /** Sets the default reasoning level for future turns; active turns keep their recorded value. */
  setReasoningEffort(effort: string | undefined): void {
    this.reasoningEffort = normalizeReasoningEffort(effort);
  }

  currentReasoningEffort(): string | undefined {
    return this.reasoningEffort;
  }

  /** Selects a host-created model for one tenant without changing other tenants or legacy local sessions. */
  setTenantModel(tenantId: string, model: ChatModel, route?: TenantModelRoute): void {
    if (tenantId.trim() === "") throw new Error("tenantId is required for tenant model routing");
    if (route !== undefined && (route.provider.trim() === "" || route.model.trim() === "")) throw new Error("tenant model route provider and model are required");
    this.tenantModels.set(tenantId, model);
    this.tenantModelRoutes.set(tenantId, route ?? { provider: "custom", model: "custom" });
  }

  clearTenantModel(tenantId: string): void {
    this.tenantModels.delete(tenantId);
    this.tenantModelRoutes.delete(tenantId);
  }

  contextSettings(tenantId?: string): ContextSettings {
    const snapshot = this.contextBudgetSnapshot(tenantId);
    return {
      enabled: this.compactionEnabled,
      configured: this.contextBudget !== undefined || this.contextPolicy !== undefined || snapshot.source !== "estimate",
      ...(this.contextBudget === undefined ? {} : { budget: { ...this.contextBudget } }),
      capability: snapshot.capability,
      budgetSnapshot: snapshot,
    };
  }

  /** Returns the current model's resolved M01 budget for diagnostics and API consumers. */
  contextBudgetSnapshot(tenantId?: string): ContextBudgetSnapshot {
    const capability = this.modelContextCapability(tenantId);
    return resolveContextBudget(capability, this.contextPolicyWithLegacyFallback());
  }

  private contextPolicyWithLegacyFallback(): ContextBudgetConfig {
    try {
      return {
        ...(this.contextPolicy ?? {}),
        ...(this.contextPolicy?.contextWindowTokens !== undefined || this.contextBudget?.maxTokens === undefined
          ? {}
          : { contextWindowTokens: this.contextBudget.maxTokens }),
        ...(this.contextPolicy?.maxOutputTokens === undefined ? {} : { maxOutputTokens: this.contextPolicy.maxOutputTokens }),
      };
    } catch {
      // Keep the request alive so compactTurnContext can record the exact
      // configuration failure as context/compaction_failed.
      return { ...(this.contextPolicy ?? {}) };
    }
  }

  private modelContextCapability(tenantId?: string): ModelContextCapability {
    const tenantModel = tenantId === undefined ? undefined : this.tenantModels.get(tenantId);
    if (tenantModel?.contextCapability !== undefined) return tenantModel.contextCapability;
    const route = tenantId === undefined ? undefined : this.tenantModelRoutes.get(tenantId);
    if (route?.contextCapability !== undefined) return route.contextCapability;
    if (tenantId === undefined && this.model.contextCapability !== undefined) return this.model.contextCapability;
    return fallbackModelContextCapability(
      "unknown",
      "unknown",
      this.contextPolicyWithLegacyFallback(),
    );
  }

  private modelForTenant(tenantId?: string): ChatModel {
    return tenantId === undefined ? this.model : this.tenantModels.get(tenantId) ?? this.model;
  }

  codeModeSettings(): CodeModeSettings {
    const snapshot = this.options.codeMode?.snapshot();
    return {
      configured: snapshot !== undefined,
      enabled: snapshot?.enabled === true,
      ...(snapshot === undefined ? {} : { limits: snapshot }),
    };
  }

  lspSettings(): LspSettings {
    return { configured: Object.keys(this.options.lspServers ?? {}).length > 0, servers: Object.keys(this.options.lspServers ?? {}).sort() };
  }

  pluginsSettings(): PluginsSettings {
    return {
      configured: false,
      enabled: false,
      status: "deferred",
      reason: "Plugin runtime is deferred until a Phase 8.5 productization requirement is accepted.",
    };
  }

  /**
   * Reports the productization boundary exposed by this host. The default
   * local runtime intentionally keeps remote auth, tenant isolation and quota
   * disabled until their durable contracts and recovery gates are accepted.
   */
  productizationSettings(tenantId?: string): ProductizationSettings {
    const quotaConfigured = this.quota?.maxSessionsPerTenant !== undefined || this.quota?.maxTurnsPerTenant !== undefined;
    const tenantRoute = tenantId === undefined ? undefined : this.tenantModelRoutes.get(tenantId);
    const tenantProviders = tenantId === undefined
      ? new Set([...this.tenantModelRoutes.values()].map((route) => route.provider))
      : tenantRoute === undefined ? new Set<string>() : new Set([tenantRoute.provider]);
    const routingConfigured = tenantId === undefined ? tenantProviders.size > 0 : tenantRoute !== undefined;
    return {
      version: 1,
      enabled: false,
      status: "deferred",
      reason: "Remote auth, tenant isolation and quota enforcement are deferred until the Phase 8.5 productization contract is implemented.",
      auth: { status: "deferred", mode: "disabled", required: false },
      multiUser: { status: "deferred", principalCatalog: "disabled" },
      tenantIsolation: { status: "deferred", sessionOwnership: "disabled" },
      quota: quotaConfigured ? { status: "configured", enforcement: "hard" } : { status: "disabled", enforcement: "disabled" },
      routing: { status: routingConfigured ? "configured" : "available", providerCount: Math.max(1, tenantProviders.size || this.fallbackModels.length + 1), modelSelector: routingConfigured ? "tenant-scoped" : "host-local" },
      credentials: { status: "configured", secretStore: "host-only", redaction: "required" },
      operations: {
        status: this.operations.backup === "available" || this.operations.migration === "available" || this.operations.upgrade === "available" ? "configured" : "deferred",
        ...this.operations,
      },
    };
  }

  async createSession(workspaceRoot: string, permissionPreset?: PermissionPreset, metadata?: ChildSessionMetadata, ownership?: SessionOwnership): Promise<SessionProjection> {
    await this.ready;
    const preset = permissionPreset ?? this.permissionPreset ?? "ask-on-write";
    const effectiveOwnership = ownership ?? metadata?.ownership;
    return this.withQuotaLock(effectiveOwnership?.tenantId, async () => {
      await this.enforceSessionQuota(effectiveOwnership);
      const id = await this.options.store.createSession(workspaceRoot, preset, metadata, undefined, effectiveOwnership);
      this.toolRuntime.setSessionPermissionPreset(id, preset);
      const projection = await this.options.store.project(id);
      if (projection === undefined) throw new Error("Session projection was not created");
      return projection;
    });
  }

  async listSessions(includeArchived = false): Promise<readonly SessionSummary[]> {
    await this.ready;
    return this.options.store.listSessions(includeArchived);
  }

  private async enforceSessionQuota(ownership: SessionOwnership | undefined): Promise<void> {
    const limit = this.quota?.maxSessionsPerTenant;
    if (ownership === undefined || limit === undefined) return;
    const sessions = await this.options.store.listSessions(true);
    const count = sessions.filter((session) => session.ownership?.tenantId === ownership.tenantId && !session.deleted).length;
    if (count >= limit) throw quotaExceeded("SESSION_QUOTA_EXCEEDED", `Tenant ${ownership.tenantId} has reached the session quota (${limit}).`);
  }

  private async enforceTurnQuota(projection: SessionProjection): Promise<void> {
    const limit = this.quota?.maxTurnsPerTenant;
    const tenantId = projection.ownership?.tenantId;
    if (tenantId === undefined || limit === undefined) return;
    const sessions = await this.options.store.listSessions(true);
    let count = 0;
    for (const session of sessions) {
      if (session.ownership?.tenantId !== tenantId) continue;
      const current = await this.options.store.project(session.id);
      count += current?.turns.length ?? 0;
    }
    if (count >= limit) throw quotaExceeded("TURN_QUOTA_EXCEEDED", `Tenant ${tenantId} has reached the turn quota (${limit}).`);
  }

  private async withQuotaLock<T>(tenantId: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (tenantId === undefined) return operation();
    const previous = this.quotaTails.get(tenantId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.quotaTails.set(tenantId, tail);
    await previous;
    try { return await operation(); } finally {
      release();
      if (this.quotaTails.get(tenantId) === tail) this.quotaTails.delete(tenantId);
    }
  }

  async listJobs(sessionId: SessionId): Promise<readonly JobSummary[]> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    return this.jobManager?.listForSession(sessionId, effectiveWorkspaceRoot(projection)) ?? [];
  }

  async retryJob(sessionId: SessionId, jobId: string, backoffMs?: number, commandId?: string): Promise<ToolResult> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    if (this.jobManager === undefined) throw new Error("JOB_MANAGER_UNAVAILABLE: background jobs are disabled for this host");
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "retry_job",
      request: { jobId, backoffMs },
      result: { status: "pending", jobId },
    });
    if (!claim.created) return replayJobCommand(jobId, claim.record.result);
    return this.jobManager.retry(sessionId, jobId, backoffMs === undefined ? {} : { backoffMs });
  }

  async killJob(sessionId: SessionId, jobId: string, commandId?: string): Promise<ToolResult> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    if (this.jobManager === undefined) throw new Error("JOB_MANAGER_UNAVAILABLE: background jobs are disabled for this host");
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "cancel_job",
      request: { jobId },
      result: { status: "pending", jobId },
    });
    if (!claim.created) return replayJobCommand(jobId, claim.record.result);
    return this.jobManager.kill(sessionId, jobId);
  }

  async exportSession(sessionId: SessionId): Promise<{ readonly session: SessionProjection; readonly events: readonly AgentEvent[] }> {
    await this.ready;
    const session = await this.options.store.project(sessionId);
    if (session === undefined) throw new Error(`Unknown session: ${sessionId}`);
    return { session, events: await this.options.store.list(sessionId, 0) };
  }

  async diagnostics(sessionId?: SessionId): Promise<Readonly<Record<string, unknown>>> {
    await this.ready;
    const sessions = sessionId === undefined ? await this.options.store.listSessions(true) : [];
    const target = sessionId === undefined ? undefined : await this.options.store.project(sessionId);
    if (sessionId !== undefined && target === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const jobs = target === undefined || this.jobManager === undefined ? [] : await this.jobManager.listForSession(target.id, effectiveWorkspaceRoot(target));
    return {
      runtime: "typescript",
      generatedAt: new Date().toISOString(),
      sessions: sessionId === undefined ? sessions.length : 1,
      ...(target === undefined ? {} : { session: { id: target.id, status: target.status, turns: target.turns.length, pendingPermissions: target.permissions.filter((item) => item.status === "pending").length, pendingInteractions: target.interactions.filter((item) => item.status === "pending").length } }),
      jobs,
      activeTurns: this.activeTurns.size,
      queuedTurns: [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0),
      pendingPermissionWaiters: this.permissionWaiters.size,
      activeTraces: this.turnTraces.size,
      metrics: this.metrics(),
    };
  }

  metrics(): RuntimeMetricsSnapshot {
    return { ...this.metricCounters };
  }

  async shutdown(): Promise<void> {
    // Preserve turns paused on a durable user interaction. Aborting those
    // controllers would append an interaction/resolved(cancelled) event during
    // server shutdown, destroying the recovery point before the next host can
    // restore and answer it. Other active turns still receive cancellation.
    const waitingTurnIds = new Set(this.toolRuntime.pendingUserInteractions().map((interaction) => interaction.turnId).filter((turnId): turnId is TurnId => turnId !== undefined));
    for (const [turnId, controller] of this.controllers) if (!waitingTurnIds.has(turnId)) controller.abort();
    await this.terminalManager?.shutdown();
    await this.jobManager?.shutdown();
  }

  /**
   * Lists the workspace catalog. An ownership scope is optional for the
   * backwards-compatible local host, but authenticated productization callers
   * must provide it so metadata and ordering are replayed only within a tenant.
   */
  async listWorkspaces(includeArchived = false, ownership?: SessionOwnership): Promise<WorkspaceCatalog> {
    await this.ready;
    const sessions = this.scopedWorkspaceSessions(await this.options.store.listSessions(true), ownership);
    return this.workspaceCatalog(sessions, undefined, includeArchived, ownership);
  }

  async reorderWorkspaces(order: readonly string[], commandId?: string, ownership?: SessionOwnership): Promise<WorkspaceCatalog> {
    await this.ready;
    const sessions = this.scopedWorkspaceSessions(await this.options.store.listSessions(true), ownership);
    const current = await this.workspaceCatalog(sessions, undefined, false, ownership);
    const requested = order.map(normalizeWorkspaceKey);
    const expected = current.workspaces.map((workspace) => workspace.key);
    if (requested.length !== expected.length || new Set(requested).size !== requested.length || expected.some((key) => !requested.includes(key))) {
      throw workspaceOrderInvalid();
    }
    const anchor = sessions
      .filter((session) => session.deleted !== true)
      .sort((left, right) => left.id.localeCompare(right.id))[0];
    if (anchor === undefined) return current;
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const reorderedCatalog = await this.workspaceCatalog(sessions, requested, false, ownership);
    const result = { order: requested, catalog: reorderedCatalog };
    const claim = await this.options.store.claimCommand({
      sessionId: anchor.id,
      commandId: idempotencyKey,
      kind: "reorder_workspaces",
      request: { order: requested, ...workspaceScopePayload(ownership) },
      result,
    });
    if (!claim.created) {
      const saved = claim.record.result as { catalog?: unknown; order?: unknown };
      if (isWorkspaceCatalog(saved.catalog)) return saved.catalog;
      const savedOrder = Array.isArray(saved.order) ? saved.order.filter((value): value is string => typeof value === "string") : requested;
      return this.workspaceCatalog(sessions, savedOrder, false, ownership);
    }
    await this.options.store.append({
      sessionId: anchor.id,
      correlationId: idempotencyKey,
      type: "workspace/reordered",
      payload: { order: requested, ...workspaceScopePayload(ownership) },
    });
    return reorderedCatalog;
  }

  async renameWorkspace(key: string, label: string, commandId?: string, ownership?: SessionOwnership): Promise<WorkspaceCatalog> {
    const normalized = label.trim();
    if (normalized.length === 0) throw new Error("Workspace label cannot be empty");
    if (normalized.length > 120) throw new Error("Workspace label must be 120 characters or fewer");
    return this.updateWorkspace(key, { action: "renamed", label: normalized }, commandId, ownership);
  }

  async archiveWorkspace(key: string, archived = true, commandId?: string, ownership?: SessionOwnership): Promise<WorkspaceCatalog> {
    return this.updateWorkspace(key, { action: archived ? "archived" : "restored", archived }, commandId, ownership);
  }

  async deleteWorkspace(key: string, commandId?: string, ownership?: SessionOwnership): Promise<WorkspaceCatalog> {
    return this.updateWorkspace(key, { action: "deleted", deleted: true }, commandId, ownership);
  }

  private async updateWorkspace(
    key: string,
    change: { readonly action: "renamed" | "archived" | "restored" | "deleted"; readonly label?: string; readonly archived?: boolean; readonly deleted?: boolean },
    commandId?: string,
    ownership?: SessionOwnership,
  ): Promise<WorkspaceCatalog> {
    await this.ready;
    const sessions = this.scopedWorkspaceSessions(await this.options.store.listSessions(true), ownership);
    const normalizedKey = normalizeWorkspaceKey(key);
    const current = await this.workspaceCatalog(sessions, undefined, true, ownership);
    const workspace = current.workspaces.find((item) => item.key === normalizedKey);
    if (workspace === undefined || workspace.deleted === true) throw workspaceNotFound(key);
    const members = sessions
      .filter((session) => session.deleted !== true && normalizeWorkspaceKey(session.workspaceRoot) === normalizedKey)
      .sort((left, right) => left.id.localeCompare(right.id));
    const anchor = members[0];
    if (anchor === undefined) throw new Error(`Unknown workspace: ${key}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const request = { key: normalizedKey, ...workspaceScopePayload(ownership), ...change };
    const claim = await this.options.store.claimCommand({
      sessionId: anchor.id,
      commandId: idempotencyKey,
      kind: `workspace_${change.action}`,
      request,
      result: request,
    });
    if (!claim.created) {
      const replayedSessions = this.scopedWorkspaceSessions(await this.options.store.listSessions(true), ownership);
      return this.workspaceCatalog(replayedSessions, undefined, false, ownership);
    }

    const updatedAt = new Date().toISOString();
    for (const member of members) {
      await this.options.store.append({
        sessionId: member.id,
        correlationId: idempotencyKey,
        type: "workspace/updated",
        payload: { key: normalizedKey, action: change.action, updatedAt, ...workspaceScopePayload(ownership), ...(change.label === undefined ? {} : { label: change.label }), ...(change.archived === undefined ? {} : { archived: change.archived }), ...(change.deleted === undefined ? {} : { deleted: change.deleted }) },
      });
    }
    const updatedSessions = this.scopedWorkspaceSessions(await this.options.store.listSessions(true), ownership);
    return this.workspaceCatalog(updatedSessions, undefined, false, ownership);
  }

  private scopedWorkspaceSessions(sessions: readonly SessionSummary[], ownership?: SessionOwnership): readonly SessionSummary[] {
    if (ownership === undefined) return sessions;
    return sessions.filter((session) => session.ownership?.tenantId === ownership.tenantId);
  }

  private async workspaceCatalog(sessions: readonly SessionSummary[], explicitOrder?: readonly string[], includeArchived = false, ownership?: SessionOwnership): Promise<WorkspaceCatalog> {
    const metadata = await this.workspaceMetadata(sessions, ownership);
    const groups = new Map<string, { readonly key: string; readonly root: string; readonly sessionCount: number; readonly latestUpdatedAt?: string }>();
    for (const session of sessions) {
      if (session.deleted === true) continue;
      const root = session.workspaceRoot || ".";
      const key = normalizeWorkspaceKey(root);
      const state = metadata.get(key);
      if (state?.deleted === true || (!includeArchived && state?.archived === true)) continue;
      const previous = groups.get(key);
      const latestUpdatedAt = latestTimestamp(previous?.latestUpdatedAt, session.updatedAt ?? session.createdAt);
      groups.set(key, { key, root: previous?.root ?? root, sessionCount: (previous?.sessionCount ?? 0) + 1, ...(latestUpdatedAt === undefined ? {} : { latestUpdatedAt }) });
    }
    let order = explicitOrder;
    if (order === undefined) {
      let latestEventAt = 0;
      let replayed: readonly string[] | undefined;
      for (const session of sessions) {
        for (const event of await this.options.store.list(session.id, 0)) {
          if (event.type !== "workspace/reordered" || !workspaceEventMatchesScope(event, ownership)) continue;
          const at = Date.parse(event.createdAt) || 0;
          const payloadOrder = event.payload["order"];
          if (at >= latestEventAt && Array.isArray(payloadOrder)) {
            const values = payloadOrder.filter((value): value is string => typeof value === "string").map(normalizeWorkspaceKey);
            replayed = values;
            latestEventAt = at;
          }
        }
      }
      order = replayed;
    }
    const rank = new Map((order ?? []).map((key, index) => [normalizeWorkspaceKey(key), index]));
    const sorted = [...groups.values()].sort((left, right) => {
      const leftRank = rank.get(left.key);
      const rightRank = rank.get(right.key);
      if (leftRank !== undefined || rightRank !== undefined) return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER);
      return (Date.parse(right.latestUpdatedAt ?? "") || 0) - (Date.parse(left.latestUpdatedAt ?? "") || 0);
    });
    return {
      workspaces: sorted.map((workspace, position) => {
        const state = metadata.get(workspace.key);
        return {
          ...workspace,
          position,
          ...(state?.label === undefined ? {} : { label: state.label }),
          ...(state?.archived === true ? { archived: true } : {}),
          ...(state?.deleted === true ? { deleted: true } : {}),
        };
      }),
    };
  }

  private async workspaceMetadata(sessions: readonly SessionSummary[], ownership?: SessionOwnership): Promise<ReadonlyMap<string, WorkspaceMetadata>> {
    const metadata = new Map<string, WorkspaceMetadata>();
    for (const session of sessions) {
      for (const event of await this.options.store.list(session.id, 0)) {
        if (event.type !== "workspace/updated" || !workspaceEventMatchesScope(event, ownership)) continue;
        const rawKey = event.payload["key"];
        if (typeof rawKey !== "string") continue;
        const key = normalizeWorkspaceKey(rawKey);
        const updatedAt = typeof event.payload["updatedAt"] === "string" ? event.payload["updatedAt"] : event.createdAt;
        const previous = metadata.get(key);
        if (previous !== undefined && (Date.parse(previous.updatedAt) || 0) > (Date.parse(updatedAt) || 0)) continue;
        metadata.set(key, {
          updatedAt,
          ...(typeof event.payload["label"] === "string" ? { label: event.payload["label"] } : previous?.label === undefined ? {} : { label: previous.label }),
          ...(typeof event.payload["archived"] === "boolean" ? { archived: event.payload["archived"] } : previous?.archived === undefined ? {} : { archived: previous.archived }),
          ...(typeof event.payload["deleted"] === "boolean" ? { deleted: event.payload["deleted"] } : previous?.deleted === undefined ? {} : { deleted: previous.deleted }),
        });
      }
    }
    return metadata;
  }

  async archiveSession(sessionId: SessionId, archived = true): Promise<SessionProjection> {
    await this.ready;
    const current = await this.options.store.project(sessionId);
    if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
    await this.options.store.append({ sessionId, type: "session/updated", payload: { archived } });
    const updated = await this.options.store.project(sessionId);
    if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return updated;
  }

  async renameSession(sessionId: SessionId, title: string, commandId?: string): Promise<SessionProjection> {
    await this.ready;
    const current = await this.options.store.project(sessionId);
    if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const normalized = title.trim();
    if (normalized.length === 0) throw new Error("Session title cannot be empty");
    if (normalized.length > 120) throw new Error("Session title must be 120 characters or fewer");
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "rename_session",
      request: { title: normalized },
      result: { title: normalized },
    });
    if (!claim.created) {
      const saved = await this.options.store.project(sessionId);
      if (saved === undefined) throw new Error(`Session disappeared: ${sessionId}`);
      return saved;
    }
    await this.options.store.append({ sessionId, correlationId: idempotencyKey, type: "session/updated", payload: { title: normalized } });
    const updated = await this.options.store.project(sessionId);
    if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return updated;
  }

  /** Soft-deletes a session through the event stream while retaining its history for audit/recovery. */
  async deleteSession(sessionId: SessionId): Promise<SessionProjection> {
    await this.ready;
    const current = await this.options.store.project(sessionId);
    if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
    if (current.deleted) return current;
    await this.options.store.append({ sessionId, type: "session/deleted", payload: { deleted: true } });
    const updated = await this.options.store.project(sessionId);
    if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return updated;
  }

  async getSession(sessionId: SessionId): Promise<SessionProjection | undefined> {
    await this.ready;
    return this.options.store.project(sessionId);
  }

  async setSessionPermissionPreset(sessionId: SessionId, permissionPreset: PermissionPreset): Promise<SessionProjection> {
    await this.ready;
    const current = await this.options.store.project(sessionId);
    if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
    this.toolRuntime.setSessionPermissionPreset(sessionId, permissionPreset);
    await this.options.store.append({ sessionId, type: "session/updated", payload: { permissionPreset } });
    const updated = await this.options.store.project(sessionId);
    if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return updated;
  }

  async updateGoal(
    sessionId: SessionId,
    goalId: string,
    input: { readonly status?: GoalStatus; readonly title?: string; readonly successCriteria?: readonly string[]; readonly budget?: Readonly<Record<string, unknown>>; readonly result?: unknown; readonly reason?: string },
    expectedSequence?: number,
    commandId?: string,
  ): Promise<SessionProjection> {
    await this.ready;
    const current = await this.options.store.project(sessionId);
    if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const goal = current.goals.find((item) => String(item.id) === goalId);
    if (goal === undefined) throw new Error(`Unknown goal: ${goalId}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const existing = await this.options.store.getCommand(sessionId, idempotencyKey);
    if (existing !== undefined) {
      if (existing.kind !== "update_goal") throw new Error(`Command ${idempotencyKey} was already used for ${existing.kind}`);
      return current;
    }
    if (expectedSequence !== undefined && goal.lastSequence !== expectedSequence) throw commandConflict(`Goal ${goalId} changed at sequence ${goal.lastSequence}; expected ${expectedSequence}`);
    const status = input.status ?? goal.status;
    const title = input.title === undefined ? goal.title : normalizeGoalTitle(input.title);
    const successCriteria = input.successCriteria === undefined ? goal.successCriteria : normalizeCriteria(input.successCriteria);
    if (successCriteria.length === 0) throw new Error("Goal requires at least one success criterion");
    const claim = await this.options.store.claimCommand({ sessionId, commandId: idempotencyKey, kind: "update_goal", request: { goalId, input, expectedSequence }, result: { goalId } });
    if (!claim.created) return current;
    const eventType = status === "active" || status === "paused" ? "goal/updated" : "goal/ended";
    await this.options.store.append({
      sessionId,
      correlationId: idempotencyKey,
      type: eventType,
      payload: {
        goalId,
        status,
        title,
        successCriteria,
        ...(input.budget === undefined ? {} : { budget: input.budget }),
        ...(input.result === undefined ? {} : { result: input.result }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
    });
    const updated = await this.options.store.project(sessionId);
    if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return updated;
  }

  async updatePlan(sessionId: SessionId, content: string, status: PlanStatus, expectedSequence?: number, commandId?: string): Promise<SessionProjection> {
    await this.ready;
    const current = await this.options.store.project(sessionId);
    if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const existing = await this.options.store.getCommand(sessionId, idempotencyKey);
    if (existing !== undefined) {
      if (existing.kind !== "update_plan") throw new Error(`Command ${idempotencyKey} was already used for ${existing.kind}`);
      return current;
    }
    if (expectedSequence !== undefined && current.plan.lastSequence !== expectedSequence) throw commandConflict(`Plan changed at sequence ${current.plan.lastSequence}; expected ${expectedSequence}`);
    const normalized = content.trim();
    if (status !== "cleared" && normalized.length === 0) throw new Error("Plan content cannot be empty unless status is cleared");
    const claim = await this.options.store.claimCommand({ sessionId, commandId: idempotencyKey, kind: "update_plan", request: { content: normalized, status, expectedSequence }, result: { status } });
    if (!claim.created) return current;
    await this.options.store.append({ sessionId, correlationId: idempotencyKey, type: "plan/updated", payload: { content: normalized, status } });
    const updated = await this.options.store.project(sessionId);
    if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return updated;
  }

  async updateTodos(sessionId: SessionId, todos: readonly TodoItem[], expectedSequence?: number, commandId?: string): Promise<SessionProjection> {
    await this.ready;
    const current = await this.options.store.project(sessionId);
    if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const existing = await this.options.store.getCommand(sessionId, idempotencyKey);
    if (existing !== undefined) {
      if (existing.kind !== "update_todos") throw new Error(`Command ${idempotencyKey} was already used for ${existing.kind}`);
      return current;
    }
    if (expectedSequence !== undefined && current.lastSequence !== expectedSequence) throw commandConflict(`Session changed at sequence ${current.lastSequence}; expected ${expectedSequence}`);
    const normalized = normalizeTodos(todos);
    const claim = await this.options.store.claimCommand({ sessionId, commandId: idempotencyKey, kind: "update_todos", request: { todos: normalized, expectedSequence }, result: { count: normalized.length } });
    if (!claim.created) return current;
    await this.options.store.append({ sessionId, correlationId: idempotencyKey, type: "todo/updated", payload: { todos: normalized } });
    const updated = await this.options.store.project(sessionId);
    if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return updated;
  }

  async listWorktrees(sessionId: SessionId): Promise<readonly WorktreeProjection[]> {
    await this.ready;
    const current = await this.options.store.project(sessionId);
    if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const manager = new GitWorktreeManager(current.workspaceRoot);
    const discovered = await manager.list();
    const durable = new Map((current.worktrees ?? []).map((item) => [item.path, item] as const));
    const live = discovered.map((item) => {
      const owned = durable.get(item.path);
      const status = item.status === "clean" && owned?.status === "attached" ? "attached" : item.status;
      return { ...item, status, ...(owned?.id === undefined ? {} : { id: owned.id }), ...(owned?.sessionId === undefined ? {} : { sessionId: owned.sessionId }), ...(owned?.taskId === undefined ? {} : { taskId: owned.taskId }) };
    });
    const livePaths = new Set(live.map((item) => item.path));
    return [...live, ...(current.worktrees ?? []).filter((item) => !livePaths.has(item.path))];
  }

  async createWorktree(sessionId: SessionId, input: { readonly id?: string; readonly path?: string; readonly branch?: string; readonly taskId?: string } = {}, commandId?: string): Promise<SessionProjection> {
    return this.withWorktreeLock(sessionId, async () => {
      await this.ready;
      const current = await this.options.store.project(sessionId);
      if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
      const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
      const normalizedInput = input.id === undefined && input.path === undefined && input.branch === undefined
        ? { ...input, id: stableWorktreeId(idempotencyKey) }
        : input;
      const existingCommand = await this.options.store.getCommand(sessionId, idempotencyKey);
      if (existingCommand !== undefined) {
        const recorded = (current.worktrees ?? []).find((item) => item.id === normalizedInput.id || (normalizedInput.path !== undefined && item.path === normalizedInput.path));
        const commandStatus = typeof existingCommand.result === "object" && existingCommand.result !== null ? (existingCommand.result as { readonly status?: unknown }).status : undefined;
        if (recorded !== undefined || commandStatus !== "pending") return current;
      }
      const claim = existingCommand === undefined
        ? await this.options.store.claimCommand({ sessionId, commandId: idempotencyKey, kind: "create_worktree", request: normalizedInput, result: { status: "pending" } })
        : { created: false, record: existingCommand };
      if (!claim.created && (current.worktrees ?? []).some((item) => item.id === normalizedInput.id || (normalizedInput.path !== undefined && item.path === normalizedInput.path))) return current;
      const manager = new GitWorktreeManager(current.workspaceRoot);
      let record: WorktreeProjection;
      try {
        const discovered = (await manager.list()).find((item) =>
          (normalizedInput.path !== undefined && item.path === normalizedInput.path)
          || (normalizedInput.branch !== undefined && item.branch === normalizedInput.branch));
        if (discovered !== undefined && existingCommand === undefined) {
          const error = new Error(`Worktree already exists at ${discovered.path}`);
          Object.assign(error, { code: "WORKTREE_EXISTS" });
          throw error;
        }
        record = discovered === undefined
          ? await manager.create({ ...normalizedInput, sessionId: String(sessionId) })
          : { ...discovered, ...(normalizedInput.id === undefined ? {} : { id: normalizedInput.id }), sessionId };
      } catch (error) {
        const code = error instanceof Error && "code" in error ? (error as { readonly code?: unknown }).code : undefined;
        if (code !== "WORKTREE_EXISTS") {
          await this.options.store.append({ sessionId, correlationId: idempotencyKey, type: "worktree/failed", payload: { id: normalizedInput.id ?? `wt_${randomUUID()}`, repoRoot: current.workspaceRoot, path: normalizedInput.path ?? "", status: "failed", error: error instanceof Error ? error.message : String(error) } });
        }
        throw error;
      }
      await this.options.store.append({ sessionId, correlationId: idempotencyKey, type: "worktree/created", payload: worktreePayload(record, sessionId, normalizedInput.taskId) });
      const updated = await this.options.store.project(sessionId);
      if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
      return updated;
    });
  }

  async attachWorktree(sessionId: SessionId, worktreeId: string, commandId?: string): Promise<SessionProjection> {
    return this.withWorktreeLock(sessionId, async () => {
      await this.ready;
      const current = await this.options.store.project(sessionId);
      if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
      const existing = (await this.listWorktrees(sessionId)).find((item) => item.id === worktreeId);
      if (existing === undefined || existing.status === "removed" || existing.status === "failed") throw new Error(`Unknown or unavailable worktree: ${worktreeId}`);
      const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
      const prior = await this.options.store.getCommand(sessionId, idempotencyKey);
      if (prior !== undefined) return current;
      const claim = await this.options.store.claimCommand({ sessionId, commandId: idempotencyKey, kind: "attach_worktree", request: { worktreeId }, result: { worktreeId } });
      if (!claim.created) return current;
      await this.options.store.append({ sessionId, correlationId: idempotencyKey, type: "worktree/attached", payload: worktreePayload({ ...existing, status: "attached", sessionId }, sessionId, existing.taskId === undefined ? undefined : String(existing.taskId)) });
      const updated = await this.options.store.project(sessionId);
      if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
      return updated;
    });
  }

  async switchWorktree(sessionId: SessionId, worktreeId: string, commandId?: string): Promise<SessionProjection> {
    return this.withWorktreeLock(sessionId, async () => {
      await this.ready;
      const current = await this.options.store.project(sessionId);
      if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
      const existing = (await this.listWorktrees(sessionId)).find((item) => item.id === worktreeId);
      if (existing === undefined || existing.status === "removed" || existing.status === "failed") throw new Error(`Unknown or unavailable worktree: ${worktreeId}`);
      const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
      const claim = await this.options.store.claimCommand({ sessionId, commandId: idempotencyKey, kind: "switch_worktree", request: { worktreeId }, result: { worktreeId, path: existing.path } });
      if (!claim.created) return current;
      await this.options.store.append({ sessionId, correlationId: idempotencyKey, type: "worktree/switched", payload: worktreePayload({ ...existing, status: "attached", sessionId }, sessionId, existing.taskId === undefined ? undefined : String(existing.taskId)) });
      const updated = await this.options.store.project(sessionId);
      if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
      return updated;
    });
  }

  async cleanupWorktree(sessionId: SessionId, worktreeId: string, force = false, commandId?: string): Promise<SessionProjection> {
    return this.withWorktreeLock(sessionId, async () => {
      await this.ready;
      const current = await this.options.store.project(sessionId);
      if (current === undefined) throw new Error(`Unknown session: ${sessionId}`);
      const existing = (current.worktrees ?? []).find((item) => item.id === worktreeId);
      if (existing === undefined) throw new Error(`Unknown worktree: ${worktreeId}`);
      const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
      const prior = await this.options.store.getCommand(sessionId, idempotencyKey);
      if (prior !== undefined && !isPendingCommand(prior)) return current;
      const claim = prior === undefined
        ? await this.options.store.claimCommand({ sessionId, commandId: idempotencyKey, kind: "cleanup_worktree", request: { worktreeId, force }, result: { status: "pending", worktreeId } })
        : { created: false, record: prior };
      if (!claim.created && !isPendingCommand(claim.record)) return current;
      const manager = new GitWorktreeManager(existing.repoRoot);
      let removed: WorktreeProjection;
      try {
        removed = await manager.cleanup(existing.path, force);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error as { readonly code?: unknown }).code === "WORKTREE_DIRTY")) {
          await this.options.store.append({ sessionId, correlationId: idempotencyKey, type: "worktree/failed", payload: worktreePayload({ ...existing, status: "failed", error: error instanceof Error ? error.message : String(error) }, sessionId, existing.taskId === undefined ? undefined : String(existing.taskId)) });
        }
        throw error;
      }
      await this.options.store.append({ sessionId, correlationId: idempotencyKey, type: "worktree/cleaned", payload: worktreePayload({ ...removed, id: existing.id }, sessionId, existing.taskId === undefined ? undefined : String(existing.taskId)) });
      const updated = await this.options.store.project(sessionId);
      if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
      return updated;
    });
  }

  private async withWorktreeLock<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.worktreeOperations.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.worktreeOperations.set(sessionId, queued);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.worktreeOperations.get(sessionId) === queued) this.worktreeOperations.delete(sessionId);
    }
  }

  async events(sessionId: SessionId, afterSequence = 0): Promise<readonly AgentEvent[]> {
    await this.ready;
    return this.options.store.list(sessionId, afterSequence);
  }

  async eventsPage(sessionId: SessionId, options: EventListOptions = {}): Promise<EventPage> {
    await this.ready;
    if (this.options.store.listPage !== undefined) return this.options.store.listPage(sessionId, options);
    const after = options.afterSequence ?? 0;
    const before = options.beforeSequence;
    const all = (await this.options.store.list(sessionId, 0)).filter((event) => event.sequence > after && (before === undefined || event.sequence < before));
    const limit = options.limit === undefined ? undefined : Math.min(1_000, Math.max(1, Math.floor(options.limit)));
    const latest = before === undefined && limit !== undefined && after === 0;
    const events = limit === undefined ? all : latest || before !== undefined ? all.slice(-limit) : all.slice(0, limit);
    const first = events[0]?.sequence;
    const last = events[events.length - 1]?.sequence;
    return {
      events,
      hasMoreBefore: first === undefined ? false : all.some((event) => event.sequence < first),
      hasMoreAfter: last === undefined ? false : all.some((event) => event.sequence > last),
      ...(first === undefined ? {} : { oldestSequence: first }),
      ...(last === undefined ? {} : { newestSequence: last }),
    };
  }

  subscribe(sessionId: SessionId, listener: (event: AgentEvent) => void): () => void {
    return this.options.store.subscribe(sessionId, listener);
  }

  listTools(sessionId?: SessionId, tenantId?: string) {
    return this.toolRuntime.listTools(sessionId, tenantId).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      executionMode: tool.executionMode,
      riskLevel: tool.riskLevel,
      approvalMode: tool.approvalMode,
      interruptBehavior: tool.interruptBehavior,
      source: tool.source ?? { kind: "builtin" },
    }));
  }

  /** Exposes the shared registry to optional protocol adapters such as MCP. */
  toolRegistry(): ToolRegistry {
    return this.toolRuntime.registry;
  }

  async executeTool(sessionId: SessionId, name: string, input: unknown, turnId?: TurnId, commandId?: string, signal?: AbortSignal, caller: ToolCaller = "user"): Promise<ExecuteToolOutput> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const toolCallId = brand<string, "ToolCallId">(`tool_${randomUUID()}`);
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: commandId ?? `cmd_${randomUUID()}`,
      kind: "execute_tool",
      request: { name, input, turnId },
      result: { toolCallId },
    });
    if (!claim.created) {
      const saved = (claim.record.result as { toolCallId?: unknown }).toolCallId;
      if (typeof saved !== "string") throw new Error(`Command ${claim.record.commandId} has an invalid tool result`);
      const call = projection.toolCalls.find((item) => item.id === saved);
      if (call === undefined) throw new Error(`Tool call ${saved} is not available`);
      const permission = projection.permissions.find((item) => item.toolCallId === call.id && item.status === "pending");
      return { toolCallId: call.id, status: call.status === "awaiting_permission" ? "awaiting_permission" : call.status === "completed" ? "completed" : call.status === "cancelled" ? "cancelled" : call.status === "denied" ? "denied" : "failed", ...(call.result === undefined ? {} : { result: call.result }), ...(permission === undefined ? {} : { permission: { id: permission.id, sessionId, toolCallId: permission.toolCallId, toolName: permission.toolName, riskLevel: permission.riskLevel, reason: permission.reason, input, caller: permission.caller ?? caller, workspaceRoot: permission.workspaceRoot ?? effectiveWorkspaceRoot(projection), createdAt: permission.createdAt, expiresAt: permission.expiresAt ?? new Date(Date.parse(permission.createdAt) + 15 * 60_000).toISOString() } satisfies PermissionRequest }) };
    }
    return this.toolRuntime.execute({ sessionId, ...(projection.ownership?.tenantId === undefined ? {} : { tenantId: projection.ownership.tenantId }), workspaceRoot: effectiveWorkspaceRoot(projection), name, input, ...(turnId === undefined ? {} : { turnId }), toolCallId, ...(commandId === undefined ? {} : { commandId }), ...(signal === undefined ? {} : { signal }), caller });
  }

  async resolvePermission(sessionId: SessionId, permissionId: PermissionId, status: "approved" | "denied" | "cancelled", commandId?: string): Promise<ExecuteToolOutput> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const permission = projection.permissions.find((item) => item.id === permissionId);
    if (permission === undefined) throw new Error(`Unknown permission: ${permissionId}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "resolve_permission",
      request: { permissionId, status },
      result: { permissionId, status },
    });
    if (!claim.created || permission.status !== "pending") {
      const call = projection.toolCalls.find((item) => item.id === permission.toolCallId);
      if (call === undefined) throw new Error(`Tool call ${permission.toolCallId} is not available`);
      const output = { toolCallId: call.id, status: call.status === "completed" ? "completed" : call.status === "cancelled" ? "cancelled" : call.status === "denied" ? "denied" : call.status === "awaiting_permission" ? "awaiting_permission" : "failed", ...(call.result === undefined ? {} : { result: call.result }) } as ExecuteToolOutput;
      this.settlePermissionWaiter(permissionId, output);
      void this.maybeResumeRecoveredPermission(permissionId);
      return output;
    }
    const output = await this.toolRuntime.resolvePermission(permissionId, status);
    this.settlePermissionWaiter(permissionId, output);
    void this.maybeResumeRecoveredPermission(permissionId);
    return output;
  }

  pendingUserInteractions(sessionId: SessionId): readonly UserInteractionRequest[] {
    return this.toolRuntime.pendingUserInteractions().filter((interaction) => interaction.sessionId === sessionId);
  }

  async resolveInteraction(sessionId: SessionId, interactionId: InteractionId, status: "answered" | "cancelled", answer?: string, commandId?: string): Promise<UserInteractionAnswer> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const interaction = projection.interactions.find((item) => item.id === interactionId);
    if (interaction === undefined) throw new Error(`Unknown interaction: ${interactionId}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "resolve_interaction",
      request: { interactionId, status, answer },
      result: { interactionId, status, ...(answer === undefined ? {} : { answer }) },
    });
    if (!claim.created || interaction.status !== "pending") {
      const saved = claim.record.result as { status?: unknown; answer?: unknown };
      const resolvedStatus = interaction.status === "answered" || interaction.status === "cancelled" || interaction.status === "expired" ? interaction.status : saved.status;
      if (resolvedStatus !== "answered" && resolvedStatus !== "cancelled" && resolvedStatus !== "expired") throw new Error(`Interaction ${interactionId} has not been resolved`);
      const resolvedAnswer = typeof interaction.answer === "string" ? interaction.answer : typeof saved.answer === "string" ? saved.answer : undefined;
      void this.maybeResumeRecoveredInteraction(interactionId);
      return { interactionId, status: resolvedStatus, ...(resolvedAnswer === undefined ? {} : { answer: resolvedAnswer }) };
    }
    const resolved = await this.toolRuntime.resolveInteraction(interactionId, status, answer);
    void this.maybeResumeRecoveredInteraction(interactionId);
    return resolved;
  }

  async cancelTool(sessionId: SessionId, toolCallId: ToolCallId, commandId?: string): Promise<boolean> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const call = projection.toolCalls.find((item) => item.id === toolCallId);
    if (call === undefined) throw new Error(`Unknown tool call: ${toolCallId}`);
    const cancellable = call.status === "pending" || call.status === "awaiting_permission" || call.status === "running";
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "cancel_tool",
      request: { toolCallId },
      result: { cancelled: cancellable },
    });
    if (!claim.created) return Boolean((claim.record.result as { cancelled?: unknown }).cancelled);
    return cancellable ? this.toolRuntime.cancel(toolCallId) : false;
  }

  async sendMessage(sessionId: SessionId, content: string, commandId?: string, options?: { readonly reasoningEffort?: string }): Promise<TurnId> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    return this.withQuotaLock(projection.ownership?.tenantId, async () => {
      await this.enforceTurnQuota(projection);
      return this.sendMessageInternal(sessionId, content, commandId, options);
    });
  }

  private async sendMessageInternal(sessionId: SessionId, content: string, commandId?: string, options?: { readonly reasoningEffort?: string }): Promise<TurnId> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    if (content.trim() === "") throw new Error("Message content cannot be empty");

    const reasoningEffort = normalizeReasoningEffort(options?.reasoningEffort ?? this.reasoningEffort);
    const turnId = brand<string, "TurnId">(`turn_${randomUUID()}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "send_message",
      request: { content, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
      result: { turnId },
    });
    if (!claim.created) {
      const savedTurnId = (claim.record.result as { turnId?: unknown }).turnId;
      if (typeof savedTurnId !== "string") throw new Error(`Command ${idempotencyKey} has an invalid result`);
      return turnIdFrom(savedTurnId);
    }

    const pending: PendingTurn = {
      sessionId,
      turnId,
      content,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      previousMessages: await this.conversationMessages(sessionId),
    };
    await this.options.store.append({
      sessionId,
      turnId,
      correlationId: idempotencyKey,
      type: "user/message",
      payload: { content },
    });
    await this.options.store.append({
      sessionId,
      turnId,
      correlationId: idempotencyKey,
      type: "turn/queued",
      payload: { commandId: idempotencyKey, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
    });
    const queue = this.queues.get(sessionId) ?? [];
    queue.push(pending);
    this.queues.set(sessionId, queue);
    await this.appendQueueChanged(sessionId, queue, idempotencyKey);
    void this.drainSession(sessionId);
    return turnId;
  }

  async cancelTurn(sessionId: SessionId, turnId: TurnId, commandId?: string): Promise<boolean> {
    await this.ready;
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const cancellationRequested = this.controllers.has(turnId) || (this.queues.get(sessionId)?.some((item) => item.turnId === turnId) ?? false);
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "cancel_turn",
      request: { turnId },
      result: { cancelled: cancellationRequested },
    });
    if (!claim.created) return Boolean((claim.record.result as { cancelled?: unknown }).cancelled);
    if (!cancellationRequested) return false;

    const controller = this.controllers.get(turnId);
    const removed = controller === undefined ? this.removeQueuedTurn(sessionId, turnId) : undefined;
    if (controller !== undefined) controller.abort(new Error("Cancelled by user"));
    await this.options.store.append({
      sessionId,
      turnId,
      correlationId: idempotencyKey,
      type: "agent/status",
      payload: { status: "stopped", reason: "cancelled_by_user" },
    });
    if (controller === undefined) {
      if (removed !== undefined) await this.appendQueueChanged(sessionId, this.queues.get(sessionId) ?? [], idempotencyKey);
      await this.options.store.append({
        sessionId,
        turnId,
        correlationId: idempotencyKey,
        type: "turn/ended",
        payload: { status: "stopped" },
      });
      void this.drainSession(sessionId);
    }
    return true;
  }

  async steerTurn(sessionId: SessionId, turnId: TurnId, content: string, commandId?: string): Promise<{ readonly accepted: boolean; readonly turnId: TurnId; readonly receiptId?: string }> {
    await this.ready;
    if (await this.options.store.project(sessionId) === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const normalized = content.trim();
    if (normalized.length === 0) throw new Error("Steer content cannot be empty");
    if (normalized.length > 4_000) throw new Error("Steer content must be 4,000 characters or fewer");
    const accepted = this.controllers.has(turnId) && this.activeTurns.get(sessionId) === turnId;
    const receiptId = `steer_${randomUUID()}`;
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const result = { accepted, turnId, ...(accepted ? { receiptId } : {}) };
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "steer_turn",
      request: { turnId, content: normalized },
      result,
    });
    if (!claim.created) {
      const saved = claim.record.result as { accepted?: unknown; turnId?: unknown; receiptId?: unknown };
      return {
        accepted: saved.accepted === true,
        turnId: brand<string, "TurnId">(typeof saved.turnId === "string" ? saved.turnId : String(turnId)),
        ...(typeof saved.receiptId === "string" ? { receiptId: saved.receiptId } : {}),
      };
    }
    if (!accepted) return result;
    const queue = this.steerQueues.get(turnId) ?? [];
    queue.push(normalized);
    this.steerQueues.set(turnId, queue);
    await this.options.store.append({
      sessionId,
      turnId,
      correlationId: idempotencyKey,
      type: "turn/steered",
      payload: { content: normalized, receiptId, status: "accepted" },
    });
    return result;
  }

  /** Records a host-validated browser attachment receipt without exposing file bytes in the event log. */
  async recordAttachment(sessionId: SessionId, receipt: AttachmentReceipt, commandId?: string): Promise<AttachmentReceipt> {
    await this.ready;
    if (await this.options.store.project(sessionId) === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "record_attachment",
      request: {
        id: receipt.id,
        fileName: receipt.fileName,
        mediaType: receipt.mediaType,
        sizeBytes: receipt.sizeBytes,
        status: receipt.status,
      },
      result: { ...receipt },
    });
    if (!claim.created) return claim.record.result as AttachmentReceipt;
    await this.options.store.append({
      sessionId,
      correlationId: idempotencyKey,
      type: receipt.status === "accepted" ? "attachment/received" : "attachment/rejected",
      payload: { ...receipt },
    });
    return receipt;
  }

  async reorderQueue(sessionId: SessionId, turnId: TurnId, position: number, commandId?: string): Promise<{ readonly reordered: boolean; readonly queuedTurnIds: readonly TurnId[] }> {
    await this.ready;
    if (await this.options.store.project(sessionId) === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const queue = this.queues.get(sessionId) ?? [];
    const currentIndex = queue.findIndex((item) => item.turnId === turnId);
    const normalizedPosition = queue.length === 0 ? 0 : Math.min(queue.length - 1, Math.max(0, Math.floor(position)));
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const reordered = currentIndex >= 0 && currentIndex !== normalizedPosition;
    const nextOrder = queue.map((item) => item.turnId);
    if (reordered) {
      const [moved] = nextOrder.splice(currentIndex, 1);
      if (moved !== undefined) nextOrder.splice(normalizedPosition, 0, moved);
    }
    const result = { reordered, queuedTurnIds: nextOrder };
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "reorder_queue",
      request: { turnId, position: normalizedPosition },
      result,
    });
    if (!claim.created) {
      const saved = claim.record.result as { reordered?: unknown; queuedTurnIds?: unknown };
      return {
        reordered: saved.reordered === true,
        queuedTurnIds: Array.isArray(saved.queuedTurnIds) ? saved.queuedTurnIds.filter((value): value is TurnId => typeof value === "string").map((value) => brand<string, "TurnId">(value)) : [],
      };
    }
    if (!reordered) return result;
    const [moved] = queue.splice(currentIndex, 1);
    if (moved !== undefined) queue.splice(normalizedPosition, 0, moved);
    this.queues.set(sessionId, queue);
    await this.appendQueueChanged(sessionId, queue, idempotencyKey);
    return result;
  }

  async resumeSession(sessionId: SessionId, commandId?: string): Promise<SessionProjection> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "resume_session",
      request: {},
      result: { resumed: true },
    });
    if (claim.created && (projection.status === "interrupted" || projection.status === "stopped")) {
      await this.options.store.append({
        sessionId,
        correlationId: idempotencyKey,
        type: "agent/status",
        payload: { status: "idle", reason: "resumed_by_user" },
      });
    }
    void this.drainSession(sessionId);
    const resumed = await this.options.store.project(sessionId);
    if (resumed === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return resumed;
  }

  async forkSession(sessionId: SessionId, workspaceRoot?: string, commandId?: string): Promise<SessionId> {
    await this.ready;
    const source = await this.options.store.project(sessionId);
    if (source === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const forkedId = brand<string, "SessionId">(`ses_${randomUUID()}`);
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "fork_session",
      request: { workspaceRoot },
      result: { sessionId: forkedId },
    });
    if (!claim.created) {
      const savedId = (claim.record.result as { sessionId?: unknown }).sessionId;
      if (typeof savedId !== "string") throw new Error(`Command ${idempotencyKey} has an invalid result`);
      return sessionIdFrom(savedId);
    }
    return this.options.store.forkSession(sessionId, workspaceRoot, forkedId, source.permissionPreset);
  }

  async waitForTurn(turnId: TurnId, timeoutMs = 10_000): Promise<void> {
    await this.ready;
    const started = Date.now();
    while (true) {
      const sessions = await this.options.store.listSessions();
      for (const session of sessions) {
        const projection = await this.options.store.project(session.id);
        if (projection === undefined) continue;
        const turn = projection?.turns.find((item) => item.id === turnId);
        if (turn === undefined || turn.status === "queued" || turn.status === "running") continue;
        // An interrupted turn with restored approvals is still live from the
        // caller's perspective; it will become running once every approval is
        // resolved and must not make waitForTurn return early.
        if (turn.status === "interrupted") {
          const recovered = this.recoveredTurns.get(turnId);
          if (recovered !== undefined) {
            await this.reconcileRecoveredTurn(recovered, projection);
            if (this.recoveredTurns.has(turnId) || this.activeTurns.get(session.id) === turnId) continue;
          }
        }
        const events = await this.options.store.list(session.id);
        const ended = [...events].reverse().find((event) => event.turnId === turnId && event.type === "turn/ended");
        if (ended !== undefined) return;
      }
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${turnId}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  private async restoreQueuedTurns(): Promise<void> {
    for (const summary of await this.options.store.listSessions(true)) {
      let projection = await this.options.store.project(summary.id);
      if (projection === undefined) continue;
      this.toolRuntime.setSessionPermissionPreset(summary.id, projection.permissionPreset ?? this.permissionPreset ?? "ask-on-write");
      const history = await this.options.store.list(summary.id);
      await this.toolRuntime.restorePending(summary.id, effectiveWorkspaceRoot(projection), history);
      projection = await this.options.store.project(summary.id);
      if (projection === undefined) continue;
      for (const turn of projection.turns
        .filter((item) => item.status === "queued" && item.userMessage !== undefined)
        .sort((left, right) => (left.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.queuePosition ?? Number.MAX_SAFE_INTEGER) || left.lastSequence - right.lastSequence)) {
        const restoredReasoningEffort = reasoningEffortForTurn(history, turn.id);
        this.enqueue({
          sessionId: summary.id,
          turnId: turn.id,
          content: turn.userMessage as string,
          ...(restoredReasoningEffort === undefined ? {} : { reasoningEffort: restoredReasoningEffort }),
          previousMessages: await this.conversationMessages(summary.id, turn.id),
        });
      }
      for (const turn of projection.turns.filter((item) => item.status === "interrupted")) {
        const permissionIds = new Set(projection.permissions.filter((permission) => permission.status === "pending" && permission.turnId === turn.id).map((permission) => permission.id));
        const interactionIds = new Set(projection.interactions.filter((interaction) => interaction.status === "pending" && interaction.turnId === turn.id).map((interaction) => interaction.id));
        if (permissionIds.size === 0 && interactionIds.size === 0) continue;
        const recovered: RecoveredTurn = { sessionId: summary.id, turnId: turn.id, permissionIds, interactionIds };
        this.recoveredTurns.set(turn.id, recovered);
        for (const permissionId of permissionIds) this.recoveredPermissionIndex.set(permissionId, turn.id);
        for (const interactionId of interactionIds) this.recoveredInteractionIndex.set(interactionId, turn.id);
      }
    }
  }

  private async maybeResumeRecoveredPermission(permissionId: PermissionId): Promise<void> {
    const turnId = this.recoveredPermissionIndex.get(permissionId);
    if (turnId === undefined) return;
    const recovered = this.recoveredTurns.get(turnId);
    if (recovered === undefined) return;
    recovered.permissionIds.delete(permissionId);
    this.recoveredPermissionIndex.delete(permissionId);
    await this.maybeStartRecoveredTurn(recovered);
  }

  private async maybeResumeRecoveredInteraction(interactionId: InteractionId): Promise<void> {
    const turnId = this.recoveredInteractionIndex.get(interactionId);
    if (turnId === undefined) return;
    const recovered = this.recoveredTurns.get(turnId);
    if (recovered === undefined) return;
    recovered.interactionIds.delete(interactionId);
    this.recoveredInteractionIndex.delete(interactionId);
    await this.maybeStartRecoveredTurn(recovered);
  }

  private async maybeStartRecoveredTurn(recovered: RecoveredTurn): Promise<void> {
    if (recovered.permissionIds.size > 0 || recovered.interactionIds.size > 0 || this.activeTurns.has(recovered.sessionId)) return;
    this.recoveredTurns.delete(recovered.turnId);
    const controller = new AbortController();
    this.activeTurns.set(recovered.sessionId, recovered.turnId);
    this.controllers.set(recovered.turnId, controller);
    void this.runRecoveredTurn(recovered.sessionId, recovered.turnId, controller).finally(() => {
      this.controllers.delete(recovered.turnId);
      this.activeTurns.delete(recovered.sessionId);
      this.steerQueues.delete(recovered.turnId);
      void this.drainSession(recovered.sessionId);
    });
  }

  private async reconcileRecoveredTurn(recovered: RecoveredTurn, projection: SessionProjection): Promise<void> {
    const pendingPermissions = new Set(projection.permissions.filter((permission) => permission.status === "pending").map((permission) => permission.id));
    const pendingInteractions = new Set(projection.interactions.filter((interaction) => interaction.status === "pending").map((interaction) => interaction.id));
    for (const permissionId of [...recovered.permissionIds]) {
      if (pendingPermissions.has(permissionId)) continue;
      recovered.permissionIds.delete(permissionId);
      this.recoveredPermissionIndex.delete(permissionId);
    }
    for (const interactionId of [...recovered.interactionIds]) {
      if (pendingInteractions.has(interactionId)) continue;
      recovered.interactionIds.delete(interactionId);
      this.recoveredInteractionIndex.delete(interactionId);
    }
    await this.maybeStartRecoveredTurn(recovered);
  }

  private async conversationMessages(sessionId: SessionId, beforeTurnId?: TurnId): Promise<readonly ChatMessage[]> {
    const messages: ChatMessage[] = [];
    for (const event of await this.options.store.list(sessionId)) {
      if (beforeTurnId !== undefined && event.type === "user/message" && event.turnId === beforeTurnId) break;
      if (event.type === "user/message" || event.type === "turn/steered") {
        const content = event.payload["content"];
        if (typeof content === "string") messages.push({ role: "user", content });
      } else if (event.type === "assistant/message") {
        const content = typeof event.payload["content"] === "string" ? event.payload["content"] as string : "";
        const toolCalls = parseModelToolCalls(event.payload["toolCalls"]);
        if (content.length > 0 || toolCalls.length > 0) messages.push({ role: "assistant", content, ...(toolCalls.length === 0 ? {} : { toolCalls }) });
      } else if (event.type === "tool/result") {
        const rawToolCallId = event.payload["toolCallId"];
        if (typeof rawToolCallId !== "string") continue;
        const rawResult = event.payload["result"];
        const result = rawResult !== undefined ? rawResult as ToolResult : undefined;
        messages.push({ role: "tool", toolCallId: rawToolCallId, content: modelToolResult({ toolCallId: brand<string, "ToolCallId">(rawToolCallId), status: event.payload["status"] === "completed" ? "completed" : event.payload["status"] === "cancelled" ? "cancelled" : event.payload["status"] === "denied" ? "denied" : "failed", ...(result === undefined ? {} : { result }) }) });
      }
    }
    return messages;
  }

  private async systemMessage(sessionId: SessionId, recovery = false): Promise<string> {
    const projection = await this.options.store.project(sessionId);
    const workspaceRoot = projection === undefined ? "." : effectiveWorkspaceRoot(projection);
    return buildAgentSystemPrompt({
      workspaceRoot,
      tools: this.toolRuntime.listTools(sessionId, projection?.ownership?.tenantId),
      toolGuidance: this.toolPromptRegistry.assemble(this.toolRuntime.listTools(sessionId, projection?.ownership?.tenantId)),
      permissionPreset: projection?.permissionPreset ?? this.permissionPreset ?? "ask-on-write",
      ...(this.customSystemPrompt === undefined ? {} : { customInstructions: this.customSystemPrompt }),
      ...(recovery ? { recovery: true } : {}),
    });
  }

  private enqueue(pending: PendingTurn): void {
    const queue = this.queues.get(pending.sessionId) ?? [];
    if (!queue.some((item) => item.turnId === pending.turnId)) queue.push(pending);
    this.queues.set(pending.sessionId, queue);
  }

  private removeQueuedTurn(sessionId: SessionId, turnId: TurnId): PendingTurn | undefined {
    const queue = this.queues.get(sessionId);
    if (queue === undefined) return undefined;
    const index = queue.findIndex((item) => item.turnId === turnId);
    if (index < 0) return undefined;
    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(sessionId);
    return removed;
  }

  private async drainSession(sessionId: SessionId): Promise<void> {
    if (this.activeTurns.has(sessionId)) return;
    const queue = this.queues.get(sessionId);
    const pending = queue?.shift();
    if (queue !== undefined && queue.length === 0) this.queues.delete(sessionId);
    if (pending === undefined) return;
    const controller = new AbortController();
    this.activeTurns.set(sessionId, pending.turnId);
    this.controllers.set(pending.turnId, controller);
    await this.appendQueueChanged(sessionId, queue ?? [], undefined);
    void this.runTurn(sessionId, pending.turnId, controller, pending.previousMessages, pending.content, pending.reasoningEffort).finally(() => {
      this.controllers.delete(pending.turnId);
      this.activeTurns.delete(sessionId);
      this.steerQueues.delete(pending.turnId);
      void this.drainSession(sessionId);
    });
  }

  private async appendQueueChanged(sessionId: SessionId, queue: readonly PendingTurn[], correlationId?: string): Promise<void> {
    const queuedTurnIds = queue.map((item) => item.turnId);
    const previous = this.queueChangeTails.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await this.options.store.append({
        sessionId,
        ...(correlationId === undefined ? {} : { correlationId }),
        type: "queue/changed",
        payload: { queuedTurnIds },
      });
    });
    this.queueChangeTails.set(sessionId, next);
    await next;
  }

  private async runTurn(
    sessionId: SessionId,
    turnId: TurnId,
    controller: AbortController,
    previousMessages: readonly ChatMessage[],
    content: string,
    reasoningEffort?: string,
  ): Promise<void> {
    try {
      this.metricCounters.turnsStarted += 1;
      const traceId = `trace_${randomUUID()}`;
      this.turnTraces.set(turnId, traceId);
      const projection = await this.options.store.project(sessionId);
      const route = this.modelRouteForTenant(projection?.ownership?.tenantId);
      await this.options.store.append({ sessionId, turnId, type: "turn/started", payload: { traceId, ...(route === undefined ? {} : route), ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } });
      const messages: ChatMessage[] = [
        { role: "system", content: await this.systemMessage(sessionId) },
        ...previousMessages,
        { role: "user", content },
      ];
      await this.runSteps(sessionId, turnId, controller, messages, reasoningEffort);
    } catch (error) {
      await this.finishTurnAfterError(sessionId, turnId, controller, error);
    } finally {
      this.turnTraces.delete(turnId);
    }
  }

  private async runRecoveredTurn(sessionId: SessionId, turnId: TurnId, controller: AbortController): Promise<void> {
    try {
      this.metricCounters.turnsStarted += 1;
      const traceId = `trace_${randomUUID()}`;
      this.turnTraces.set(turnId, traceId);
      const projection = await this.options.store.project(sessionId);
      const route = this.modelRouteForTenant(projection?.ownership?.tenantId);
      await this.options.store.append({ sessionId, turnId, type: "agent/status", payload: { status: "running", reason: "permission_resolved_after_restart", traceId, ...(route === undefined ? {} : route) } });
      const messages: ChatMessage[] = [{ role: "system", content: await this.systemMessage(sessionId, true) }, ...(await this.conversationMessages(sessionId))];
      await this.runSteps(sessionId, turnId, controller, messages);
    } catch (error) {
      await this.finishTurnAfterError(sessionId, turnId, controller, error);
    } finally {
      this.turnTraces.delete(turnId);
    }
  }

  private async runSteps(sessionId: SessionId, turnId: TurnId, controller: AbortController, messages: ChatMessage[], reasoningEffort?: string): Promise<void> {
    for (let step = 1; step <= this.maxSteps; step += 1) {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Cancelled");
      this.appendSteers(messages, turnId);
      const projection = await this.options.store.project(sessionId);
      const tenantId = projection?.ownership?.tenantId;
      const budgetSnapshot = this.contextBudgetSnapshot(tenantId);
      const primaryModel = this.modelForTenant(tenantId);
      const beforeView: ModelContextView = { messages, tools: this.modelTools(sessionId, tenantId) };
      const tokenCounter = createTokenCounter(primaryModel);
      const estimate = tokenCounter.estimate(beforeView);
      const tokenCount = await countContextTokens(tokenCounter, beforeView, {
        preferExact: shouldUseExactTokenCount(estimate, budgetSnapshot, this.contextPolicyWithLegacyFallback()),
        signal: controller.signal,
      });
      const beforeUsage = tokenCount.value;
      const beforeState = calculateContextWarningState(beforeUsage, budgetSnapshot, this.contextPolicyWithLegacyFallback());
      const autoCompactRecommended = shouldCompactBeforeRequest(beforeState, this.contextPolicyWithLegacyFallback());
      if (this.compactionEnabled && autoCompactRecommended) {
        await this.compactTurnContext(sessionId, turnId, messages, budgetSnapshot, beforeUsage, beforeState);
      }
      let finalCount = tokenCount;
      if (autoCompactRecommended) {
        const afterView: ModelContextView = { messages, ...(beforeView.tools === undefined ? {} : { tools: beforeView.tools }) };
        finalCount = await countContextTokens(tokenCounter, afterView, { signal: controller.signal });
      }
      const tokenUsage = finalCount.value;
      const warningState = calculateContextWarningState(tokenUsage, budgetSnapshot, this.contextPolicyWithLegacyFallback());
      await this.options.store.append({
        sessionId,
        turnId,
        type: "step/started",
        payload: {
          step,
          contextBudget: publicContextBudgetSnapshot(budgetSnapshot),
          contextWarning: warningState,
          tokenCount: publicTokenCount(finalCount),
          ...(autoCompactRecommended ? { autoCompactRecommended: true } : {}),
        },
      });
      const response = await this.collectModelResponse(sessionId, turnId, controller, messages, tenantId, reasoningEffort);
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Cancelled");
      const assistantPayload = {
        content: response.text,
        ...(response.toolCalls.length === 0 ? {} : { toolCalls: response.toolCalls }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      };
      await this.options.store.append({ sessionId, turnId, type: "assistant/message", payload: assistantPayload });
      const steersAfterResponse = this.takeSteers(turnId);
      if (response.toolCalls.length === 0) {
        if (steersAfterResponse.length > 0) {
          messages.push({ role: "assistant", content: response.text });
          for (const steer of steersAfterResponse) messages.push({ role: "user", content: steer });
          await this.options.store.append({ sessionId, turnId, type: "step/ended", payload: { step, status: "steered" } });
          continue;
        }
        await this.options.store.append({ sessionId, turnId, type: "step/ended", payload: { step, status: "completed" } });
        await this.options.store.append({ sessionId, turnId, type: "turn/ended", payload: { status: "completed", ...(this.turnTraces.get(turnId) === undefined ? {} : { traceId: this.turnTraces.get(turnId) }) } });
        this.metricCounters.turnsCompleted += 1;
        return;
      }
      messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
      for (const steer of steersAfterResponse) messages.push({ role: "user", content: steer });
      const outputs = await Promise.all(response.toolCalls.map((toolCall) => this.executeModelToolCall(sessionId, turnId, controller, toolCall)));
      for (let index = 0; index < outputs.length; index += 1) {
        const output = outputs[index];
        const toolCall = response.toolCalls[index];
        if (output === undefined || toolCall === undefined) throw new Error("TOOL_RESULT_MISMATCH: tool result count did not match tool call count");
        messages.push({ role: "tool", toolCallId: toolCall.id, content: modelToolResult(output) });
      }
      await this.options.store.append({ sessionId, turnId, type: "step/ended", payload: { step, status: "completed", toolCalls: response.toolCalls.length } });
    }
    throw new Error(`MAX_AGENT_STEPS_EXCEEDED: model did not produce a final response within ${this.maxSteps} steps`);
  }

  private async compactTurnContext(
    sessionId: SessionId,
    turnId: TurnId,
    messages: ChatMessage[],
    budgetSnapshot?: ContextBudgetSnapshot,
    tokenUsage?: number,
    warningState?: ContextWarningState,
  ): Promise<void> {
    if (!this.compactionEnabled) return;
    const projection = await this.options.store.project(sessionId);
    const protectedToolCallIds = new Set<string>([
      ...(projection?.permissions.filter((permission) => permission.status === "pending").map((permission) => String(permission.toolCallId)) ?? []),
      ...(projection?.interactions.filter((interaction) => interaction.status === "pending").map((interaction) => String(interaction.toolCallId)) ?? []),
    ]);
    try {
      const resolved = budgetSnapshot ?? this.contextBudgetSnapshot(projection?.ownership?.tenantId);
      const usage = tokenUsage ?? estimateContextTokens({ messages }).value;
      const predictive = warningState?.isPredictiveCompactRecommended === true && usage < resolved.autoCompactThreshold;
      const maxTokens = predictive ? Math.max(1, usage - 1) : resolved.autoCompactThreshold;
      const compactionBudget: ContextBudget = {
        ...DEFAULT_CONTEXT_BUDGET,
        ...(this.contextBudget ?? {}),
        maxTokens,
      };
      const result = compactMessages(messages, { budget: compactionBudget, protectedToolCallIds });
      if (!result.didCompact) return;
      messages.splice(0, messages.length, ...result.messages);
      await this.options.store.append({
        sessionId,
        turnId,
        type: "context/compacted",
        payload: {
          sourceSequence: projection?.lastSequence ?? 0,
          summary: result.summary,
          originalMessageCount: result.originalMessageCount,
          compactedMessageCount: result.compactedMessageCount,
          estimatedTokens: result.estimatedTokens,
          droppedMessages: result.droppedMessages,
          protectedMessageCount: result.protectedMessageCount,
          truncatedToolResults: result.truncatedToolResults,
        },
      });
    } catch (error) {
      await this.options.store.append({
        sessionId,
        turnId,
        type: "context/compaction_failed",
        payload: {
          sourceSequence: projection?.lastSequence ?? 0,
          summary: "",
          originalMessageCount: messages.length,
          compactedMessageCount: messages.length,
          estimatedTokens: 0,
          droppedMessages: 0,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private appendSteers(messages: ChatMessage[], turnId: TurnId): void {
    for (const steer of this.takeSteers(turnId)) messages.push({ role: "user", content: steer });
  }

  private takeSteers(turnId: TurnId): readonly string[] {
    const queue = this.steerQueues.get(turnId);
    if (queue === undefined || queue.length === 0) return [];
    this.steerQueues.delete(turnId);
    return [...queue];
  }

  private async finishTurnAfterError(sessionId: SessionId, turnId: TurnId, controller: AbortController, error: unknown): Promise<void> {
    const traceId = this.turnTraces.get(turnId);
    if (controller.signal.aborted) {
      this.metricCounters.turnsStopped += 1;
      await this.options.store.append({ sessionId, turnId, type: "turn/ended", payload: { status: "stopped", ...(traceId === undefined ? {} : { traceId }) } });
    } else {
      this.metricCounters.turnsFailed += 1;
      const message = error instanceof Error ? error.message : String(error);
      await this.options.store.append({ sessionId, turnId, type: "agent/error", payload: { message, ...(traceId === undefined ? {} : { traceId }) } });
      await this.options.store.append({ sessionId, turnId, type: "turn/ended", payload: { status: "failed", message, ...(traceId === undefined ? {} : { traceId }) } });
    }
  }

  private modelTools(sessionId: SessionId, tenantId?: string): readonly ModelToolDefinition[] {
    return this.toolRuntime.listTools(sessionId, tenantId).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }

  private async collectModelResponse(
    sessionId: SessionId,
    turnId: TurnId,
    controller: AbortController,
    messages: readonly ChatMessage[],
    tenantId?: string,
    reasoningEffort?: string,
  ): Promise<CollectedModelResponse> {
    const candidates = [this.tenantModels.get(tenantId ?? "") ?? this.model, ...this.fallbackModels];
    let lastError: unknown = new Error("No model configured");
    for (let modelIndex = 0; modelIndex < candidates.length; modelIndex += 1) {
      const model = candidates[modelIndex];
      if (model === undefined) continue;
      const textParts: string[] = [];
      const calls = new Map<number, { id?: string; name?: string; arguments: string }>();
      let usage: ModelUsage | undefined;
      try {
        for await (const part of model.stream({ messages, tools: this.modelTools(sessionId, tenantId), toolChoice: "auto", ...(reasoningEffort === undefined ? {} : { reasoningEffort }), signal: controller.signal })) {
          if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Cancelled");
          if (part.type === "text_delta") {
            textParts.push(part.text);
            await this.options.store.append({ sessionId, turnId, type: "assistant/chunk", payload: { text: part.text } });
          } else if (part.type === "tool_call_start") {
            const current = calls.get(part.index) ?? { arguments: "" };
            calls.set(part.index, { ...current, ...(part.id === undefined ? {} : { id: part.id }), ...(part.name === undefined ? {} : { name: part.name }) });
          } else if (part.type === "tool_call_delta") {
            const current = calls.get(part.index) ?? { arguments: "" };
            calls.set(part.index, { ...current, arguments: `${current.arguments}${part.arguments}` });
          } else if (part.type === "usage") {
            usage = mergeModelUsage(usage, part.usage);
          } else if (part.type === "error") {
            throw new Error(`${part.code}: ${part.message}`);
          }
        }
        const toolCalls: ModelToolCall[] = [];
        for (const [index, call] of [...calls.entries()].sort(([left], [right]) => left - right)) {
          if (call.name === undefined || call.name.trim() === "") throw new Error(`MALFORMED_TOOL_CALL: missing tool name at index ${index}`);
          toolCalls.push({ id: call.id ?? `call_${randomUUID()}`, name: call.name, arguments: call.arguments });
        }
        return { text: textParts.join(""), toolCalls, ...(usage === undefined ? {} : { usage }) };
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted || textParts.length > 0 || modelIndex >= candidates.length - 1) throw error;
        this.metricCounters.modelFallbacks += 1;
        await this.options.store.append({ sessionId, turnId, type: "agent/error", payload: { code: "MODEL_FALLBACK", message: error instanceof Error ? error.message : String(error), failedModelIndex: modelIndex, fallbackModelIndex: modelIndex + 1 } });
      }
    }
    throw lastError;
  }

  private modelRouteForTenant(tenantId: string | undefined): TenantModelRoute | undefined {
    if (tenantId === undefined) return undefined;
    const route = this.tenantModelRoutes.get(tenantId);
    if (route === undefined) return undefined;
    return {
      provider: route.provider,
      model: route.model,
      ...(route.baseUrl === undefined ? {} : { baseUrl: route.baseUrl }),
      ...(route.credentialRef === undefined ? {} : { credentialRef: route.credentialRef }),
      ...(route.contextCapability === undefined ? {} : { contextCapability: route.contextCapability }),
    };
  }

  private async executeModelToolCall(
    sessionId: SessionId,
    turnId: TurnId,
    controller: AbortController,
    toolCall: ModelToolCall,
  ): Promise<ExecuteToolOutput> {
    this.metricCounters.toolCalls += 1;
    let input: unknown;
    try {
      input = toolCall.arguments.trim() === "" ? {} : JSON.parse(toolCall.arguments) as unknown;
    } catch (error) {
      return this.syntheticToolFailure(sessionId, turnId, toolCall, "MALFORMED_TOOL_ARGUMENTS", error instanceof Error ? error.message : String(error));
    }
    try {
      const projection = await this.options.store.project(sessionId);
      const output = await this.toolRuntime.execute({
        sessionId,
        ...(projection?.ownership?.tenantId === undefined ? {} : { tenantId: projection.ownership.tenantId }),
        turnId,
        workspaceRoot: projection === undefined ? "." : effectiveWorkspaceRoot(projection),
        name: toolCall.name,
        input,
        toolCallId: brand<string, "ToolCallId">(toolCall.id),
        signal: controller.signal,
        caller: "agent",
      });
      if (output.status === "failed" || output.result?.ok === false) this.metricCounters.toolFailures += 1;
      if (output.status !== "awaiting_permission" || output.permission === undefined) return output;
      return this.waitForPermission(output.permission, controller);
    } catch (error) {
      this.metricCounters.toolFailures += 1;
      return this.syntheticToolFailure(sessionId, turnId, toolCall, "TOOL_CALL_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  private async syntheticToolFailure(sessionId: SessionId, turnId: TurnId, toolCall: ModelToolCall, code: string, message: string): Promise<ExecuteToolOutput> {
    const toolCallId = brand<string, "ToolCallId">(toolCall.id);
    const result: ToolResult = { ok: false, error: { code, message, remedy: "Check the tool name and JSON arguments, then retry." }, presentation: { kind: "tool", title: code, text: message } };
    await this.options.store.append({ sessionId, turnId, type: "tool/call", payload: { toolCallId, name: toolCall.name, input: toolCall.arguments, riskLevel: "read", approvalMode: "deny", caller: "agent" } });
    await this.options.store.append({ sessionId, turnId, type: "tool/result", payload: { toolCallId, status: "failed", result } });
    return { toolCallId, status: "failed", result };
  }

  private waitForPermission(permission: PermissionRequest, controller: AbortController): Promise<ExecuteToolOutput> {
    return new Promise<ExecuteToolOutput>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        void this.toolRuntime.resolvePermission(permission.id, "cancelled").then(finish, reject);
      }, Math.max(0, Date.parse(permission.expiresAt) - Date.now()));
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
      };
      const finish = (output: ExecuteToolOutput) => {
        if (settled) return;
        settled = true;
        this.permissionWaiters.delete(permission.id);
        cleanup();
        resolve(output);
      };
      const onAbort = () => {
        void this.toolRuntime.resolvePermission(permission.id, "cancelled").then(finish, reject);
      };
      this.permissionWaiters.set(permission.id, { resolve: finish, reject });
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private settlePermissionWaiter(permissionId: PermissionId, output: ExecuteToolOutput): void {
    this.permissionWaiters.get(permissionId)?.resolve(output);
  }
}

export { createInProcessSubagentProvider, type InProcessProviderOptions } from "./subagent-provider.js";

export function sessionId(value: string): SessionId {
  return brand<string, "SessionId">(value);
}

export function turnId(value: string): TurnId {
  return brand<string, "TurnId">(value);
}

function normalizeWorkspaceKey(value: string): string {
  const normalized = String(value || ".").replace(/\\/g, "/").replace(/\/+$/u, "") || ".";
  return /^[A-Za-z]:\//u.test(normalized) ? normalized.toLowerCase() : normalized;
}

function latestTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return (Date.parse(right) || 0) >= (Date.parse(left) || 0) ? right : left;
}

function workspaceScopePayload(ownership: SessionOwnership | undefined): Readonly<Record<string, string>> {
  if (ownership === undefined) return {};
  return { principalId: ownership.principalId, tenantId: ownership.tenantId };
}

function workspaceEventMatchesScope(event: AgentEvent, ownership: SessionOwnership | undefined): boolean {
  const tenantId = event.payload["tenantId"];
  // Legacy/local workspace events have no tenant scope. Authenticated catalog
  // replay fails closed and only accepts events explicitly written for the
  // caller's tenant. The unscoped local catalog ignores tenant events rather
  // than projecting one tenant's label/order into another tenant's view.
  if (ownership === undefined) return tenantId === undefined;
  return tenantId === ownership.tenantId;
}

function workspaceNotFound(key: string): Error {
  const error = new Error(`Unknown workspace: ${key}`);
  Object.assign(error, { code: "WORKSPACE_NOT_FOUND" });
  return error;
}

function workspaceOrderInvalid(): Error {
  const error = new Error("WORKSPACE_ORDER_INVALID: order must contain each visible workspace exactly once");
  Object.assign(error, { code: "WORKSPACE_ORDER_INVALID" });
  return error;
}

function isWorkspaceCatalog(value: unknown): value is WorkspaceCatalog {
  if (typeof value !== "object" || value === null) return false;
  const workspaces = (value as { workspaces?: unknown }).workspaces;
  return Array.isArray(workspaces) && workspaces.every((workspace) => {
    if (typeof workspace !== "object" || workspace === null) return false;
    const item = workspace as { key?: unknown; root?: unknown; position?: unknown; sessionCount?: unknown };
    return typeof item.key === "string" && typeof item.root === "string" && typeof item.position === "number" && typeof item.sessionCount === "number";
  });
}

function modelToolResult(output: ExecuteToolOutput): string {
  if (output.result === undefined) return JSON.stringify({ ok: false, error: { code: `TOOL_${output.status.toUpperCase()}`, message: `Tool ended with status ${output.status}` } });
  const view = output.result.modelView ?? output.result.output ?? output.result;
  return typeof view === "string" ? view : JSON.stringify(view);
}

function parseModelToolCalls(value: unknown): readonly ModelToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ModelToolCall[] => {
    if (typeof item !== "object" || item === null) return [];
    const id = (item as { id?: unknown }).id;
    const name = (item as { name?: unknown }).name;
    const args = (item as { arguments?: unknown }).arguments;
    if (typeof id !== "string" || typeof name !== "string" || typeof args !== "string") return [];
    return [{ id, name, arguments: args }];
  });
}

function sessionIdFrom(value: string): SessionId {
  return brand<string, "SessionId">(value);
}

function turnIdFrom(value: string): TurnId {
  return brand<string, "TurnId">(value);
}

function normalizeReasoningEffort(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "" || normalized === "default") return undefined;
  if (normalized.length > 64) throw new Error("reasoningEffort must be 64 characters or fewer");
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalized)) throw new Error("reasoningEffort contains unsupported characters");
  return normalized;
}

function mergeModelUsage(previous: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  return {
    ...(previous?.inputTokens === undefined && next.inputTokens === undefined ? {} : { inputTokens: (previous?.inputTokens ?? 0) + (next.inputTokens ?? 0) }),
    ...(previous?.outputTokens === undefined && next.outputTokens === undefined ? {} : { outputTokens: (previous?.outputTokens ?? 0) + (next.outputTokens ?? 0) }),
    ...(previous?.cacheReadTokens === undefined && next.cacheReadTokens === undefined ? {} : { cacheReadTokens: (previous?.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0) }),
    ...(previous?.reasoningTokens === undefined && next.reasoningTokens === undefined ? {} : { reasoningTokens: (previous?.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0) }),
  };
}

function publicContextBudgetSnapshot(snapshot: ContextBudgetSnapshot): Readonly<Record<string, unknown>> {
  return {
    capability: {
      provider: snapshot.capability.provider,
      model: snapshot.capability.model,
      maxInputTokens: snapshot.capability.maxInputTokens,
      maxOutputTokens: snapshot.capability.maxOutputTokens,
      supportsExactCount: snapshot.capability.supportsExactCount,
      supportsPromptCache: snapshot.capability.supportsPromptCache,
    },
    reservedOutputTokens: snapshot.reservedOutputTokens,
    effectiveWindowTokens: snapshot.effectiveWindowTokens,
    autoCompactBufferTokens: snapshot.autoCompactBufferTokens,
    warningThreshold: snapshot.warningThreshold,
    errorThreshold: snapshot.errorThreshold,
    autoCompactThreshold: snapshot.autoCompactThreshold,
    blockingThreshold: snapshot.blockingThreshold,
    source: snapshot.source,
  };
}

function publicTokenCount(count: TokenCount): Readonly<Record<string, unknown>> {
  return {
    value: count.value,
    source: count.source,
    confidence: count.confidence,
    ...(count.stale === true ? { stale: true } : {}),
    ...(count.exactAttempted === true ? { exactAttempted: true } : {}),
    ...(count.exactError === undefined ? {} : { exactError: count.exactError }),
    ...(count.breakdown === undefined ? {} : { breakdown: count.breakdown }),
  };
}

function reasoningEffortForTurn(events: readonly AgentEvent[], turnId: TurnId): string | undefined {
  const queued = [...events].reverse().find((event) => event.turnId === turnId && event.type === "turn/queued");
  const value = queued?.payload["reasoningEffort"];
  return typeof value === "string" ? normalizeReasoningEffort(value) : undefined;
}

function commandConflict(message: string): Error {
  const error = new Error(message);
  Object.assign(error, { code: "COMMAND_CONFLICT" });
  return error;
}

function normalizeGoalTitle(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error("Goal title cannot be empty");
  if (normalized.length > 180) throw new Error("Goal title must be 180 characters or fewer");
  return normalized;
}

function normalizeCriteria(values: readonly string[]): readonly string[] {
  const criteria = values.map((value) => value.trim()).filter(Boolean).slice(0, 32);
  if (criteria.some((value) => value.length > 500)) throw new Error("Goal success criteria must be 500 characters or fewer");
  return criteria;
}

function normalizeTodos(values: readonly TodoItem[]): readonly TodoItem[] {
  const seen = new Set<string>();
  return values.slice(0, 128).map((item) => {
    const id = item.id.trim();
    const content = item.content.trim();
    if (id.length === 0 || content.length === 0) throw new Error("Todo id and content cannot be empty");
    if (seen.has(id)) throw new Error(`TODO_DUPLICATE_ID: ${id}`);
    seen.add(id);
    if (content.length > 500) throw new Error("Todo content must be 500 characters or fewer");
    return { id, content, status: item.status, ...(item.activeForm === undefined ? {} : { activeForm: item.activeForm.trim().slice(0, 500) }) };
  });
}

function worktreePayload(record: WorktreeProjection, sessionId: SessionId, taskId?: string): Readonly<Record<string, unknown>> {
  return {
    id: record.id,
    repoRoot: record.repoRoot,
    path: record.path,
    status: record.status,
    ...(record.branch === undefined ? {} : { branch: record.branch }),
    ...(record.commit === undefined ? {} : { commit: record.commit }),
    sessionId: String(sessionId),
    ...(taskId === undefined ? {} : { taskId }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

function isPendingCommand(record: { readonly result: unknown }): boolean {
  return typeof record.result === "object" && record.result !== null && (record.result as { readonly status?: unknown }).status === "pending";
}

function stableWorktreeId(commandId: string): string {
  const safe = commandId.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 80).replace(/^-+|-+$/gu, "");
  return `worktree-${safe || "command"}`;
}

function effectiveWorkspaceRoot(projection: SessionProjection): string {
  return projection.activeWorkspaceRoot ?? projection.workspaceRoot;
}

function replayJobCommand(jobId: string, result: unknown): ToolResult {
  if (typeof result === "object" && result !== null && typeof (result as { readonly ok?: unknown }).ok === "boolean") {
    return result as ToolResult;
  }
  return {
    ok: true,
    output: { jobId, status: "idempotent_replay" },
    presentation: { kind: "terminal", title: `Job command already applied for ${jobId}`, data: { jobId, status: "idempotent_replay" } },
  };
}

function quotaExceeded(code: "SESSION_QUOTA_EXCEEDED" | "TURN_QUOTA_EXCEEDED", message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}
