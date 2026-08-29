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
  type SessionStatsProjection,
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
  type ModelSelection,
  type ContextCollapseCapability,
  type ContextBoundaryKind,
  type ContextRecoveryErrorClass,
  type ToolResultReplacementRecord,
} from "@code-review-agent/contracts";
import { EchoChatModel, modelFailureMetadata, sanitizeFailureMessage } from "@code-review-agent/llm";
import { compactMessages, DEFAULT_CONTEXT_BUDGET, type ContextBudget } from "@code-review-agent/compaction";
import { applyToolResultBudgetAsync, assembleContext, buildPostCompactMessages, buildProjectMemoryPrompt, buildToolResultModelView, calculateContextWarningState, classifyProviderContextError, compactWithSessionMemory, compactWithSummaryModel, ContextRecoveryGuard, countContextTokens, createSessionMemoryFileWriteGuard, createTokenCounter, createToolResultBudgetState, createToolResultStorage, ensureToolResultPairing, estimateContextTokens, extractContextAttachmentIds, fallbackModelContextCapability, fingerprintModelRequest, groupMessagesByApiRound, hydrateToolResultBudgetState, isReactiveContextError, normalizeMessagesForAPI, normalizeExtractionConfig, recallRelevantProjectMemory, resolveContextBudget, restoreModelViewFromTranscript, selectPostCompactAttachments, SessionMemoryExtractionScheduler, sessionMemoryStats, shouldCompactBeforeRequest, shouldExtractSessionMemory, shouldUseExactTokenCount, truncateProjectMemoryEntrypoint, validateProjectMemoryTopic, type ApiRound, type ContextAssembly, type ContextAttachment, type ContextBudgetConfig, type MessageNormalizationReport, type ModelContextView, type PostCompactAttachmentConfig, type PostCompactAttachmentProvider, type ProjectMemoryScope, type ProjectMemoryStore, type ProjectMemoryTopic, type SessionMemoryCompactConfig, type SessionMemoryExtractionConfig, type SessionMemoryExtractionState, type SessionMemoryExtractor, type SessionMemoryStore, type SummaryCompactConfig, type SummaryRequest, type SummaryResponse, type TokenCount, type ToolPairingReport, type ToolResultBudgetPolicy, type ToolResultBudgetReport, type ToolResultBudgetState, type ToolResultStorage } from "@code-review-agent/context";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BUILTIN_TOOL_PROMPT_SPECS, createBuiltinTools, createSubagentTools, DefaultPermissionPolicy, FileObservationPolicy, JobManager, TerminalManager, ToolPromptRegistry, ToolRegistry, ToolRuntime, type CapabilityRegistry, type CodeModePolicySnapshot, type CodeModeSandbox, type ExecuteToolOutput, type JobSummary, type LspServerConfig, type PermissionPreset } from "@code-review-agent/tools";
import type { SubagentRuntime } from "@code-review-agent/subagent";
import { GitWorktreeManager, WorkspaceResolver } from "@code-review-agent/workspace";
import { buildAgentSystemPromptSections } from "./system-prompt.js";
import { RepeatToolReminder, type RepeatToolReminderConfig, type RepeatToolNotice } from "./repeat-tool-reminder.js";
import { resolveMaxParallelToolCalls, scheduleToolCalls } from "./tool-call-scheduler.js";

export interface AgentHostOptions {
  readonly store: SessionEventStore;
  readonly model?: ChatModel;
  /** Provider-owned reasoning level applied to future turns when supplied. */
  readonly reasoningEffort?: string;
  readonly fallbackModels?: readonly ChatModel[];
  readonly systemPrompt?: string;
  /**
   * @deprecated Retained for caller compatibility. Turn execution is no longer
   * terminated by a host-owned step budget; use cancellation or an external
   * operational timeout when a caller needs to stop a turn.
   */
  readonly maxSteps?: number;
  /** Maximum in-flight parallel-safe tool calls per assistant step. */
  readonly maxParallelToolCalls?: number;
  /** DSH-style advisory reminder for exact repeated tool calls. */
  readonly repeatToolReminder?: RepeatToolReminderConfig;
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
  /** API message validation policy; repair keeps the model request safe by default. */
  readonly messageValidationMode?: "repair" | "strict";
  /** Non-destructive model-view tool-result budget and microcompact policy. */
  readonly toolResultBudget?: ToolResultBudgetPolicy;
  /** Claude Code-style single-result artifact storage; defaults to a workspace-safe writer. */
  readonly toolResultStorage?: ToolResultStorage;
  /** Host-owned session memory used by M06 and M11. */
  readonly sessionMemory?: SessionMemoryStore;
  readonly sessionMemoryCompact?: Partial<SessionMemoryCompactConfig>;
  /** Optional isolated adapter used by the M11 background extractor. */
  readonly sessionMemoryExtractor?: SessionMemoryExtractor;
  readonly sessionMemoryExtraction?: Partial<SessionMemoryExtractionConfig>;
  /** Claude Code-style workspace/tenant Project Memory adapter (M12). */
  readonly projectMemory?: ProjectMemoryStore;
  /** Host-owned fact validators used before a recalled memory enters model view. */
  readonly projectMemoryValidation?: {
    readonly pathExists?: (path: string, scope: ProjectMemoryScope) => Promise<boolean | undefined>;
    readonly symbolExists?: (symbol: string, scope: ProjectMemoryScope) => Promise<boolean | undefined>;
    readonly flagExists?: (flag: string, scope: ProjectMemoryScope) => Promise<boolean | undefined>;
  };
  /** Optional host-derived stable scope key; defaults to a SHA-256 workspace/tenant key. */
  readonly projectMemoryScopeKey?: (input: { readonly workspaceRoot: string; readonly tenantId?: string }) => string;
  /** Claude Code-style tool-less LLM summary compact configuration (M07). */
  readonly summaryCompact?: Partial<SummaryCompactConfig>;
  /** Host-owned sources rebuilt after a compact boundary is created. */
  readonly postCompactAttachmentProvider?: PostCompactAttachmentProvider;
  readonly postCompactAttachmentConfig?: Partial<PostCompactAttachmentConfig>;
  /** Per-turn M09 reactive recovery and compact failure limits. */
  readonly contextRecovery?: {
    readonly maxReactiveAttempts?: number;
    readonly maxConsecutiveCompactionFailures?: number;
  };
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
  /** M14 capability boundary; disabled until a real collapse implementation is accepted. */
  readonly collapse: ContextCollapseCapability;
}

export interface ToolExecutionSettings {
  readonly maxParallelToolCalls: number;
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
  readonly userMessageId?: string;
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
  readonly responseId: string;
}

interface ScheduledModelToolOutput {
  readonly output: ExecuteToolOutput;
  /** True when ToolRuntime deferred its durable result events for scheduler commit. */
  readonly deferredResult: boolean;
}

interface PreparedModelContext {
  readonly view: ModelContextView;
  readonly rounds: readonly ApiRound[];
  readonly normalization: MessageNormalizationReport;
  readonly pairing: ToolPairingReport;
  readonly toolResultBudget: ToolResultBudgetReport;
  readonly newlyPersistedToolResultReplacements: readonly ToolResultReplacementRecord[];
}

export type TenantModelRoute = Pick<ModelRouteRecord, "provider" | "model" | "baseUrl" | "credentialRef" | "contextCapability">;

interface SessionModelBinding {
  readonly model: ChatModel;
  readonly selection: ModelSelection;
  readonly route?: TenantModelRoute;
}

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
  private readonly maxParallelToolCallsLimit: number;
  private readonly ready: Promise<void>;
  private readonly toolRuntime: ToolRuntime;
  private readonly fileObservationPolicy?: FileObservationPolicy;
  private readonly repeatToolReminder: RepeatToolReminder;
  private readonly terminalManager?: TerminalManager;
  private readonly jobManager?: JobManager;
  private readonly toolPromptRegistry: ToolPromptRegistry;
  private readonly compactionEnabled: boolean;
  private readonly contextBudget: Partial<ContextBudget> | undefined;
  private readonly contextPolicy: Partial<ContextBudgetConfig> | undefined;
  private readonly messageValidationMode: "repair" | "strict";
  private readonly toolResultBudget: ToolResultBudgetPolicy | undefined;
  private readonly toolResultStorage: ToolResultStorage;
  private readonly sessionMemory: SessionMemoryStore | undefined;
  private readonly sessionMemoryCompact: Partial<SessionMemoryCompactConfig> | undefined;
  private readonly sessionMemoryExtractor: SessionMemoryExtractor | undefined;
  private readonly sessionMemoryExtraction: Partial<SessionMemoryExtractionConfig> | undefined;
  private readonly projectMemory: ProjectMemoryStore | undefined;
  private readonly projectMemoryValidation: AgentHostOptions["projectMemoryValidation"];
  private readonly projectMemoryScopeKey: AgentHostOptions["projectMemoryScopeKey"];
  private readonly projectMemoryTurnStates = new Map<string, { readonly loaded: boolean; readonly surfacedIds: Set<string>; readonly staleIds: Set<string>; readonly cachedTopics: Map<string, ProjectMemoryTopic>; readonly disabled: boolean }>();
  private readonly sessionMemoryScheduler = new SessionMemoryExtractionScheduler();
  private readonly sessionMemoryScheduleTails = new Map<SessionId, Promise<void>>();
  private readonly summaryCompact: Partial<SummaryCompactConfig> | undefined;
  private readonly postCompactAttachmentProvider: PostCompactAttachmentProvider | undefined;
  private readonly postCompactAttachmentConfig: Partial<PostCompactAttachmentConfig> | undefined;
  private readonly contextRecovery: AgentHostOptions["contextRecovery"];
  private readonly quota: ProductizationQuotaPolicy | undefined;
  private readonly operations: ProductizationOperationsPolicy;
  private readonly quotaTails = new Map<string, Promise<void>>();
  private readonly worktreeOperations = new Map<SessionId, Promise<void>>();
  private readonly metricCounters = { turnsStarted: 0, turnsCompleted: 0, turnsFailed: 0, turnsStopped: 0, modelFallbacks: 0, toolCalls: 0, toolFailures: 0 };
  private readonly tenantModels = new Map<string, ChatModel>();
  private readonly tenantModelRoutes = new Map<string, TenantModelRoute>();
  private readonly sessionModels = new Map<SessionId, SessionModelBinding>();

  constructor(private readonly options: AgentHostOptions) {
    this.model = options.model ?? new EchoChatModel();
    this.reasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
    this.fallbackModels = options.fallbackModels ?? [];
    this.compactionEnabled = options.compactionEnabled !== false;
    this.contextBudget = options.contextBudget;
    this.contextPolicy = options.contextPolicy;
    this.messageValidationMode = options.messageValidationMode ?? "repair";
    this.toolResultBudget = options.toolResultBudget;
    this.toolResultStorage = options.toolResultStorage ?? createToolResultStorage({
      write: async ({ workspaceRoot, relativePath, content }) => writeToolResultArtifact(workspaceRoot, relativePath, content),
    });
    this.sessionMemory = options.sessionMemory;
    this.sessionMemoryCompact = options.sessionMemoryCompact;
    this.sessionMemoryExtractor = options.sessionMemoryExtractor;
    this.sessionMemoryExtraction = options.sessionMemoryExtraction;
    this.projectMemory = options.projectMemory;
    this.projectMemoryValidation = options.projectMemoryValidation;
    this.projectMemoryScopeKey = options.projectMemoryScopeKey;
    this.summaryCompact = options.summaryCompact;
    this.postCompactAttachmentProvider = options.postCompactAttachmentProvider;
    this.postCompactAttachmentConfig = options.postCompactAttachmentConfig;
    this.contextRecovery = options.contextRecovery;
    this.quota = options.quota;
    this.operations = options.operations ?? { backup: "deferred", migration: "deferred", upgrade: "deferred" };
    this.customSystemPrompt = options.systemPrompt;
    this.maxParallelToolCallsLimit = resolveMaxParallelToolCalls(options.maxParallelToolCalls);
    this.repeatToolReminder = new RepeatToolReminder(options.repeatToolReminder);
    const registry = options.toolRegistry ?? new ToolRegistry();
    this.toolPromptRegistry = options.toolPromptRegistry ?? new ToolPromptRegistry();
    if (options.toolPromptRegistry === undefined) this.toolPromptRegistry.registerMany(BUILTIN_TOOL_PROMPT_SPECS);
    if (options.toolRuntime === undefined) {
      this.terminalManager = new TerminalManager();
      this.jobManager = new JobManager({ eventStore: options.store });
      if (options.toolRegistry === undefined) {
        this.fileObservationPolicy = new FileObservationPolicy();
        registry.registerMany(createBuiltinTools({ terminalManager: this.terminalManager, jobManager: this.jobManager, eventStore: options.store, fileObservationPolicy: this.fileObservationPolicy, ...(options.visionEnabled === undefined ? {} : { visionEnabled: options.visionEnabled }), ...(options.lspServers === undefined ? {} : { lspServers: options.lspServers }), ...(options.codeMode === undefined ? {} : { codeMode: options.codeMode }), ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }) }));
      }
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

  /** Binds a model to one Session. The binding affects future turns only. */
  setSessionModel(sessionId: SessionId, model: ChatModel, selection: ModelSelection, route?: TenantModelRoute): void {
    if (selection.provider.trim() === "" || selection.model.trim() === "") throw new Error("session model selection provider and model are required");
    this.sessionModels.set(sessionId, { model, selection: { provider: selection.provider.trim(), model: selection.model.trim(), ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort.trim() }) }, ...(route === undefined ? {} : { route }) });
  }

  clearSessionModel(sessionId: SessionId): void {
    this.sessionModels.delete(sessionId);
  }

  sessionModelSelection(sessionId: SessionId): ModelSelection | undefined {
    return this.sessionModels.get(sessionId)?.selection;
  }

  /** Idempotently records the durable Session model selection before applying the in-process binding. */
  async selectSessionModel(sessionId: SessionId, selection: ModelSelection, model: ChatModel, route?: TenantModelRoute, commandId?: string): Promise<SessionProjection> {
    await this.ready;
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const normalized: ModelSelection = {
      provider: selection.provider.trim(),
      model: selection.model.trim(),
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort.trim() }),
    };
    if (normalized.provider === "" || normalized.model === "") throw new Error("session model selection provider and model are required");
    const idempotencyKey = commandId ?? `cmd_${randomUUID()}`;
    const claim = await this.options.store.claimCommand({
      sessionId,
      commandId: idempotencyKey,
      kind: "select_session_model",
      request: normalized,
      result: { selection: normalized },
    });
    if (!claim.created) {
      const saved = claim.record.result as { selection?: unknown };
      const savedSelection = parseModelSelection(saved.selection) ?? projection.modelSelection;
      if (savedSelection !== undefined) {
        const binding = this.sessionModels.get(sessionId);
        if (binding === undefined || binding.selection.model !== savedSelection.model || binding.selection.provider !== savedSelection.provider) this.setSessionModel(sessionId, model, savedSelection, route);
      }
      return (await this.options.store.project(sessionId)) ?? projection;
    }
    await this.options.store.append({ sessionId, correlationId: idempotencyKey, type: "session/model_selected", payload: { provider: normalized.provider, model: normalized.model, ...(normalized.reasoningEffort === undefined ? {} : { reasoningEffort: normalized.reasoningEffort }) } });
    this.setSessionModel(sessionId, model, normalized, route);
    return (await this.options.store.project(sessionId)) ?? projection;
  }

  contextSettings(tenantId?: string): ContextSettings {
    const snapshot = this.contextBudgetSnapshot(tenantId);
    return {
      enabled: this.compactionEnabled,
      configured: this.contextBudget !== undefined || this.contextPolicy !== undefined || snapshot.source !== "estimate",
      ...(this.contextBudget === undefined ? {} : { budget: { ...this.contextBudget } }),
      capability: snapshot.capability,
      budgetSnapshot: snapshot,
      collapse: {
        version: 1,
        enabled: false,
        status: "deferred",
        reason: "Context Collapse is deferred until M01-M13 pass real-provider model-view, boundary, recovery and replay validation; the Claude Code snapshot exposes this integration as a stub.",
        features: {
          readTimeProjection: false,
          backgroundCollapse: false,
          overflowDrain: false,
          snip: false,
        },
      },
    };
  }

  /** Returns the Host-owned tool scheduler cap exposed by the API capability projection. */
  toolExecutionSettings(): ToolExecutionSettings {
    return { maxParallelToolCalls: this.maxParallelToolCallsLimit };
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

  private contextBudgetSnapshotForModel(model: ChatModel, routeCapability?: ModelContextCapability): ContextBudgetSnapshot {
    const capability = model.contextCapability ?? routeCapability ?? fallbackModelContextCapability("unknown", "unknown", this.contextPolicyWithLegacyFallback());
    return resolveContextBudget(capability, this.contextPolicyWithLegacyFallback());
  }

  private modelForTenant(tenantId?: string): ChatModel {
    return tenantId === undefined ? this.model : this.tenantModels.get(tenantId) ?? this.model;
  }

  private modelBindingForSession(sessionId: SessionId, projection: SessionProjection | undefined): SessionModelBinding | undefined {
    const explicit = this.sessionModels.get(sessionId);
    if (explicit !== undefined) return explicit;
    const tenantId = projection?.ownership?.tenantId;
    const model = this.modelForTenant(tenantId);
    const route = this.modelRouteForTenant(tenantId);
    if (route === undefined) return undefined;
    return {
      model,
      selection: { provider: route.provider, model: route.model },
      route,
    };
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
    this.fileObservationPolicy?.clear();
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
    this.fileObservationPolicy?.clearSession(sessionId);
    this.repeatToolReminder.reset(sessionId);
    const updated = await this.options.store.project(sessionId);
    if (updated === undefined) throw new Error(`Session disappeared: ${sessionId}`);
    return updated;
  }

  async getSession(sessionId: SessionId): Promise<SessionProjection | undefined> {
    await this.ready;
    return this.options.store.project(sessionId);
  }

  /** Returns the complete-log stats projection without exposing a history page. */
  async getSessionStats(sessionId: SessionId): Promise<SessionStatsProjection | undefined> {
    await this.ready;
    return (await this.options.store.project(sessionId))?.stats;
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

    this.repeatToolReminder.reset(sessionId);

    const pendingMessages = await this.conversationMessages(sessionId);
    const userMessageEvent = await this.options.store.append({
      sessionId,
      turnId,
      correlationId: idempotencyKey,
      type: "user/message",
      payload: { content },
    });
    const pending: PendingTurn = {
      sessionId,
      turnId,
      content,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      previousMessages: pendingMessages,
      userMessageId: userMessageEvent.eventId,
    };
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
    const created = await this.options.store.forkSession(sessionId, workspaceRoot, forkedId, source.permissionPreset);
    const binding = this.sessionModels.get(sessionId);
    if (binding !== undefined) this.sessionModels.set(created, binding);
    return created;
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

  /** Waits for the per-session background memory extractor without coupling it to a turn. */
  async waitForSessionMemoryExtraction(sessionId: SessionId, timeoutMs?: number): Promise<void> {
    await this.ready;
    await (this.sessionMemoryScheduleTails.get(sessionId) ?? Promise.resolve());
    await this.sessionMemoryScheduler.wait(String(sessionId), timeoutMs);
  }

  /** Cancels only the isolated memory extraction for a session. The main turn is unaffected. */
  cancelSessionMemoryExtraction(sessionId: SessionId): boolean {
    return this.sessionMemoryScheduler.cancel(String(sessionId));
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
        const restoredUserMessageId = history.find(event => event.type === "user/message" && event.turnId === turn.id)?.eventId;
        this.enqueue({
          sessionId: summary.id,
          turnId: turn.id,
          content: turn.userMessage as string,
          ...(restoredReasoningEffort === undefined ? {} : { reasoningEffort: restoredReasoningEffort }),
          previousMessages: await this.conversationMessages(summary.id, turn.id),
          ...(restoredUserMessageId === undefined ? {} : { userMessageId: restoredUserMessageId }),
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
      if (projection.contextSessionMemory?.status === "running" || projection.contextSessionMemory?.status === "queued") {
        const resume = this.resumeSessionMemoryExtraction(summary.id).catch(() => undefined).finally(() => {
          if (this.sessionMemoryScheduleTails.get(summary.id) === resume) this.sessionMemoryScheduleTails.delete(summary.id);
        });
        this.sessionMemoryScheduleTails.set(summary.id, resume);
      }
    }
  }

  private async resumeSessionMemoryExtraction(sessionId: SessionId): Promise<void> {
    if (this.sessionMemory === undefined || this.sessionMemoryExtractor === undefined || this.sessionMemory.save === undefined) return;
    const projection = await this.options.store.project(sessionId);
    const persisted = projection?.contextSessionMemory;
    if (persisted === undefined || (persisted.status !== "running" && persisted.status !== "queued")) return;
    const messages = await this.conversationMessages(sessionId);
    let memory;
    try {
      memory = await this.sessionMemory.get(String(sessionId));
    } catch (error) {
      await this.recordSessionMemoryExtractionFailure(sessionId, undefined, error);
      return;
    }
    const sourceSequence = persisted.sourceSequence ?? projection?.lastSequence ?? 0;
    const sourceMessageId = persisted.sourceMessageId ?? persisted.lastExtractedMessageId;
    const trigger = persisted.trigger ?? "threshold";
    // If the process crashed after the host-owned save but before the durable
    // completion receipt, do not invoke the extractor a second time.
    if (memory?.lastSummarizedMessageId !== undefined && memory.lastSummarizedMessageId === persisted.sourceMessageId) {
      const completedAt = memory.updatedAt ?? new Date().toISOString();
      await this.options.store.append({
        sessionId,
        type: "context/session_memory_extraction_completed",
        payload: {
          initialized: true,
          sourceSequence,
          ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
          lastExtractedMessageId: memory.lastSummarizedMessageId,
          lastExtractedTokens: Math.max(persisted.lastExtractedTokens, sessionMemoryStats(messages, sourceMessageId).estimatedTokens),
          toolCallsSinceLastExtraction: persisted.toolCallsSinceLastExtraction,
          trigger,
          extractorSessionId: persisted.extractorSessionId ?? `memory_${randomUUID()}`,
          completedAt,
          memoryChars: memory.content.length,
          memoryUpdatedAt: completedAt,
          idempotentRecovery: true,
        },
      });
      return;
    }
    const estimatedTokens = persisted.lastExtractedTokens > 0 ? persisted.lastExtractedTokens : sessionMemoryStats(messages, sourceMessageId).estimatedTokens;
    const extractorSessionId = persisted.extractorSessionId ?? `memory_${randomUUID()}`;
    void this.sessionMemoryScheduler.enqueue(String(sessionId), (signal) => this.executeSessionMemoryExtraction({
      sessionId,
      sourceSequence,
      ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
      messages,
      ...(memory === undefined ? {} : { memory }),
      trigger,
      estimatedTokens,
      toolCallsSinceLastExtraction: persisted.toolCallsSinceLastExtraction,
      extractorSessionId,
      signal,
    }));
  }

  private scheduleSessionMemoryExtraction(sessionId: SessionId, turnId: TurnId): void {
    if (this.sessionMemory === undefined || this.sessionMemoryExtractor === undefined || this.sessionMemory.save === undefined) return;
    const previous = this.sessionMemoryScheduleTails.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.startSessionMemoryExtraction(sessionId, turnId)).catch(() => undefined).finally(() => {
      if (this.sessionMemoryScheduleTails.get(sessionId) === next) this.sessionMemoryScheduleTails.delete(sessionId);
    });
    this.sessionMemoryScheduleTails.set(sessionId, next);
  }

  private async startSessionMemoryExtraction(sessionId: SessionId, turnId: TurnId): Promise<void> {
    const projection = await this.options.store.project(sessionId);
    if (projection === undefined || projection.contextSessionMemory?.status === "running" || projection.contextSessionMemory?.status === "queued") return;
    const messages = await this.conversationMessages(sessionId);
    let memory;
    try {
      memory = await this.sessionMemory!.get(String(sessionId));
    } catch (error) {
      await this.recordSessionMemoryExtractionFailure(sessionId, turnId, error);
      return;
    }
    const persisted = projection.contextSessionMemory;
    const stats = sessionMemoryStats(messages, memory?.lastSummarizedMessageId ?? persisted?.lastExtractedMessageId);
    const state: SessionMemoryExtractionState = {
      status: persisted?.status ?? "idle",
      initialized: persisted?.initialized ?? false,
      ...(persisted?.lastExtractedMessageId === undefined ? {} : { lastExtractedMessageId: persisted.lastExtractedMessageId }),
      lastExtractedTokens: persisted?.lastExtractedTokens ?? 0,
      toolCallsSinceLastExtraction: persisted?.toolCallsSinceLastExtraction ?? 0,
    };
    const decision = shouldExtractSessionMemory(state, stats, this.sessionMemoryExtraction);
    if (!decision.shouldExtract || decision.trigger === undefined) return;
    const extractorSessionId = `memory_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    await this.options.store.append({
      sessionId,
      ...(turnId === undefined ? {} : { turnId }),
      type: "context/session_memory_extraction_started",
      payload: {
        initialized: decision.initialized,
        sourceSequence: projection.lastSequence,
        ...(stats.lastMessageId === undefined ? {} : { sourceMessageId: stats.lastMessageId }),
        trigger: decision.trigger,
        estimatedTokens: stats.estimatedTokens,
        lastExtractedTokens: state.lastExtractedTokens,
        toolCallsSinceLastExtraction: decision.toolCallsSinceLastExtraction,
        extractorSessionId,
        startedAt,
      },
    });
    void this.sessionMemoryScheduler.enqueue(String(sessionId), (signal) => this.executeSessionMemoryExtraction({
      sessionId,
      turnId,
      sourceSequence: projection.lastSequence,
      ...(stats.lastMessageId === undefined ? {} : { sourceMessageId: stats.lastMessageId }),
      messages,
      memory,
      trigger: decision.trigger!,
      estimatedTokens: stats.estimatedTokens,
      toolCallsSinceLastExtraction: decision.toolCallsSinceLastExtraction,
      extractorSessionId,
      signal,
    }));
  }

  private async executeSessionMemoryExtraction(input: {
    readonly sessionId: SessionId;
    readonly turnId?: TurnId;
    readonly sourceSequence: number;
    readonly sourceMessageId?: string;
    readonly messages: readonly ChatMessage[];
    readonly memory?: Awaited<ReturnType<NonNullable<SessionMemoryStore["get"]>>>;
    readonly trigger: "initialization" | "threshold" | "natural_break";
    readonly estimatedTokens: number;
    readonly toolCallsSinceLastExtraction: number;
    readonly extractorSessionId: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    try {
      const memoryPath = this.sessionMemory?.memoryPath === undefined ? undefined : await this.sessionMemory.memoryPath(String(input.sessionId));
      const memoryFileGuard = memoryPath === undefined ? undefined : createSessionMemoryFileWriteGuard(memoryPath);
      const result = await this.sessionMemoryExtractor!.extract({
        sessionId: String(input.sessionId),
        sourceSequence: input.sourceSequence,
        ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
        messages: input.messages,
        ...(input.memory === undefined ? {} : { currentMemory: input.memory }),
        trigger: input.trigger,
        estimatedTokens: input.estimatedTokens,
        toolCallsSinceLastExtraction: input.toolCallsSinceLastExtraction,
        signal: input.signal,
        ...(memoryPath === undefined ? {} : { memoryPath }),
        ...(memoryFileGuard === undefined ? {} : { memoryFileGuard }),
        capabilities: { canReadSessionMemory: true, canWriteSessionMemory: true, canUseParentTools: false, canWriteWorkspace: false, canExecute: false },
      });
      if (input.signal.aborted) throw input.signal.reason ?? new Error("Session memory extraction cancelled");
      const snapshot = result.snapshot;
      if (snapshot === undefined || snapshot.content.trim().length === 0) throw new Error("SESSION_MEMORY_EXTRACTION_EMPTY");
      const config = normalizeExtractionConfig(this.sessionMemoryExtraction);
      const content = snapshot.content.length <= config.maxMemoryChars ? snapshot.content : snapshot.content.slice(0, config.maxMemoryChars);
      const lastSummarizedMessageId = result.lastSummarizedMessageId ?? snapshot.lastSummarizedMessageId ?? input.sourceMessageId;
      const updatedAt = new Date().toISOString();
      await this.sessionMemory!.save!(String(input.sessionId), {
        content,
        ...(lastSummarizedMessageId === undefined ? {} : { lastSummarizedMessageId }),
        updatedAt,
      });
      await this.options.store.append({
        sessionId: input.sessionId,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        type: "context/session_memory_extraction_completed",
        payload: {
          initialized: true,
          sourceSequence: input.sourceSequence,
          ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
          ...(lastSummarizedMessageId === undefined ? {} : { lastExtractedMessageId: lastSummarizedMessageId }),
          lastExtractedTokens: result.tokensAtExtraction ?? input.estimatedTokens,
          toolCallsSinceLastExtraction: input.toolCallsSinceLastExtraction,
          trigger: input.trigger,
          extractorSessionId: input.extractorSessionId,
          completedAt: updatedAt,
          memoryChars: content.length,
          memoryUpdatedAt: updatedAt,
        },
      });
    } catch (error) {
      const cancelled = input.signal.aborted || (error instanceof Error && error.message.toLowerCase().includes("cancel"));
      await this.options.store.append({
        sessionId: input.sessionId,
        ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
        type: cancelled ? "context/session_memory_extraction_cancelled" : "context/session_memory_extraction_failed",
        payload: {
          initialized: true,
          sourceSequence: input.sourceSequence,
          ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
          lastExtractedTokens: input.estimatedTokens,
          toolCallsSinceLastExtraction: input.toolCallsSinceLastExtraction,
          trigger: input.trigger,
          extractorSessionId: input.extractorSessionId,
          ...(cancelled ? {} : { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) }),
        },
      });
    }
  }

  private async recordSessionMemoryExtractionFailure(sessionId: SessionId, turnId: TurnId | undefined, error: unknown): Promise<void> {
    await this.options.store.append({
      sessionId,
      ...(turnId === undefined ? {} : { turnId }),
      type: "context/session_memory_extraction_failed",
      payload: { initialized: true, lastExtractedTokens: 0, toolCallsSinceLastExtraction: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) },
    });
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
    const replacements = new Map<string, ToolResultReplacementRecord>();
    const projection = await this.options.store.project(sessionId);
    const workspaceRoot = projection === undefined ? "." : effectiveWorkspaceRoot(projection);
    for (const event of await this.options.store.list(sessionId)) {
      if (beforeTurnId !== undefined && event.type === "user/message" && event.turnId === beforeTurnId) break;
      if (event.type === "user/message" || event.type === "turn/steered") {
        const content = event.payload["content"];
        if (typeof content === "string") messages.push({ role: "user", content, messageId: event.eventId });
      } else if (event.type === "assistant/message") {
        const content = typeof event.payload["content"] === "string" ? event.payload["content"] as string : "";
        const toolCalls = parseModelToolCalls(event.payload["toolCalls"]);
        const responseId = typeof event.payload["responseId"] === "string" ? event.payload["responseId"] : undefined;
        if (content.length > 0 || toolCalls.length > 0) messages.push({ role: "assistant", content, messageId: event.eventId, ...(toolCalls.length === 0 ? {} : { toolCalls }), ...(responseId === undefined ? {} : { responseId }) });
      } else if (event.type === "tool/result") {
        const rawToolCallId = event.payload["toolCallId"];
        if (typeof rawToolCallId !== "string") continue;
        const rawResult = event.payload["result"];
        const result = rawResult !== undefined ? rawResult as ToolResult : undefined;
        messages.push({ role: "tool", toolCallId: rawToolCallId, messageId: event.eventId, content: modelToolResult({ toolCallId: brand<string, "ToolCallId">(rawToolCallId), status: event.payload["status"] === "completed" ? "completed" : event.payload["status"] === "cancelled" ? "cancelled" : event.payload["status"] === "denied" ? "denied" : "failed", ...(result === undefined ? {} : { result }) }) });
      } else if (event.type === "context/tool_result_persisted") {
        const replacement = replacementFromPayload(event.payload);
        if (replacement !== undefined) replacements.set(replacement.toolCallId, replacement);
      }
    }
    const replaced = await Promise.all(messages.map(async (message): Promise<ChatMessage> => {
      if (message.role !== "tool") return message;
      const replacement = replacements.get(message.toolCallId);
      if (replacement === undefined) return message;
      return { ...message, content: buildToolResultModelView(replacement, replacement.reason !== "persistence-failed" && await this.artifactExists(workspaceRoot, replacement.relativePath)) };
    }));
    const restored = restoreModelViewFromTranscript({
      transcript: replaced,
      ...(projection?.contextCompaction?.boundary === undefined ? {} : { boundary: projection.contextCompaction.boundary }),
      ...(projection?.contextTranscript === undefined ? {} : { segment: projection.contextTranscript }),
      ...(projection?.contextCompaction?.summary === undefined ? {} : { summary: projection.contextCompaction.summary }),
    });
    return restored.messages;
  }

  private async artifactExists(workspaceRoot: string, relativePath: string): Promise<boolean> {
    try {
      const resolver = new WorkspaceResolver(workspaceRoot);
      await resolver.resolveExisting(relativePath);
      return true;
    } catch {
      return false;
    }
  }

  private async recordSessionRestore(sessionId: SessionId, turnId: TurnId, messages: readonly ChatMessage[]): Promise<void> {
    const marker = messages.find((message) => message.role === "system" && message.contextBoundary !== undefined);
    if (marker?.role !== "system" || marker.contextBoundary === undefined) return;
    const boundary = marker.contextBoundary;
    await this.options.store.append({
      sessionId,
      turnId,
      type: "context/session_restored",
      payload: {
        mode: "boundary",
        boundaryId: boundary.id,
        ...(boundary.algorithmVersion === undefined ? { algorithmVersion: "legacy-boundary-v1" } : { algorithmVersion: boundary.algorithmVersion }),
        sourceSequence: boundary.sourceSequence,
        reason: "durable_boundary_replay",
      },
    });
  }

  private async systemMessage(sessionId: SessionId, recovery = false): Promise<string> {
    return (await this.assembleTurnContext(sessionId, [], recovery)).systemPrompt;
  }

  /** Builds the one canonical model-visible context for a turn/step. */
  private async assembleTurnContext(
    sessionId: SessionId,
    history: readonly ChatMessage[],
    recovery = false,
    turnId?: TurnId,
  ): Promise<ContextAssembly> {
    const projection = await this.options.store.project(sessionId);
    const tenantId = projection?.ownership?.tenantId;
    const tools = this.toolRuntime.listTools(sessionId, tenantId);
    const attachments = await this.postCompactAttachmentsForSession(sessionId, history, projection);
    const projectMemory = await this.projectMemoryContext(sessionId, history, projection, turnId);
    return assembleContext({
      systemSections: buildAgentSystemPromptSections({
        workspaceRoot: projection === undefined ? "." : effectiveWorkspaceRoot(projection),
        tools,
        toolGuidance: this.toolPromptRegistry.assemble(tools),
        permissionPreset: projection?.permissionPreset ?? this.permissionPreset ?? "ask-on-write",
        ...(this.customSystemPrompt === undefined ? {} : { customInstructions: this.customSystemPrompt }),
        ...(projectMemory.prompt === undefined ? {} : { projectMemoryPrompt: projectMemory.prompt }),
        ...(recovery ? { recovery: true } : {}),
      }),
      visibleTools: this.modelTools(sessionId, tenantId),
      history: history.filter((message) => message.role !== "system" || message.contextBoundary !== undefined),
      ...(attachments.length === 0 && projectMemory.attachments.length === 0 ? {} : { attachments: [...attachments, ...projectMemory.attachments] }),
    });
  }

  private async projectMemoryContext(
    sessionId: SessionId,
    history: readonly ChatMessage[],
    projection: SessionProjection | undefined,
    turnId?: TurnId,
  ): Promise<{ readonly prompt?: string; readonly attachments: readonly ContextAttachment[] }> {
    if (this.projectMemory === undefined || projection === undefined) return { attachments: [] };
    const query = latestProjectMemoryQuery(history);
    const stateKey = `${String(sessionId)}:${turnId === undefined ? "system" : String(turnId)}`;
    const current = this.projectMemoryTurnStates.get(stateKey) ?? { loaded: false, surfacedIds: new Set<string>(), staleIds: new Set<string>(), cachedTopics: new Map<string, ProjectMemoryTopic>(), disabled: false };
    if (shouldIgnoreProjectMemory(query)) {
      if (!current.disabled) {
        await this.appendProjectMemoryEvent(sessionId, turnId, "context/project_memory_disabled", {
          scopeKey: projectMemoryScope(projection, this.projectMemoryScopeKey),
          entrypointName: "MEMORY.md",
          ignored: true,
          reason: "user_requested_ignore",
        });
        this.projectMemoryTurnStates.set(stateKey, { ...current, disabled: true });
      }
      return { attachments: [] };
    }
    if (current.disabled) return { attachments: [] };

    const scope = createProjectMemoryScope(sessionId, projection, this.projectMemoryScopeKey);
    let entrypoint;
    let headers;
    try {
      [entrypoint, headers] = await Promise.all([
        this.projectMemory.getEntrypoint(scope),
        this.projectMemory.listTopics(scope),
      ]);
    } catch (error) {
      await this.appendProjectMemoryEvent(sessionId, turnId, "context/project_memory_disabled", {
        scopeKey: scope.scopeKey,
        entrypointName: "MEMORY.md",
        ignored: true,
        reason: `load_failed:${boundedError(error)}`,
      });
      this.projectMemoryTurnStates.set(stateKey, { ...current, disabled: true });
      return { attachments: [] };
    }

    const bounded = truncateProjectMemoryEntrypoint(entrypoint?.content ?? "");
    if (!current.loaded) {
      await this.appendProjectMemoryEvent(sessionId, turnId, "context/project_memory_loaded", {
        scopeKey: scope.scopeKey,
        entrypointName: "MEMORY.md",
        entrypointBytes: bounded.byteCount,
        entrypointLines: bounded.lineCount,
        truncated: bounded.wasLineTruncated || bounded.wasByteTruncated,
        topicCount: headers.length,
        ignored: false,
      });
      this.projectMemoryTurnStates.set(stateKey, { ...current, loaded: true });
    }

    const recallOptions = {
      alreadySurfacedIds: current.surfacedIds,
      ...(this.projectMemoryValidation === undefined ? {} : { validate: (topic: Parameters<typeof validateProjectMemoryTopic>[0], scoped: ProjectMemoryScope) => validateProjectMemoryTopic(topic, this.projectMemoryValidation!, scoped) }),
    };
    const recall = await recallRelevantProjectMemory(this.projectMemory, scope, query, recallOptions);
    const nextSurfaced = new Set(current.surfacedIds);
    const nextCachedTopics = new Map(current.cachedTopics);
    for (const topic of recall.topics) nextSurfaced.add(topic.id);
    for (const topic of recall.topics) nextCachedTopics.set(topic.id, topic);
    for (const topicId of recall.staleTopicIds) nextSurfaced.add(topicId);
    const staleIds = new Set(current.staleIds);
    const newStaleIds = recall.staleTopicIds.filter((topicId) => !staleIds.has(topicId));
    for (const topicId of newStaleIds) staleIds.add(topicId);
    const newTopicIds = recall.topics.map((topic) => topic.id).filter((topicId) => !current.surfacedIds.has(topicId));
    if (newTopicIds.length > 0) {
      await this.appendProjectMemoryEvent(sessionId, turnId, "context/project_memory_recalled", {
        scopeKey: scope.scopeKey,
        entrypointName: "MEMORY.md",
        entrypointBytes: bounded.byteCount,
        entrypointLines: bounded.lineCount,
        truncated: bounded.wasLineTruncated || bounded.wasByteTruncated,
        topicCount: headers.length,
        recalledTopicIds: newTopicIds,
        ignored: false,
      });
    }
    if (newStaleIds.length > 0) {
      await this.appendProjectMemoryEvent(sessionId, turnId, "context/project_memory_stale", {
        scopeKey: scope.scopeKey,
        entrypointName: "MEMORY.md",
        entrypointBytes: bounded.byteCount,
        entrypointLines: bounded.lineCount,
        truncated: bounded.wasLineTruncated || bounded.wasByteTruncated,
        topicCount: headers.length,
        staleTopicIds: newStaleIds,
        ignored: false,
        reason: "references_not_found",
      });
    }
    this.projectMemoryTurnStates.set(stateKey, { ...current, loaded: true, surfacedIds: nextSurfaced, staleIds, cachedTopics: nextCachedTopics });
    return {
      prompt: buildProjectMemoryPrompt({ scope, ...(entrypoint === undefined ? {} : { entrypoint }) }),
      attachments: [...nextCachedTopics.values()].filter((topic) => !staleIds.has(topic.id)).map((topic) => ({
        id: `project-memory:${scope.scopeKey}:${topic.id}`,
        kind: "memory" as const,
        content: `type=${topic.type ?? "project"}\ntitle=${topic.title}\npath=${topic.path}\n${topic.content}`,
      })),
    };
  }

  private async appendProjectMemoryEvent(
    sessionId: SessionId,
    turnId: TurnId | undefined,
    type: "context/project_memory_loaded" | "context/project_memory_recalled" | "context/project_memory_stale" | "context/project_memory_disabled",
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      await this.options.store.append({ sessionId, ...(turnId === undefined ? {} : { turnId }), type, payload });
    } catch {
      // Project Memory is optional context; an adapter/diagnostic write failure
      // must not turn a normal user request into a failed turn.
    }
  }

  private clearProjectMemoryTurnState(sessionId: SessionId, turnId: TurnId): void {
    this.projectMemoryTurnStates.delete(`${String(sessionId)}:${String(turnId)}`);
  }

  private async prepareModelContext(
    sessionId: SessionId,
    turnId: TurnId,
    assembly: ContextAssembly,
    protectedToolCallIds: ReadonlySet<string> = new Set<string>(),
    toolResultTimestamps: Readonly<Record<string, string>> = {},
    alreadyClearedToolCallIds: ReadonlySet<string> = new Set<string>(),
    replacementState?: ToolResultBudgetState,
  ): Promise<PreparedModelContext> {
    const normalized = normalizeMessagesForAPI(assembly.modelView.messages, { mode: this.messageValidationMode });
    const paired = ensureToolResultPairing(normalized.messages, { mode: this.messageValidationMode });
    if (this.messageValidationMode === "strict" && (!normalized.report.valid || !paired.report.valid)) {
      const codes = [...normalized.report.issues.map((issue) => issue.code), ...paired.report.issues.map((issue) => issue.code)];
      throw new Error(`MODEL_MESSAGE_VALIDATION_FAILED: ${codes.join(",") || "unknown"}`);
    }
    const persisted = await this.persistToolResultMessages(sessionId, turnId, paired.messages);
    if (replacementState !== undefined) hydrateToolResultBudgetState(replacementState, persisted);
    const budgeted = await applyToolResultBudgetAsync(persisted, {
      policy: this.toolResultBudgetWithLegacyFallback(),
      protectedToolCallIds,
      toolResultTimestamps,
      alreadyClearedToolCallIds,
      ...(replacementState === undefined ? {} : { replacementState }),
      persistToolResult: async ({ toolCallId, toolName, content }) => this.persistToolResultForBudget(sessionId, toolCallId, toolName, content),
    });
    return {
      view: { messages: budgeted.messages, ...(assembly.modelView.tools === undefined ? {} : { tools: assembly.modelView.tools }) },
      rounds: groupMessagesByApiRound(budgeted.messages),
      normalization: normalized.report,
      pairing: paired.report,
      toolResultBudget: budgeted.report,
      newlyPersistedToolResultReplacements: budgeted.newlyPersistedReplacements ?? [],
    };
  }

  private async persistToolResultForBudget(sessionId: SessionId, toolCallId: string, toolName: string | undefined, content: string) {
    const projection = await this.options.store.project(sessionId);
    const workspaceRoot = projection === undefined ? "." : effectiveWorkspaceRoot(projection);
    return this.toolResultStorage.persist({
      sessionId: String(sessionId),
      workspaceRoot,
      toolCallId,
      ...(toolName === undefined ? {} : { toolName }),
      content,
      forcePersist: true,
    });
  }

  private async persistToolResultMessages(sessionId: SessionId, turnId: TurnId, messages: readonly ChatMessage[]): Promise<readonly ChatMessage[]> {
    const projection = await this.options.store.project(sessionId);
    const workspaceRoot = projection === undefined ? "." : effectiveWorkspaceRoot(projection);
    const existing = new Map<string, ToolResultReplacementRecord>();
    const completeResults = new Map<string, string>();
    for (const event of await this.options.store.list(sessionId)) {
      if (event.type === "context/tool_result_persisted") {
        const replacement = replacementFromPayload(event.payload);
        if (replacement !== undefined) existing.set(replacement.toolCallId, replacement);
      } else if (event.type === "tool/result") {
        const rawToolCallId = event.payload["toolCallId"];
        const rawResult = event.payload["result"];
        if (typeof rawToolCallId === "string" && rawResult !== undefined) {
          completeResults.set(rawToolCallId, modelToolResult({ toolCallId: brand<string, "ToolCallId">(rawToolCallId), status: "completed", result: rawResult as ToolResult }, true));
        }
      }
    }
    const toolNames = new Map<string, string>();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
    }
    const next: ChatMessage[] = [];
    for (const message of messages) {
      if (message.role !== "tool") {
        next.push(message);
        continue;
      }
      const previous = existing.get(message.toolCallId);
      if (previous !== undefined) {
        next.push({ ...message, content: buildToolResultModelView(previous, previous.reason !== "persistence-failed" && await this.artifactExists(workspaceRoot, previous.relativePath)) });
        continue;
      }
      const toolName = toolNames.get(message.toolCallId);
      const outcome = await this.toolResultStorage.persist({
        sessionId: String(sessionId),
        workspaceRoot,
        toolCallId: message.toolCallId,
        ...(toolName === undefined ? {} : { toolName }),
        content: completeResults.get(message.toolCallId) ?? message.content,
      });
      if (outcome.replacement !== undefined) {
        const replacement = outcome.replacement;
        await this.options.store.append({ sessionId, turnId, type: "context/tool_result_persisted", payload: replacement as unknown as Readonly<Record<string, unknown>> });
        existing.set(replacement.toolCallId, replacement);
      }
      next.push(outcome.status === "persisted" || outcome.status === "failed" ? { ...message, content: outcome.modelView } : message);
    }
    return next;
  }

  private toolResultBudgetWithLegacyFallback(): ToolResultBudgetPolicy {
    try {
      if (this.toolResultBudget?.maxResultChars !== undefined || this.contextBudget?.maxToolResultChars === undefined) return { ...(this.toolResultBudget ?? {}) };
      return { ...(this.toolResultBudget ?? {}), maxResultChars: this.contextBudget.maxToolResultChars };
    } catch {
      return { ...(this.toolResultBudget ?? {}) };
    }
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
    void this.runTurn(sessionId, pending.turnId, controller, pending.previousMessages, pending.content, pending.reasoningEffort, pending.userMessageId).finally(() => {
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
    userMessageId?: string,
  ): Promise<void> {
    try {
      this.metricCounters.turnsStarted += 1;
      const traceId = `trace_${randomUUID()}`;
      this.turnTraces.set(turnId, traceId);
      const projection = await this.options.store.project(sessionId);
      const binding = this.modelBindingForSession(sessionId, projection);
      const route = binding?.route ?? this.modelRouteForTenant(projection?.ownership?.tenantId);
      const selectedReasoning = reasoningEffort ?? binding?.selection.reasoningEffort;
      await this.options.store.append({ sessionId, turnId, type: "turn/started", payload: { traceId, ...(route === undefined ? {} : route), ...(binding?.selection === undefined ? {} : binding.selection), ...(selectedReasoning === undefined ? {} : { reasoningEffort: selectedReasoning }) } });
      await this.recordSessionRestore(sessionId, turnId, previousMessages);
      const assembly = await this.assembleTurnContext(sessionId, [...previousMessages, { role: "user", content, ...(userMessageId === undefined ? { messageId: String(turnId) } : { messageId: userMessageId }) }], false, turnId);
      const messages: ChatMessage[] = [...assembly.messages];
      await this.runSteps(sessionId, turnId, controller, messages, selectedReasoning, false, binding?.model, binding?.route?.contextCapability);
      this.scheduleSessionMemoryExtraction(sessionId, turnId);
    } catch (error) {
      await this.finishTurnAfterError(sessionId, turnId, controller, error);
    } finally {
      this.turnTraces.delete(turnId);
      this.clearProjectMemoryTurnState(sessionId, turnId);
    }
  }

  private async runRecoveredTurn(sessionId: SessionId, turnId: TurnId, controller: AbortController): Promise<void> {
    try {
      this.metricCounters.turnsStarted += 1;
      const traceId = `trace_${randomUUID()}`;
      this.turnTraces.set(turnId, traceId);
      const projection = await this.options.store.project(sessionId);
      const binding = this.modelBindingForSession(sessionId, projection);
      const route = binding?.route ?? this.modelRouteForTenant(projection?.ownership?.tenantId);
      await this.options.store.append({ sessionId, turnId, type: "agent/status", payload: { status: "running", reason: "permission_resolved_after_restart", traceId, ...(route === undefined ? {} : route), ...(binding?.selection === undefined ? {} : binding.selection) } });
      const previousMessages = await this.conversationMessages(sessionId);
      await this.recordSessionRestore(sessionId, turnId, previousMessages);
      const assembly = await this.assembleTurnContext(sessionId, previousMessages, true, turnId);
      const messages: ChatMessage[] = [...assembly.messages];
      await this.runSteps(sessionId, turnId, controller, messages, binding?.selection.reasoningEffort, true, binding?.model, binding?.route?.contextCapability);
      this.scheduleSessionMemoryExtraction(sessionId, turnId);
    } catch (error) {
      await this.finishTurnAfterError(sessionId, turnId, controller, error);
    } finally {
      this.turnTraces.delete(turnId);
      this.clearProjectMemoryTurnState(sessionId, turnId);
    }
  }

  private async runSteps(sessionId: SessionId, turnId: TurnId, controller: AbortController, messages: ChatMessage[], reasoningEffort?: string, recovery = false, turnModel?: ChatModel, turnCapability?: ModelContextCapability): Promise<void> {
    const alreadyClearedToolCallIds = new Set<string>();
    const reportedBudgetToolCallIds = new Set<string>();
    const reportedMicrocompactToolCallIds = new Set<string>();
    const replacementState = createToolResultBudgetState(messages);
    const recoveryGuard = new ContextRecoveryGuard(
      this.contextRecovery?.maxReactiveAttempts ?? 1,
      this.contextRecovery?.maxConsecutiveCompactionFailures ?? 3,
    );
    let step = 1;
    while (true) {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Cancelled");
      this.appendSteers(messages, turnId);
      const projection = await this.options.store.project(sessionId);
      const tenantId = projection?.ownership?.tenantId;
      const primaryModel = turnModel ?? this.modelForTenant(tenantId);
      const budgetSnapshot = this.contextBudgetSnapshotForModel(primaryModel, turnCapability);
      let assembly = await this.assembleTurnContext(sessionId, messages, recovery, turnId);
      const protectedToolCallIds = pendingToolCallIds(projection);
      const toolResultTimestamps = await this.toolResultTimestamps(sessionId);
      let prepared = await this.prepareModelContext(sessionId, turnId, assembly, protectedToolCallIds, toolResultTimestamps, alreadyClearedToolCallIds, replacementState);
      await this.appendToolResultReplacementEvents(sessionId, turnId, prepared.newlyPersistedToolResultReplacements);
      await this.appendToolResultBudgetEvents(sessionId, turnId, prepared.toolResultBudget, this.toolResultBudgetWithLegacyFallback(), reportedBudgetToolCallIds, reportedMicrocompactToolCallIds, alreadyClearedToolCallIds);
      const beforeView: ModelContextView = prepared.view;
      const tokenCounter = createTokenCounter(primaryModel);
      const estimate = tokenCounter.estimate(beforeView);
      const tokenCount = await countContextTokens(tokenCounter, beforeView, {
        preferExact: shouldUseExactTokenCount(estimate, budgetSnapshot, this.contextPolicyWithLegacyFallback()),
        signal: controller.signal,
      });
      const beforeUsage = tokenCount.value;
      const beforeState = calculateContextWarningState(beforeUsage, budgetSnapshot, this.contextPolicyWithLegacyFallback());
      const autoCompactRecommended = shouldCompactBeforeRequest(beforeState, this.contextPolicyWithLegacyFallback());
      if (this.compactionEnabled && autoCompactRecommended && !recoveryGuard.isCircuitOpen()) {
        const proactiveRequestHash = fingerprintModelRequest({ purpose: "agent", messages: prepared.view.messages, tools: prepared.view.tools, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
        const proactiveAttempt = recoveryGuard.snapshot().consecutiveCompactionFailures + 1;
        await this.appendContextRecoveryEvent(sessionId, turnId, "context/recovery_started", {
          requestHash: proactiveRequestHash,
          errorClass: "other" as ContextRecoveryErrorClass,
          attempt: proactiveAttempt,
          attemptedModules: ["proactive_compact"],
          transitionReason: "proactive_compact",
        });
        const compacted = await this.compactTurnContext(sessionId, turnId, messages, budgetSnapshot, beforeUsage, beforeState, controller.signal, primaryModel);
        if (compacted) {
          recoveryGuard.recordCompactionSuccess("proactive_compact");
          await this.appendContextRecoveryEvent(sessionId, turnId, "context/recovery_succeeded", {
            requestHash: proactiveRequestHash,
            errorClass: "other" as ContextRecoveryErrorClass,
            attempt: proactiveAttempt,
            attemptedModules: recoveryGuard.snapshot().attemptedModules,
            transitionReason: "proactive_compact",
          });
        } else {
          const circuitOpen = recoveryGuard.recordCompactionFailure("proactive_compact");
          await this.appendContextRecoveryEvent(sessionId, turnId, "context/recovery_failed", {
            requestHash: proactiveRequestHash,
            errorClass: "other" as ContextRecoveryErrorClass,
            attempt: proactiveAttempt,
            attemptedModules: recoveryGuard.snapshot().attemptedModules,
            transitionReason: "proactive_compact_failed",
            error: "Context compaction did not produce a smaller model view",
          });
          if (circuitOpen) {
            await this.appendContextRecoveryEvent(sessionId, turnId, "context/recovery_circuit_open", {
              requestHash: proactiveRequestHash,
              errorClass: "other" as ContextRecoveryErrorClass,
              attempt: proactiveAttempt,
              attemptedModules: recoveryGuard.snapshot().attemptedModules,
              transitionReason: "compact_failure_circuit_open",
            });
          }
        }
        assembly = await this.assembleTurnContext(sessionId, messages, recovery, turnId);
        prepared = await this.prepareModelContext(sessionId, turnId, assembly, protectedToolCallIds, toolResultTimestamps, alreadyClearedToolCallIds, replacementState);
        await this.appendToolResultReplacementEvents(sessionId, turnId, prepared.newlyPersistedToolResultReplacements);
        await this.appendToolResultBudgetEvents(sessionId, turnId, prepared.toolResultBudget, this.toolResultBudgetWithLegacyFallback(), reportedBudgetToolCallIds, reportedMicrocompactToolCallIds, alreadyClearedToolCallIds);
      }
      if (prepared.normalization.changed) {
        await this.options.store.append({
          sessionId,
          turnId,
          type: "context/messages_normalized",
          payload: {
            mode: prepared.normalization.mode,
            issueCodes: prepared.normalization.issues.map((issue) => issue.code),
            mergedAssistantMessages: prepared.normalization.mergedAssistantMessages,
            droppedToolCalls: prepared.normalization.droppedToolCalls,
            droppedToolResults: prepared.normalization.droppedToolResults,
          },
        });
      }
      if (prepared.pairing.repaired) {
        await this.options.store.append({
          sessionId,
          turnId,
          type: "context/tool_pairing_repaired",
          payload: {
            mode: prepared.pairing.mode,
            issueCodes: prepared.pairing.issues.map((issue) => issue.code),
            syntheticResultCount: prepared.pairing.syntheticResultCount,
            removedOrphanResultCount: prepared.pairing.removedOrphanResultCount,
            removedDuplicateCallCount: prepared.pairing.removedDuplicateCallCount,
          },
        });
      }
      let finalCount = tokenCount;
      if (autoCompactRecommended) {
        finalCount = await countContextTokens(tokenCounter, prepared.view, { signal: controller.signal });
      }
      const tokenUsage = finalCount.value;
      const warningState = calculateContextWarningState(tokenUsage, budgetSnapshot, this.contextPolicyWithLegacyFallback());
      const modelRequestId = `request_${randomUUID()}`;
      await this.options.store.append({
        sessionId,
        turnId,
        type: "step/started",
        payload: {
          step,
          contextBudget: publicContextBudgetSnapshot(budgetSnapshot),
          contextWarning: warningState,
          tokenCount: publicTokenCount(finalCount),
          contextAssembly: publicContextAssembly(assembly),
          messageValidation: publicMessageValidation(prepared),
          toolResultBudget: publicToolResultBudget(prepared.toolResultBudget, this.toolResultBudgetWithLegacyFallback()),
          modelRequestId,
          ...(autoCompactRecommended ? { autoCompactRecommended: true } : {}),
        },
      });
      let response: CollectedModelResponse;
      try {
        response = await this.collectModelResponse(sessionId, turnId, controller, prepared.view, tenantId, modelRequestId, reasoningEffort, primaryModel);
      } catch (error) {
        const classified = classifyProviderContextError(error);
        const requestHash = fingerprintModelRequest({ purpose: "agent", messages: prepared.view.messages, tools: prepared.view.tools, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
        const partialOutput = typeof error === "object" && error !== null && "partialOutput" in error && (error as { partialOutput?: unknown }).partialOutput === true;
        if (isReactiveContextError(error) && !partialOutput && this.compactionEnabled && !recoveryGuard.isCircuitOpen()) {
          const attempt = recoveryGuard.beginReactive("reactive_compact");
          if (attempt !== undefined) {
            await this.appendContextRecoveryEvent(sessionId, turnId, "context/recovery_started", {
              requestHash,
              errorClass: classified.errorClass,
              ...(classified.status === undefined ? {} : { providerStatus: classified.status }),
              ...((classified.providerCode ?? classified.code) === undefined ? {} : { providerCode: classified.providerCode ?? classified.code }),
              attempt,
              attemptedModules: recoveryGuard.snapshot().attemptedModules,
              transitionReason: "reactive_compact_retry",
            });
            const compacted = await this.compactTurnContext(sessionId, turnId, messages, budgetSnapshot, beforeUsage, beforeState, controller.signal, primaryModel);
            if (compacted) {
              recoveryGuard.recordCompactionSuccess("reactive_compact");
              await this.appendContextRecoveryEvent(sessionId, turnId, "context/recovery_transition", {
                requestHash,
                errorClass: classified.errorClass,
                ...(classified.status === undefined ? {} : { providerStatus: classified.status }),
                ...((classified.providerCode ?? classified.code) === undefined ? {} : { providerCode: classified.providerCode ?? classified.code }),
                attempt,
                attemptedModules: recoveryGuard.snapshot().attemptedModules,
                transitionReason: "reactive_compact_retry",
              });
              await this.appendContextRecoveryEvent(sessionId, turnId, "context/recovery_succeeded", {
                requestHash,
                errorClass: classified.errorClass,
                ...(classified.status === undefined ? {} : { providerStatus: classified.status }),
                ...((classified.providerCode ?? classified.code) === undefined ? {} : { providerCode: classified.providerCode ?? classified.code }),
                attempt,
                attemptedModules: recoveryGuard.snapshot().attemptedModules,
                transitionReason: "reactive_compact_retry",
              });
              await this.options.store.append({ sessionId, turnId, type: "step/ended", payload: { step, status: "recovered", recovery: "reactive_compact" } });
              step += 1;
              continue;
            }
            const circuitOpen = recoveryGuard.recordCompactionFailure("reactive_compact");
            await this.appendContextRecoveryEvent(sessionId, turnId, "context/recovery_failed", {
              requestHash,
              errorClass: classified.errorClass,
              ...(classified.status === undefined ? {} : { providerStatus: classified.status }),
              ...((classified.providerCode ?? classified.code) === undefined ? {} : { providerCode: classified.providerCode ?? classified.code }),
              attempt,
              attemptedModules: recoveryGuard.snapshot().attemptedModules,
              transitionReason: "reactive_compact_failed",
              error: "Reactive context compaction did not recover the request",
            });
            if (circuitOpen) {
              await this.appendContextRecoveryEvent(sessionId, turnId, "context/recovery_circuit_open", {
                requestHash,
                errorClass: classified.errorClass,
                ...(classified.status === undefined ? {} : { providerStatus: classified.status }),
                ...((classified.providerCode ?? classified.code) === undefined ? {} : { providerCode: classified.providerCode ?? classified.code }),
                attempt,
                attemptedModules: recoveryGuard.snapshot().attemptedModules,
                transitionReason: "compact_failure_circuit_open",
              });
            }
          }
        }
        throw error;
      }
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("Cancelled");
      const assistantPayload = {
        content: response.text,
        responseId: response.responseId,
        requestId: modelRequestId,
        ...(response.toolCalls.length === 0 ? {} : { toolCalls: response.toolCalls }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      };
      const assistantEvent = await this.options.store.append({ sessionId, turnId, type: "assistant/message", payload: assistantPayload });
      const steersAfterResponse = this.takeSteers(turnId);
      if (response.toolCalls.length === 0) {
        if (steersAfterResponse.length > 0) {
          messages.push({ role: "assistant", content: response.text, responseId: response.responseId, messageId: assistantEvent.eventId });
          for (const steer of steersAfterResponse) messages.push({ role: "user", content: steer });
          await this.options.store.append({ sessionId, turnId, type: "step/ended", payload: { step, status: "steered" } });
          step += 1;
          continue;
        }
        await this.options.store.append({ sessionId, turnId, type: "step/ended", payload: { step, status: "completed" } });
        await this.options.store.append({ sessionId, turnId, type: "turn/ended", payload: { status: "completed", ...(this.turnTraces.get(turnId) === undefined ? {} : { traceId: this.turnTraces.get(turnId) }) } });
        this.metricCounters.turnsCompleted += 1;
        return;
      }
      messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls, responseId: response.responseId, messageId: assistantEvent.eventId });
      for (const steer of steersAfterResponse) messages.push({ role: "user", content: steer });
      const scheduled = await scheduleToolCalls({
        calls: response.toolCalls,
        executionMode: (toolCall) => {
          try { return this.toolRuntime.registry.get(toolCall.name).executionMode; }
          catch { return "exclusive"; }
        },
        execute: (toolCall) => this.executeModelToolCall(sessionId, turnId, controller, toolCall),
        skip: async (toolCall) => ({
          output: await this.syntheticToolFailure(sessionId, turnId, toolCall, "TOOL_ABORTED_BEFORE_DISPATCH", "Tool call aborted before dispatch", "cancelled"),
          deferredResult: false,
        }),
        commit: async (_toolCall, scheduledOutput) => {
          if (!scheduledOutput.deferredResult) return;
          await this.toolRuntime.commitDeferredResult(
            { sessionId, turnId },
            scheduledOutput.output,
          );
        },
        signal: controller.signal,
        maxParallelToolCalls: this.maxParallelToolCallsLimit,
      });
      const outputs = scheduled.results.map((scheduledOutput) => scheduledOutput.output);
      const toolResultEvents = await this.options.store.list(sessionId);
      const notices: { readonly content: string; readonly source: RepeatToolNotice["source"] }[] = [];
      for (let index = 0; index < outputs.length; index += 1) {
        const output = outputs[index];
        const toolCall = response.toolCalls[index];
        if (output === undefined || toolCall === undefined) throw new Error("TOOL_RESULT_MISMATCH: tool result count did not match tool call count");
        const resultEvent = [...toolResultEvents].reverse().find(event => event.turnId === turnId && event.type === "tool/result" && event.payload["toolCallId"] === toolCall.id);
        messages.push({ role: "tool", toolCallId: toolCall.id, content: modelToolResult(output), messageId: resultEvent?.eventId ?? toolCall.id });
        const notice = this.repeatToolReminder.observe(sessionId, toolCall.name, toolCall.arguments);
        if (notice !== undefined) notices.push(notice);
      }
      for (const notice of notices) {
        const noticeEvent = await this.options.store.append({
          sessionId,
          turnId,
          type: "user/message",
          payload: { content: notice.content, source: notice.source },
        });
        messages.push({ role: "user", content: notice.content, messageId: noticeEvent.eventId });
      }
      if (scheduled.aborted) {
        await this.options.store.append({ sessionId, turnId, type: "step/ended", payload: { step, status: "stopped", toolCalls: response.toolCalls.length } });
        throw controller.signal.reason ?? new Error("Cancelled");
      }
      await this.options.store.append({ sessionId, turnId, type: "step/ended", payload: { step, status: "completed", toolCalls: response.toolCalls.length } });
      step += 1;
    }
  }

  private async toolResultTimestamps(sessionId: SessionId): Promise<Readonly<Record<string, string>>> {
    const timestamps: Record<string, string> = {};
    for (const event of await this.options.store.list(sessionId)) {
      if (event.type !== "tool/result") continue;
      const toolCallId = event.payload["toolCallId"];
      if (typeof toolCallId === "string") timestamps[toolCallId] = event.createdAt;
    }
    return timestamps;
  }

  private async appendToolResultReplacementEvents(
    sessionId: SessionId,
    turnId: TurnId,
    replacements: readonly ToolResultReplacementRecord[],
  ): Promise<void> {
    for (const replacement of replacements) {
      await this.options.store.append({
        sessionId,
        turnId,
        type: "context/tool_result_persisted",
        payload: replacement as unknown as Readonly<Record<string, unknown>>,
      });
    }
  }

  private async appendToolResultBudgetEvents(
    sessionId: SessionId,
    turnId: TurnId,
    report: ToolResultBudgetReport,
    policy: ToolResultBudgetPolicy,
    reportedToolCallIds: Set<string>,
    reportedMicrocompactToolCallIds: Set<string>,
    alreadyClearedToolCallIds: Set<string>,
  ): Promise<void> {
    const newlyBoundedToolCallIds = report.boundedToolCallIds.filter((toolCallId) => !reportedToolCallIds.has(toolCallId));
    const newlyMessageBudgetReplacedToolCallIds = report.messageBudgetReplacedToolCallIds.filter((toolCallId) => !reportedToolCallIds.has(toolCallId));
    const newlyClearedToolCallIds = report.newlyClearedToolCallIds.filter((toolCallId) => !reportedMicrocompactToolCallIds.has(toolCallId));
    for (const toolCallId of newlyBoundedToolCallIds) reportedToolCallIds.add(toolCallId);
    for (const toolCallId of newlyMessageBudgetReplacedToolCallIds) reportedToolCallIds.add(toolCallId);
    for (const toolCallId of newlyClearedToolCallIds) reportedMicrocompactToolCallIds.add(toolCallId);
    for (const toolCallId of newlyClearedToolCallIds) alreadyClearedToolCallIds.add(toolCallId);
    if (newlyBoundedToolCallIds.length === 0 && newlyMessageBudgetReplacedToolCallIds.length === 0 && newlyClearedToolCallIds.length === 0) return;
    await this.options.store.append({
      sessionId,
      turnId,
      type: "context/tool_results_budgeted",
      payload: {
        boundedCount: report.boundedCount,
        boundedToolCallIds: newlyBoundedToolCallIds,
        messageBudgetReplacedToolCallIds: newlyMessageBudgetReplacedToolCallIds,
        clearedCount: report.clearedCount,
        clearedToolCallIds: newlyClearedToolCallIds,
        tokensSaved: report.tokensSaved,
        trigger: report.trigger,
        protectedToolCallIds: report.protectedToolCallIds,
        messageBudgetChars: report.messageBudgetChars,
        messageBudgetMessagesOverBudget: report.messageBudgetMessagesOverBudget,
        microcompactTrigger: report.microcompactTrigger,
        timeBasedMicrocompactEnabled: report.timeBasedMicrocompactEnabled,
        timeBasedGapMs: report.timeBasedGapMs,
      },
    });
    if (newlyClearedToolCallIds.length === 0) return;
    await this.options.store.append({
      sessionId,
      turnId,
      type: "context/microcompacted",
      payload: {
        trigger: report.trigger,
        clearedToolCallIds: report.clearedToolCallIds,
        newlyClearedToolCallIds,
        keptRecent: policy.keepRecentResults ?? 5,
        tokensSaved: report.tokensSaved,
        protectedToolCallIds: report.protectedToolCallIds,
        messageBudgetChars: report.messageBudgetChars,
        messageBudgetMessagesOverBudget: report.messageBudgetMessagesOverBudget,
        messageBudgetReplacedToolCallIds: report.messageBudgetReplacedToolCallIds,
        microcompactTrigger: report.microcompactTrigger,
        timeBasedMicrocompactEnabled: report.timeBasedMicrocompactEnabled,
        timeBasedGapMs: report.timeBasedGapMs,
      },
    });
  }

  private async compactTurnContext(
    sessionId: SessionId,
    turnId: TurnId,
    messages: ChatMessage[],
    budgetSnapshot?: ContextBudgetSnapshot,
    tokenUsage?: number,
    warningState?: ContextWarningState,
    signal?: AbortSignal,
    turnModel?: ChatModel,
  ): Promise<boolean> {
    if (!this.compactionEnabled) return false;
    const projection = await this.options.store.project(sessionId);
    const protectedToolCallIds = pendingToolCallIds(projection);
    try {
      const resolved = budgetSnapshot ?? this.contextBudgetSnapshot(projection?.ownership?.tenantId);
      const preCompactMessages = [...messages];
      const preCompactTokens = tokenUsage ?? estimateContextTokens({ messages: preCompactMessages }).value;
      const sessionMemoryResult = await this.compactWithSessionMemory(sessionId, turnId, messages, protectedToolCallIds, resolved.autoCompactThreshold);
      if (sessionMemoryResult === true) {
        await this.rebuildPostCompactView(sessionId, turnId, messages, preCompactMessages, "session_memory", preCompactTokens, projection, protectedToolCallIds);
        return true;
      }
      const summaryResult = await this.compactWithSummaryModel(sessionId, turnId, messages, protectedToolCallIds, signal, turnModel);
      if (summaryResult === true) {
        await this.rebuildPostCompactView(sessionId, turnId, messages, preCompactMessages, "summary", preCompactTokens, projection, protectedToolCallIds);
        return true;
      }
      const usage = preCompactTokens;
      const predictive = warningState?.isPredictiveCompactRecommended === true && usage < resolved.autoCompactThreshold;
      const maxTokens = predictive ? Math.max(1, usage - 1) : resolved.autoCompactThreshold;
      const compactionBudget: ContextBudget = {
        ...DEFAULT_CONTEXT_BUDGET,
        ...(this.contextBudget ?? {}),
        maxTokens,
      };
      const result = compactMessages(messages, { budget: compactionBudget, protectedToolCallIds });
      if (!result.didCompact) return false;
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
          preCompactTokens,
          postCompactTokens: result.estimatedTokens,
          tokensSaved: Math.max(0, preCompactTokens - result.estimatedTokens),
          droppedMessages: result.droppedMessages,
          protectedMessageCount: result.protectedMessageCount,
          truncatedToolResults: result.truncatedToolResults,
        },
      });
      await this.rebuildPostCompactView(sessionId, turnId, messages, preCompactMessages, "legacy", preCompactTokens, projection, protectedToolCallIds);
      return true;
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
      return false;
    }
  }

  private async rebuildPostCompactView(
    sessionId: SessionId,
    turnId: TurnId,
    messages: ChatMessage[],
    preCompactMessages: readonly ChatMessage[],
    kind: ContextBoundaryKind,
    preCompactTokens: number,
    projection: SessionProjection | undefined,
    protectedToolCallIds: ReadonlySet<string>,
  ): Promise<void> {
    const parts = splitCompactedMessages(messages);
    const boundaryId = "boundary_" + randomUUID();
    const discoveredTools = preCompactMessages.flatMap((message) => message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.name) : []);
    const boundaryOptions = {
      id: boundaryId,
      kind,
      trigger: "auto" as const,
      preCompactTokens,
      sourceSequence: projection?.lastSequence ?? 0,
      ...(preCompactMessages.at(-1)?.messageId === undefined ? {} : { lastPreCompactMessageId: preCompactMessages.at(-1)!.messageId }),
      messagesSummarized: Math.max(0, preCompactMessages.filter((message) => message.role !== "system").length - parts.preservedMessages.length),
      preCompactDiscoveredTools: discoveredTools,
      algorithmVersion: "m10.v1",
    };
    const defaultAttachments = defaultPostCompactAttachments(sessionId, projection);
    let providerAttachments: readonly ContextAttachment[] = [];
    if (this.postCompactAttachmentProvider !== undefined) {
      try {
        providerAttachments = await this.postCompactAttachmentProvider({
          sessionId: String(sessionId),
          boundaryId,
          preservedMessages: parts.preservedMessages.map((message) => ({ role: message.role, content: message.content })),
          existingAttachmentIds: extractContextAttachmentIds(parts.preservedMessages),
        });
      } catch (error) {
        await this.options.store.append({
          sessionId,
          turnId,
          type: "context/post_compact_rebuild_failed",
          payload: { boundaryId, reason: "attachment-provider-failed", error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    const rebuilt = buildPostCompactMessages({
      boundary: boundaryOptions,
      summaryMessages: parts.summaryMessages,
      preservedMessages: parts.preservedMessages,
      attachments: [...defaultAttachments, ...providerAttachments],
      ...(this.postCompactAttachmentConfig === undefined ? {} : { attachmentConfig: this.postCompactAttachmentConfig }),
    });
    messages.splice(0, messages.length, ...rebuilt.messages);
    const boundary = rebuilt.boundary.contextBoundary;
    await this.options.store.append({
      sessionId,
      turnId,
      type: "context/compact_boundary",
      payload: {
        boundary,
        kind,
        summary: parts.summaryMessages.map((message) => message.content).join("\n\n"),
        originalMessageCount: preCompactMessages.length,
        compactedMessageCount: rebuilt.messages.length,
        estimatedTokens: estimateContextTokens({ messages: rebuilt.messages }).value,
        preCompactTokens,
        postCompactTokens: estimateContextTokens({ messages: rebuilt.messages }).value,
        tokensSaved: Math.max(0, preCompactTokens - estimateContextTokens({ messages: rebuilt.messages }).value),
        droppedMessages: Math.max(0, preCompactMessages.filter((message) => message.role !== "system").length - parts.preservedMessages.length - parts.summaryMessages.length),
        protectedMessageCount: protectedToolCallIds.size,
        attachments: rebuilt.attachmentMetadata,
        droppedAttachmentIds: rebuilt.droppedAttachmentIds,
      },
    });
    const transcriptSegment = {
      version: 1 as const,
      boundaryId: boundary.id,
      algorithmVersion: boundary.algorithmVersion ?? "m10.v1",
      sourceSequence: boundary.sourceSequence,
      ...(boundary.preservedSegment?.headMessageId === undefined ? {} : { headMessageId: boundary.preservedSegment.headMessageId }),
      ...(boundary.preservedSegment?.anchorMessageId === undefined ? {} : { anchorMessageId: boundary.preservedSegment.anchorMessageId }),
      ...(boundary.preservedSegment?.tailMessageId === undefined ? {} : { tailMessageId: boundary.preservedSegment.tailMessageId }),
      createdAt: boundary.createdAt,
    };
    await this.options.store.append({ sessionId, turnId, type: "context/transcript_segment", payload: { segment: transcriptSegment } });
  }

  private async postCompactAttachmentsForSession(
    sessionId: SessionId,
    history: readonly ChatMessage[],
    projection: SessionProjection | undefined,
  ): Promise<readonly ContextAttachment[]> {
    const boundary = projection?.contextCompaction?.boundary;
    if (boundary === undefined || this.postCompactAttachmentProvider === undefined && projection?.plan.content.trim().length === 0) return [];
    const existingIds = extractContextAttachmentIds(history);
    const expectedAttachmentIds = boundary.attachmentIds ?? [];
    if (expectedAttachmentIds.length > 0 && expectedAttachmentIds.every((id) => existingIds.has(id))) return [];
    const preservedMessages = history.filter((message) => message.role !== "system");
    const defaults = defaultPostCompactAttachments(sessionId, projection);
    let provided: readonly ContextAttachment[] = [];
    if (this.postCompactAttachmentProvider !== undefined) {
      try {
        provided = await this.postCompactAttachmentProvider({
          sessionId: String(sessionId),
          boundaryId: boundary.id,
          preservedMessages: preservedMessages.map((message) => ({ role: message.role, content: message.content })),
          existingAttachmentIds: existingIds,
        });
      } catch {
        provided = [];
      }
    }
    return selectPostCompactAttachments([...defaults, ...provided], this.postCompactAttachmentConfig, existingIds).attachments;
  }

  private async compactWithSessionMemory(
    sessionId: SessionId,
    turnId: TurnId,
    messages: ChatMessage[],
    protectedToolCallIds: ReadonlySet<string>,
    autoCompactThreshold?: number,
  ): Promise<boolean> {
    if (this.sessionMemory === undefined) return false;
    let memory;
    try {
      memory = await this.sessionMemory.get(String(sessionId));
    } catch (error) {
      await this.options.store.append({
        sessionId,
        turnId,
        type: "context/session_memory_compaction_failed",
        payload: {
          sourceSequence: (await this.options.store.project(sessionId))?.lastSequence ?? 0,
          originalMessageCount: messages.length,
          compactedMessageCount: messages.length,
          droppedMessages: 0,
          reason: "memory-read-failed",
          fallback: "legacy-summary-compact",
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return false;
    }
    const result = compactWithSessionMemory(messages, {
      ...(memory === undefined ? {} : { memory }),
      ...(this.sessionMemoryCompact === undefined ? {} : { config: this.sessionMemoryCompact }),
      protectedToolCallIds,
      ...(autoCompactThreshold === undefined ? {} : { maxPostCompactTokens: autoCompactThreshold }),
    });
    if (!result.didCompact) {
      if (result.reason === "boundary-not-found") {
        await this.options.store.append({
          sessionId,
          turnId,
          type: "context/session_memory_compaction_failed",
          payload: {
            sourceSequence: (await this.options.store.project(sessionId))?.lastSequence ?? 0,
            originalMessageCount: result.originalMessageCount,
            compactedMessageCount: result.keptMessageCount,
            droppedMessages: 0,
            reason: result.reason,
            fallback: "legacy-summary-compact",
            ...(memory?.updatedAt === undefined ? {} : { memoryUpdatedAt: memory.updatedAt }),
          },
        });
      }
      return false;
    }
    const preCompactTokenEstimate = estimateContextTokens({ messages }).value;
    messages.splice(0, messages.length, ...result.messages);
    const projection = await this.options.store.project(sessionId);
    await this.options.store.append({
      sessionId,
      turnId,
      type: "context/session_memory_compacted",
      payload: {
        sourceSequence: projection?.lastSequence ?? 0,
        kind: "session_memory",
        originalMessageCount: result.originalMessageCount,
        compactedMessageCount: result.messages.length,
        estimatedTokens: result.estimatedTokens,
        preCompactTokens: preCompactTokenEstimate,
        postCompactTokens: result.estimatedTokens,
        tokensSaved: Math.max(0, preCompactTokenEstimate - result.estimatedTokens),
        droppedMessages: result.droppedMessageCount,
        protectedMessageCount: protectedToolCallIds.size,
        memoryChars: result.memoryChars,
        memoryTruncated: result.memoryTruncated,
        boundaryKnown: result.boundaryKnown,
        ...(memory?.lastSummarizedMessageId === undefined ? {} : { lastSummarizedMessageId: memory.lastSummarizedMessageId }),
        ...(memory?.updatedAt === undefined ? {} : { memoryUpdatedAt: memory.updatedAt }),
      },
    });
    return true;
  }

  private async compactWithSummaryModel(
    sessionId: SessionId,
    turnId: TurnId,
    messages: ChatMessage[],
    protectedToolCallIds: ReadonlySet<string>,
    signal?: AbortSignal,
    turnModel?: ChatModel,
  ): Promise<boolean> {
    const projection = await this.options.store.project(sessionId);
    const tenantId = projection?.ownership?.tenantId;
    await this.options.store.append({
      sessionId,
      turnId,
      type: "context/summary_started",
      payload: {
        purpose: "context_summary",
        inputMessageCount: messages.length,
        protectedToolCallCount: protectedToolCallIds.size,
        ...(this.summaryCompact === undefined ? {} : { config: this.summaryCompact }),
      },
    });
    const model = turnModel ?? this.modelForTenant(tenantId);
    const result = await compactWithSummaryModel(messages, {
      runner: (request) => this.runSummaryModel(model, request),
      ...(this.summaryCompact === undefined ? {} : { config: this.summaryCompact }),
      protectedToolCallIds,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.retries > 0) {
      await this.options.store.append({
        sessionId,
        turnId,
        type: "context/summary_retried",
        payload: {
          purpose: "context_summary",
          attempts: result.retries,
          remainingMessages: result.preservedMessageCount,
        },
      });
    }
    if (!result.didCompact) {
      if (result.reason !== "nothing-to-compact") {
        await this.options.store.append({
          sessionId,
          turnId,
          type: "context/summary_compaction_failed",
          payload: {
            sourceSequence: (await this.options.store.project(sessionId))?.lastSequence ?? 0,
            originalMessageCount: result.originalMessageCount,
            compactedMessageCount: result.compactedMessageCount,
            droppedMessages: result.droppedMessageCount,
            reason: result.reason ?? "summary-failed",
            retries: result.retries,
            fallback: "legacy-summary-compact",
            ...(result.error === undefined ? {} : { error: result.error }),
          },
        });
      }
      return false;
    }
    const preCompactTokenEstimate = estimateContextTokens({ messages }).value;
    messages.splice(0, messages.length, ...result.messages);
    await this.options.store.append({
      sessionId,
      turnId,
      type: "context/summary_compacted",
      payload: {
        sourceSequence: (await this.options.store.project(sessionId))?.lastSequence ?? 0,
        kind: "summary",
        purpose: "context_summary",
        originalMessageCount: result.originalMessageCount,
        compactedMessageCount: result.compactedMessageCount,
        estimatedTokens: result.estimatedTokens,
        preCompactTokens: preCompactTokenEstimate,
        postCompactTokens: result.estimatedTokens,
        tokensSaved: Math.max(0, preCompactTokenEstimate - result.estimatedTokens),
        droppedMessages: result.droppedMessageCount,
        preservedMessageCount: result.preservedMessageCount,
        retries: result.retries,
        ...(result.usage === undefined ? {} : { summaryUsage: result.usage }),
      },
    });
    return true;
  }

  private async runSummaryModel(model: ChatModel, request: SummaryRequest): Promise<SummaryResponse> {
    const textParts: string[] = [];
    let usage: ModelUsage | undefined;
    for await (const part of model.stream({
      purpose: request.purpose,
      messages: request.messages,
      tools: [],
      toolChoice: "none",
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })) {
      if (request.signal?.aborted) throw request.signal.reason ?? new Error("Cancelled");
      if (part.type === "text_delta") textParts.push(part.text);
      else if (part.type === "usage") usage = mergeModelUsage(usage, part.usage);
      else if (part.type === "tool_call_start" || part.type === "tool_call_delta") throw new Error("SUMMARY_TOOL_USE_DENIED: compaction summary requests cannot call tools");
      else if (part.type === "error") throw new Error(`${part.code}: ${part.message}`);
    }
    return { text: textParts.join(""), ...(usage === undefined ? {} : { usage }) };
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
      const message = sanitizeFailureMessage(error instanceof Error ? error.message : String(error));
      const classified = classifyProviderContextError(error);
      const failure = modelFailureMetadata(error);
      await this.options.store.append({ sessionId, turnId, type: "agent/error", payload: {
        message,
        failureCode: failure.code,
        retryable: failure.retryable,
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
        ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        ...(failure.partialOutput === undefined ? {} : { partialOutput: failure.partialOutput }),
        errorClass: classified.errorClass,
        ...(classified.status === undefined ? {} : { providerStatus: classified.status }),
        ...((classified.providerCode ?? classified.code) === undefined ? {} : { providerCode: classified.providerCode ?? classified.code }),
        ...(traceId === undefined ? {} : { traceId }),
      } });
      await this.options.store.append({ sessionId, turnId, type: "turn/ended", payload: { status: "failed", message, ...(traceId === undefined ? {} : { traceId }) } });
    }
  }

  private async appendContextRecoveryEvent(
    sessionId: SessionId,
    turnId: TurnId,
    type: "context/recovery_started" | "context/recovery_transition" | "context/recovery_succeeded" | "context/recovery_failed" | "context/recovery_circuit_open",
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.options.store.append({ sessionId, turnId, type, payload });
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
    view: ModelContextView,
    tenantId: string | undefined,
    requestId: string,
    reasoningEffort?: string,
    turnModel?: ChatModel,
  ): Promise<CollectedModelResponse> {
    const candidates = [turnModel ?? this.tenantModels.get(tenantId ?? "") ?? this.model, ...this.fallbackModels];
    let lastError: unknown = new Error("No model configured");
    for (let modelIndex = 0; modelIndex < candidates.length; modelIndex += 1) {
      const model = candidates[modelIndex];
      if (model === undefined) continue;
      const textParts: string[] = [];
      const calls = new Map<number, { id?: string; name?: string; arguments: string }>();
      let usage: ModelUsage | undefined;
      try {
        for await (const part of model.stream({ purpose: "agent", messages: view.messages, ...(view.tools === undefined ? {} : { tools: view.tools }), toolChoice: "auto", ...(reasoningEffort === undefined ? {} : { reasoningEffort }), signal: controller.signal })) {
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
            const providerError = new Error(`${part.code}: ${part.message}`);
            Object.assign(providerError, {
              code: part.code,
              ...(part.failureCode === undefined ? {} : { failureCode: part.failureCode }),
              ...(part.retryable === undefined ? {} : { retryable: part.retryable }),
              ...(part.retryAfterMs === undefined ? {} : { retryAfterMs: part.retryAfterMs }),
              ...(part.requestId === undefined ? {} : { requestId: part.requestId }),
              ...(part.status === undefined ? {} : { status: part.status }),
              ...(part.providerCode === undefined ? {} : { providerCode: part.providerCode }),
              ...(part.partialOutput === undefined ? {} : { partialOutput: part.partialOutput }),
            });
            throw providerError;
          }
        }
        const toolCalls: ModelToolCall[] = [];
        for (const [index, call] of [...calls.entries()].sort(([left], [right]) => left - right)) {
          if (call.name === undefined || call.name.trim() === "") throw new Error(`MALFORMED_TOOL_CALL: missing tool name at index ${index}`);
          toolCalls.push({ id: call.id ?? `call_${randomUUID()}`, name: call.name, arguments: call.arguments });
        }
        return { text: textParts.join(""), toolCalls, responseId: `response_${requestId.replace(/^request_/u, "")}`, ...(usage === undefined ? {} : { usage }) };
      } catch (error) {
        lastError = error;
        const partialOutput = textParts.length > 0 || calls.size > 0;
        if (partialOutput && typeof error === "object" && error !== null) Object.assign(error, { partialOutput: true });
        if (controller.signal.aborted || partialOutput || isReactiveContextError(error) || modelIndex >= candidates.length - 1) throw error;
        this.metricCounters.modelFallbacks += 1;
        const failure = modelFailureMetadata(error);
        await this.options.store.append({ sessionId, turnId, type: "agent/error", payload: {
          code: "MODEL_FALLBACK",
          message: sanitizeFailureMessage(error instanceof Error ? error.message : String(error)),
          failureCode: failure.code,
          retryable: failure.retryable,
          ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
          failedModelIndex: modelIndex,
          fallbackModelIndex: modelIndex + 1,
        } });
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
  ): Promise<ScheduledModelToolOutput> {
    this.metricCounters.toolCalls += 1;
    let input: unknown;
    try {
      input = toolCall.arguments.trim() === "" ? {} : JSON.parse(toolCall.arguments) as unknown;
    } catch (error) {
      return {
        output: await this.syntheticToolFailure(sessionId, turnId, toolCall, "MALFORMED_TOOL_ARGUMENTS", error instanceof Error ? error.message : String(error)),
        deferredResult: false,
      };
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
        deferResultEvents: true,
      });
      if (output.status === "failed" || output.result?.ok === false) this.metricCounters.toolFailures += 1;
      if (output.status !== "awaiting_permission" || output.permission === undefined) return { output, deferredResult: true };
      return { output: await this.waitForPermission(output.permission, controller), deferredResult: true };
    } catch (error) {
      this.metricCounters.toolFailures += 1;
      return {
        output: await this.syntheticToolFailure(sessionId, turnId, toolCall, "TOOL_CALL_FAILED", error instanceof Error ? error.message : String(error)),
        deferredResult: false,
      };
    }
  }

  private async syntheticToolFailure(sessionId: SessionId, turnId: TurnId, toolCall: ModelToolCall, code: string, message: string, status: "failed" | "cancelled" | "denied" = "failed"): Promise<ExecuteToolOutput> {
    const toolCallId = brand<string, "ToolCallId">(toolCall.id);
    const result: ToolResult = { ok: false, error: { code, message, remedy: "Check the tool name and JSON arguments, then retry." }, presentation: { kind: "tool", title: code, text: message } };
    await this.options.store.append({ sessionId, turnId, type: "tool/call", payload: { toolCallId, name: toolCall.name, input: toolCall.arguments, riskLevel: "read", approvalMode: "deny", caller: "agent" } });
    await this.options.store.append({ sessionId, turnId, type: "tool/result", payload: { toolCallId, status, result } });
    return { toolCallId, status, result };
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
export { RepeatToolReminder, type RepeatToolNotice, type RepeatToolReminderConfig } from "./repeat-tool-reminder.js";
export {
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  MAX_PARALLEL_TOOL_CALLS,
  resolveMaxParallelToolCalls,
  scheduleToolCalls,
} from "./tool-call-scheduler.js";
export type {
  ToolCallSchedulerOptions,
  ToolCallSchedulerResult,
} from "./tool-call-scheduler.js";

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

function modelToolResult(output: ExecuteToolOutput, preferCompleteString = false): string {
  if (output.result === undefined) return JSON.stringify({ ok: false, error: { code: `TOOL_${output.status.toUpperCase()}`, message: `Tool ended with status ${output.status}` } });
  const view = preferCompleteString && typeof output.result.output === "string" ? output.result.output : output.result.modelView ?? output.result.output ?? output.result;
  return typeof view === "string" ? view : JSON.stringify(view);
}

async function writeToolResultArtifact(workspaceRoot: string, relativePath: string, content: string): Promise<"created" | "exists"> {
  const resolver = new WorkspaceResolver(workspaceRoot);
  const candidate = resolver.resolve(relativePath);
  await mkdir(path.dirname(candidate), { recursive: true });
  const target = await resolver.resolveForWrite(relativePath);
  try {
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw error;
  }
}

function replacementFromPayload(value: Readonly<Record<string, unknown>>): ToolResultReplacementRecord | undefined {
  const artifactRaw = value["artifact"];
  if (typeof value["toolCallId"] !== "string" || typeof value["relativePath"] !== "string" || typeof value["originalChars"] !== "number" || typeof value["originalBytes"] !== "number" || typeof value["originalTokens"] !== "number" || typeof value["thresholdChars"] !== "number" || typeof value["preview"] !== "string" || typeof value["previewBytes"] !== "number" || (value["reason"] !== "max-chars" && value["reason"] !== "max-tokens" && value["reason"] !== "persistence-failed") || typeof artifactRaw !== "object" || artifactRaw === null) return undefined;
  const artifact = artifactRaw as Record<string, unknown>;
  const kind = artifact["kind"];
  if (typeof artifact["id"] !== "string" || typeof artifact["label"] !== "string" || (kind !== "file" && kind !== "diff" && kind !== "log" && kind !== "url" && kind !== "json" && kind !== "other")) return undefined;
  return {
    kind: "tool-result",
    toolCallId: value["toolCallId"],
    ...(typeof value["toolName"] === "string" ? { toolName: value["toolName"] } : {}),
    artifact: {
      id: artifact["id"],
      kind,
      label: artifact["label"],
      ...(typeof artifact["path"] === "string" ? { path: artifact["path"] } : {}),
      ...(typeof artifact["mediaType"] === "string" ? { mediaType: artifact["mediaType"] } : {}),
      ...(typeof artifact["sizeBytes"] === "number" ? { sizeBytes: Math.max(0, Math.floor(artifact["sizeBytes"])) } : {}),
      ...(typeof artifact["digest"] === "string" ? { digest: artifact["digest"] } : {}),
      ...(typeof artifact["preview"] === "string" ? { preview: artifact["preview"] } : {}),
    },
    relativePath: value["relativePath"],
    originalChars: Math.max(0, Math.floor(value["originalChars"])),
    originalBytes: Math.max(0, Math.floor(value["originalBytes"])),
    originalTokens: Math.max(0, Math.floor(value["originalTokens"])),
    thresholdChars: Math.max(1, Math.floor(value["thresholdChars"])),
    preview: value["preview"],
    previewBytes: Math.max(0, Math.floor(value["previewBytes"])),
    reason: value["reason"],
  };
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

function publicContextAssembly(assembly: ContextAssembly): Readonly<Record<string, unknown>> {
  return {
    fingerprint: assembly.fingerprint,
    sectionIds: assembly.sections.map((section) => section.id),
    staticSectionIds: assembly.sections.filter((section) => section.phase === "static").map((section) => section.id),
    dynamicSectionIds: assembly.sections.filter((section) => section.phase === "dynamic").map((section) => section.id),
    attachmentIds: assembly.attachments.map((attachment) => attachment.id),
  };
}

function publicMessageValidation(prepared: PreparedModelContext): Readonly<Record<string, unknown>> {
  return {
    mode: prepared.normalization.mode,
    apiRoundCount: prepared.rounds.length,
    apiRoundResponseIds: prepared.rounds.map((round) => round.responseId ?? null),
    normalized: prepared.normalization.changed,
    normalizationIssueCount: prepared.normalization.issues.length,
    normalizationIssueCodes: prepared.normalization.issues.map((issue) => issue.code),
    pairingValid: prepared.pairing.valid,
    pairingRepaired: prepared.pairing.repaired,
    pairingIssueCount: prepared.pairing.issues.length,
    pairingIssueCodes: prepared.pairing.issues.map((issue) => issue.code),
    syntheticResultCount: prepared.pairing.syntheticResultCount,
    removedOrphanResultCount: prepared.pairing.removedOrphanResultCount,
    removedDuplicateCallCount: prepared.pairing.removedDuplicateCallCount,
  };
}

function publicToolResultBudget(
  report: ToolResultBudgetReport,
  policy: ToolResultBudgetPolicy,
): Readonly<Record<string, unknown>> {
  return {
    enabled: report.enabled,
    changed: report.changed,
    trigger: report.trigger,
    boundedCount: report.boundedCount,
    clearedCount: report.clearedCount,
    tokensSaved: report.tokensSaved,
    boundedToolCallIds: report.boundedToolCallIds,
    clearedToolCallIds: report.clearedToolCallIds,
    newlyClearedToolCallIds: report.newlyClearedToolCallIds,
    protectedToolCallIds: report.protectedToolCallIds,
    messageBudgetChars: report.messageBudgetChars,
    messageBudgetMessagesOverBudget: report.messageBudgetMessagesOverBudget,
    messageBudgetReplacedToolCallIds: report.messageBudgetReplacedToolCallIds,
    microcompactTrigger: report.microcompactTrigger,
    timeBasedMicrocompactEnabled: report.timeBasedMicrocompactEnabled,
    timeBasedGapMs: report.timeBasedGapMs,
    policy: {
      enabled: policy.enabled !== false,
      ...(policy.maxResultChars === undefined ? {} : { maxResultChars: policy.maxResultChars }),
      ...(policy.microcompactTriggerToolCount === undefined ? {} : { microcompactTriggerToolCount: policy.microcompactTriggerToolCount }),
      ...(policy.microcompactTriggerTokens === undefined ? {} : { microcompactTriggerTokens: policy.microcompactTriggerTokens }),
      ...(policy.keepRecentResults === undefined ? {} : { keepRecentResults: policy.keepRecentResults }),
      ...(policy.timeBasedMicrocompactEnabled === undefined ? {} : { timeBasedMicrocompactEnabled: policy.timeBasedMicrocompactEnabled }),
      ...(policy.timeBasedGapMs === undefined ? {} : { timeBasedGapMs: policy.timeBasedGapMs }),
      ...(policy.maxToolResultsPerMessageChars === undefined ? {} : { maxToolResultsPerMessageChars: policy.maxToolResultsPerMessageChars }),
    },
  };
}

function splitCompactedMessages(messages: readonly ChatMessage[]): {
  readonly summaryMessages: readonly ChatMessage[];
  readonly preservedMessages: readonly ChatMessage[];
} {
  const nonSystem = messages.filter((message) => message.role !== "system");
  const summaryIndex = nonSystem.findIndex((message) => message.role === "user" && isCompactionSummary(message.content));
  if (summaryIndex < 0) return { summaryMessages: [], preservedMessages: nonSystem };
  return {
    summaryMessages: [nonSystem[summaryIndex]!],
    preservedMessages: nonSystem.slice(summaryIndex + 1),
  };
}

function isCompactionSummary(content: string): boolean {
  return content.startsWith("<session-memory>") || content.startsWith("<conversation-summary>") || content.startsWith("[Compacted context:");
}

function defaultPostCompactAttachments(sessionId: SessionId, projection: SessionProjection | undefined): readonly ContextAttachment[] {
  const plan = projection?.plan;
  if (plan === undefined || plan.status === "cleared" || plan.content.trim().length === 0) return [];
  return [{
    id: "plan:" + String(sessionId),
    kind: "plan",
    content: "Plan status: " + plan.status + "\n" + plan.content,
    order: 10,
  }];
}

function pendingToolCallIds(projection: SessionProjection | undefined): Set<string> {
  return new Set([
    ...(projection?.permissions.filter((permission) => permission.status === "pending").map((permission) => String(permission.toolCallId)) ?? []),
    ...(projection?.interactions.filter((interaction) => interaction.status === "pending").map((interaction) => String(interaction.toolCallId)) ?? []),
  ]);
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

function parseModelSelection(value: unknown): ModelSelection | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["provider"] !== "string" || typeof record["model"] !== "string") return undefined;
  if (record["provider"].trim() === "" || record["model"].trim() === "") return undefined;
  if (record["reasoningEffort"] !== undefined && typeof record["reasoningEffort"] !== "string") return undefined;
  return {
    provider: record["provider"].trim(),
    model: record["model"].trim(),
    ...(record["reasoningEffort"] === undefined ? {} : { reasoningEffort: (record["reasoningEffort"] as string).trim() }),
  };
}

function createProjectMemoryScope(
  sessionId: SessionId,
  projection: SessionProjection,
  keyFactory: AgentHostOptions["projectMemoryScopeKey"],
): ProjectMemoryScope {
  const workspaceRoot = effectiveWorkspaceRoot(projection);
  const tenantId = projection.ownership?.tenantId === undefined ? undefined : String(projection.ownership.tenantId);
  return {
    sessionId: String(sessionId),
    workspaceRoot,
    ...(tenantId === undefined ? {} : { tenantId }),
    scopeKey: keyFactory?.({ workspaceRoot, ...(tenantId === undefined ? {} : { tenantId }) }) ?? projectMemoryScopeKey(workspaceRoot, tenantId),
  };
}

function projectMemoryScope(projection: SessionProjection, keyFactory: AgentHostOptions["projectMemoryScopeKey"]): string {
  const workspaceRoot = effectiveWorkspaceRoot(projection);
  const tenantId = projection.ownership?.tenantId === undefined ? undefined : String(projection.ownership.tenantId);
  return keyFactory?.({ workspaceRoot, ...(tenantId === undefined ? {} : { tenantId }) }) ?? projectMemoryScopeKey(workspaceRoot, tenantId);
}

function projectMemoryScopeKey(workspaceRoot: string, tenantId?: string): string {
  return `pm_${createHash("sha256").update(`${tenantId ?? "local"}\n${workspaceRoot}`).digest("hex").slice(0, 24)}`;
}

function latestProjectMemoryQuery(history: readonly ChatMessage[]): string {
  for (const message of [...history].reverse()) {
    if (message.role !== "user" || message.content.trim().startsWith("<context-attachment")) continue;
    return message.content;
  }
  return "";
}

function shouldIgnoreProjectMemory(query: string): boolean {
  return /(?:ignore|without|don't use|do not use|不用|不要|忽略|跳过)[^\n]{0,40}(?:project\s+memory|memory|记忆)/iu.test(query)
    || /(?:project\s+memory|memory|记忆)[^\n]{0,40}(?:ignore|without|don't use|do not use|不用|不要|忽略|跳过)/iu.test(query);
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/gu, " ").slice(0, 160);
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
