/** Branded identifiers prevent accidental mixing of independent runtime ids. */
export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type PrincipalId = Brand<string, "PrincipalId">;
export type TenantId = Brand<string, "TenantId">;
export type TurnId = Brand<string, "TurnId">;
export type TaskId = Brand<string, "TaskId">;
export type RunId = Brand<string, "RunId">;
export type GoalId = Brand<string, "GoalId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type PermissionId = Brand<string, "PermissionId">;
export type InteractionId = Brand<string, "InteractionId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;

export function brand<Value, Name extends string>(value: Value): Brand<Value, Name> {
  return value as Brand<Value, Name>;
}

export type AgentEventType =
  | "session/created"
  | "session/updated"
  | "session/deleted"
  | "workspace/updated"
  | "workspace/reordered"
  | "user/message"
  | "turn/steered"
  | "attachment/received"
  | "attachment/rejected"
  | "turn/queued"
  | "queue/changed"
  | "turn/started"
  | "step/started"
  | "step/ended"
  | "turn/ended"
  | "assistant/chunk"
  | "assistant/message"
  | "task/created"
  | "task/updated"
  | "task/input-required"
  | "task/report"
  | "task/artifact"
  | "task/ended"
  | "subagent/descriptor"
  | "subagent/start"
  | "subagent/end"
  | "subagent/inbox"
  | "subagent/settlement"
  | "goal/created"
  | "goal/updated"
  | "goal/ended"
  | "plan/updated"
  | "todo/updated"
  | "context/compacted"
  | "context/compaction_failed"
  | "context/messages_normalized"
  | "context/tool_pairing_repaired"
  | "context/tool_results_budgeted"
  | "context/microcompacted"
  | "context/session_memory_compacted"
  | "context/session_memory_compaction_failed"
  | "context/session_memory_extraction_started"
  | "context/session_memory_extraction_completed"
  | "context/session_memory_extraction_failed"
  | "context/session_memory_extraction_cancelled"
  | "context/project_memory_loaded"
  | "context/project_memory_recalled"
  | "context/project_memory_stale"
  | "context/project_memory_disabled"
  | "context/summary_started"
  | "context/summary_retried"
  | "context/summary_compacted"
  | "context/summary_compaction_failed"
  | "context/compact_boundary"
  | "context/post_compact_rebuild_failed"
  | "context/recovery_started"
  | "context/recovery_transition"
  | "context/recovery_succeeded"
  | "context/recovery_failed"
  | "context/recovery_circuit_open"
  | "context/transcript_segment"
  | "context/session_restored"
  | "worktree/created"
  | "worktree/attached"
  | "worktree/switched"
  | "worktree/cleaned"
  | "worktree/failed"
  | "tool/call"
  | "tool/progress"
  | "tool/result"
  | "diff/preview"
  | "patch/preview"
  | "patch/applied"
  | "patch/rejected"
  | "patch/rolled_back"
  | "lsp/server"
  | "lsp/request"
  | "permission/requested"
  | "permission/resolved"
  | "interaction/requested"
  | "interaction/resolved"
  | "terminal/session"
  | "job/started"
  | "job/output"
  | "job/ended"
  | "mcp/server"
  | "mcp/tool"
  | "mcp/resource"
  | "mcp/prompt"
  | "agent/status"
  | "agent/error";

/** Runtime registry used by transports (SSE, replay and adapters). Keep this
 * list in lockstep with AgentEventType so a newly added event cannot silently
 * disappear at the Web boundary. */
export const AGENT_EVENT_TYPES: readonly AgentEventType[] = [
  "session/created", "session/updated", "session/deleted", "workspace/updated", "workspace/reordered",
  "user/message", "turn/steered", "attachment/received", "attachment/rejected", "turn/queued", "queue/changed",
  "turn/started", "step/started", "step/ended", "turn/ended", "assistant/chunk", "assistant/message",
  "task/created", "task/updated", "task/input-required", "task/report", "task/artifact", "task/ended",
  "subagent/descriptor", "subagent/start", "subagent/end", "subagent/inbox", "subagent/settlement",
  "goal/created", "goal/updated", "goal/ended", "plan/updated", "todo/updated",
  "context/compacted", "context/compaction_failed", "context/messages_normalized", "context/tool_pairing_repaired",
  "context/tool_results_budgeted", "context/microcompacted", "context/session_memory_compacted",
  "context/session_memory_compaction_failed", "context/session_memory_extraction_started",
  "context/session_memory_extraction_completed", "context/session_memory_extraction_failed",
  "context/session_memory_extraction_cancelled", "context/project_memory_loaded", "context/project_memory_recalled",
  "context/project_memory_stale", "context/project_memory_disabled", "context/summary_started", "context/summary_retried",
  "context/summary_compacted", "context/summary_compaction_failed", "context/compact_boundary",
  "context/post_compact_rebuild_failed", "context/recovery_started", "context/recovery_transition",
  "context/recovery_succeeded", "context/recovery_failed", "context/recovery_circuit_open", "context/transcript_segment",
  "context/session_restored", "worktree/created", "worktree/attached", "worktree/switched", "worktree/cleaned",
  "worktree/failed", "tool/call", "tool/progress", "tool/result", "diff/preview", "patch/preview", "patch/applied",
  "patch/rejected", "patch/rolled_back", "lsp/server", "lsp/request", "permission/requested", "permission/resolved",
  "interaction/requested", "interaction/resolved", "terminal/session", "job/started", "job/output", "job/ended",
  "mcp/server", "mcp/tool", "mcp/resource", "mcp/prompt", "agent/status", "agent/error",
];

export interface AgentEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly schemaVersion: 1;
  readonly sessionId: SessionId;
  readonly turnId?: TurnId;
  readonly type: AgentEventType;
  readonly createdAt: string;
  readonly correlationId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type SessionStatus = "idle" | "queued" | "running" | "stopped" | "failed" | "interrupted";
export type TurnStatus = "queued" | "running" | "completed" | "stopped" | "failed" | "interrupted";
export type TaskStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "blocked";
export type SubagentMode = "one-shot" | "continuable";
export type SubagentStatus = "queued" | "running" | "ready" | "waiting" | "completed" | "failed" | "cancelled" | "rejected" | "interrupted";
export type TaskTerminalStatus = "completed" | "failed" | "cancelled" | "rejected" | "partial";
export type TaskStopReason = "completed" | "aborted" | "error" | "max-tokens" | "refusal";
export type ReportDeliveryPolicy = "wakeup" | "quiet";
export type GoalStatus = "active" | "paused" | "completed" | "blocked" | "cancelled";
export type PermissionPreset = "read-only" | "workspace-write" | "ask-on-write" | "ask-on-execute" | "danger-full-access";

export interface ArtifactRef {
  readonly id: string;
  readonly kind: "file" | "diff" | "log" | "url" | "json" | "other";
  readonly label: string;
  readonly path?: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
  readonly digest?: string;
  readonly preview?: string;
}

export interface TaskBudget {
  readonly maxSteps?: number;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
}

export interface SubagentDescriptor {
  readonly version: 1;
  readonly mode: SubagentMode;
  readonly provider: string;
  readonly label?: string;
  readonly parentTaskId?: TaskId;
  readonly parentSessionId: SessionId;
  readonly childSessionId: SessionId;
  readonly workspaceRoot: string;
  readonly permissionPreset: PermissionPreset;
  readonly toolAllowlist?: readonly string[];
  readonly mcpAllowlist?: readonly string[];
  readonly model?: string;
  readonly delegationDepth: number;
}

export interface TaskAuthority {
  readonly directParentSessionId: SessionId;
  readonly directParentTaskId?: TaskId;
  readonly ancestorSessionIds: readonly SessionId[];
  readonly delegationDepth: number;
}

export interface TaskReport {
  readonly taskId: TaskId;
  readonly childSessionId: SessionId;
  readonly status: TaskTerminalStatus;
  readonly stopReason?: TaskStopReason;
  readonly summary: string;
  readonly output?: unknown;
  readonly artifacts: readonly ArtifactRef[];
  readonly diagnostics?: readonly ToolError[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface ChildReportInput {
  readonly summary: string;
  readonly output?: unknown;
  readonly artifacts?: readonly ArtifactRef[];
  readonly delivery?: ReportDeliveryPolicy;
}

export interface SettlementNotice {
  readonly taskId: TaskId;
  readonly childSessionId: SessionId;
  readonly status: TaskTerminalStatus | "ready";
  readonly summary?: string;
  readonly stopReason?: TaskStopReason;
}

export interface ChildSessionMetadata {
  readonly parentSessionId: SessionId;
  readonly parentTaskId?: TaskId;
  readonly childMode: SubagentMode;
  readonly childProvider: string;
  readonly delegationDepth: number;
  readonly descriptor?: SubagentDescriptor;
  readonly ownership?: SessionOwnership;
}

/** Durable ownership attached to a Session and inherited by child Sessions. */
export interface SessionOwnership {
  readonly principalId: PrincipalId;
  readonly tenantId: TenantId;
}

export type PrincipalStatus = "active" | "disabled";

/** Durable external-identity catalog entry; tokens remain the source of claims. */
export interface PrincipalRecord {
  readonly id: PrincipalId;
  readonly subject: string;
  readonly tenantId: TenantId;
  readonly displayName?: string;
  readonly roles: readonly string[];
  readonly status: PrincipalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Host-owned principal catalog used to bind verified IdP subjects to tenants. */
export interface PrincipalBackend {
  listPrincipals(tenantId?: string): readonly PrincipalRecord[];
  getPrincipal(subject: string): PrincipalRecord | undefined;
  upsertPrincipal(record: PrincipalRecord): PrincipalRecord;
}

export interface SessionSummary {
  readonly id: SessionId;
  readonly title?: string;
  readonly workspaceRoot: string;
  readonly permissionPreset: PermissionPreset;
  readonly archived: boolean;
  readonly deleted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: SessionStatus;
  readonly lastSequence: number;
  readonly parentSessionId?: SessionId;
  readonly parentTaskId?: TaskId;
  readonly childMode?: SubagentMode;
  readonly childProvider?: string;
  readonly delegationDepth?: number;
  /** Worktree selected for tool execution, when the session has one. */
  readonly activeWorktreeId?: string;
  readonly activeWorkspaceRoot?: string;
  readonly ownership?: SessionOwnership;
}

export interface WorkspaceSummary {
  readonly key: string;
  readonly root: string;
  readonly position: number;
  readonly sessionCount: number;
  readonly latestUpdatedAt?: string;
  /** Optional host-backed display label; absent means derive it from root. */
  readonly label?: string;
  /** Workspace lifecycle metadata. Missing values mean active/not deleted for backward compatibility. */
  readonly archived?: boolean;
  readonly deleted?: boolean;
}

export interface WorkspaceCatalog {
  readonly workspaces: readonly WorkspaceSummary[];
}

export interface TurnProjection {
  readonly id: TurnId;
  readonly status: TurnStatus;
  /** Durable position among queued turns; absent while running or terminal. */
  readonly queuePosition?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly userMessage?: string;
  readonly assistantMessage?: string;
  readonly lastSequence: number;
}

export interface TaskProjection {
  readonly id: TaskId;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title?: string;
  readonly result?: unknown;
  readonly parentSessionId?: SessionId;
  readonly parentTaskId?: TaskId;
  readonly childSessionId?: SessionId;
  readonly mode?: SubagentMode;
  readonly provider?: string;
  readonly workspaceRoot?: string;
  readonly permissionPreset?: PermissionPreset;
  readonly delegationDepth?: number;
  readonly budget?: TaskBudget;
  readonly artifacts: readonly ArtifactRef[];
  readonly report?: TaskReport;
  readonly terminalReason?: string;
  readonly diagnostics?: readonly ToolError[];
  readonly lastSequence: number;
}

export interface GoalProjection {
  readonly id: GoalId;
  readonly title: string;
  readonly status: GoalStatus;
  readonly successCriteria: readonly string[];
  readonly budget?: Readonly<Record<string, unknown>>;
  readonly result?: unknown;
  readonly reason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSequence: number;
}

export type PlanStatus = "draft" | "active" | "approved" | "rejected" | "cleared";

export interface PlanProjection {
  readonly content: string;
  readonly status: PlanStatus;
  readonly updatedAt: string;
  readonly lastSequence: number;
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: TodoStatus;
  readonly activeForm?: string;
}

export type InteractionStatus = "pending" | "answered" | "cancelled" | "expired";

export interface InteractionOption {
  readonly label: string;
  readonly value: string;
}

export interface InteractionProjection {
  readonly id: InteractionId;
  readonly toolCallId: ToolCallId;
  readonly turnId?: TurnId;
  readonly question: string;
  readonly options: readonly InteractionOption[];
  readonly allowFreeform: boolean;
  readonly status: InteractionStatus;
  readonly answer?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly lastSequence: number;
}

/**
 * Durable whole-log usage projection. The history page is only a transport
 * window; this value is folded from the complete event log and therefore does
 * not change when older pages are loaded in the Web client.
 */
export interface SessionStatsProjection {
  readonly version: 1;
  /** Highest event sequence included in this projection. */
  readonly sourceSequence: number;
  /** True when the value represents the complete event log. */
  readonly complete: boolean;
  readonly latestPrompt?: string;
  readonly turnCount: number;
  readonly stepCount: number;
  readonly toolCallCount: number;
  readonly turnDurationMs?: number;
  readonly llmDurationMs?: number;
  readonly toolDurationMs?: number;
  readonly ttftMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  readonly outputTokensPerSecond?: number;
  readonly cacheHitPercent?: number;
  readonly status?: SessionStatus;
  readonly updatedAt: string;
  /** Internal fold cursors persisted with the projection for restart-safe tail replay. */
  readonly folding?: SessionStatsFoldingState;
}

/** Internal cursors needed to fold durations from a high-sequence tail. */
export interface SessionStatsFoldingState {
  readonly turnIds: readonly string[];
  readonly turnStarts: Readonly<Record<string, string>>;
  readonly stepStarts: Readonly<Record<string, string>>;
  readonly toolStarts: Readonly<Record<string, string>>;
  readonly reportedTtftMs?: number;
}

export function createSessionStatsProjection(timestamp = new Date(0).toISOString(), complete = true): SessionStatsProjection {
  return {
    version: 1,
    sourceSequence: 0,
    complete,
    turnCount: 0,
    stepCount: 0,
    toolCallCount: 0,
    status: "idle",
    updatedAt: timestamp,
    folding: { turnIds: [], turnStarts: {}, stepStarts: {}, toolStarts: {} },
  };
}

/**
 * Folds one ordered event into the whole-log usage projection. It is kept in
 * contracts so the durable Storage projection and the Web live-tail reducer
 * share the same semantics.
 */
export function reduceSessionStats(previous: SessionStatsProjection, event: AgentEvent, complete = previous.complete): SessionStatsProjection {
  if (event.sequence <= previous.sourceSequence) return previous;
  const folding = previous.version === 1 && previous.folding !== undefined
    ? previous.folding
    : createSessionStatsProjection(previous.updatedAt, complete).folding!;
  const turnIds = new Set(folding.turnIds);
  const turnStarts = { ...folding.turnStarts };
  const stepStarts = { ...folding.stepStarts };
  const toolStarts = { ...folding.toolStarts };
  let reportedTtftMs = folding.reportedTtftMs;
  const payload = event.payload;
  const turnId = event.turnId === undefined ? undefined : String(event.turnId);
  const timestamp = Date.parse(event.createdAt);
  const eventMs = Number.isFinite(timestamp) ? timestamp : undefined;
  let turnDurationMs = previous.turnDurationMs;
  let llmDurationMs = previous.llmDurationMs;
  let toolDurationMs = previous.toolDurationMs;
  let ttftMs = previous.ttftMs;
  let inputTokens = previous.inputTokens;
  let outputTokens = previous.outputTokens;
  let cacheReadTokens = previous.cacheReadTokens;
  let reasoningTokens = previous.reasoningTokens;
  let latestPrompt = previous.latestPrompt;
  let status = previous.status;
  const explicitTtft = finiteStatsNumber(payload["ttftMs"] ?? payload["ttft_ms"]);
  if (explicitTtft !== undefined && reportedTtftMs === undefined) reportedTtftMs = explicitTtft;

  if (turnId !== undefined) turnIds.add(turnId);
  if ((event.type === "user/message" || event.type === "turn/steered") && typeof payload["content"] === "string") latestPrompt = payload["content"];
  if (event.type === "turn/started") {
    status = "running";
  }
  if (event.type === "turn/started" && turnId !== undefined && eventMs !== undefined) {
    turnStarts[turnId] = event.createdAt;
  }
  if (event.type === "turn/queued" && status !== "running") status = "queued";
  if (event.type === "step/started") {
    const key = `${turnId ?? "_"}:${String(payload["step"] ?? event.sequence)}`;
    stepStarts[key] = event.createdAt;
  }
  if (event.type === "assistant/chunk" || event.type === "assistant/message") {
    if (turnId !== undefined && eventMs !== undefined) {
      const startedAt = turnStarts[turnId];
      const startedMs = startedAt === undefined ? undefined : Date.parse(startedAt);
      if (startedMs !== undefined && Number.isFinite(startedMs)) {
        const candidate = Math.max(0, eventMs - startedMs);
        ttftMs = ttftMs === undefined ? candidate : Math.min(ttftMs, candidate);
      }
    }
    if (event.type === "assistant/message") {
      const usage = statsUsage(payload["usage"] ?? payload);
      inputTokens = addStatsOptional(inputTokens, usage.inputTokens);
      outputTokens = addStatsOptional(outputTokens, usage.outputTokens);
      cacheReadTokens = addStatsOptional(cacheReadTokens, usage.cacheReadTokens);
      reasoningTokens = addStatsOptional(reasoningTokens, usage.reasoningTokens);
      if (turnId !== undefined && eventMs !== undefined) {
        const key = Object.keys(stepStarts).find((candidate) => candidate.startsWith(`${turnId}:`));
        const startedAt = key === undefined ? undefined : stepStarts[key];
        const startedMs = startedAt === undefined ? undefined : Date.parse(startedAt);
        if (startedMs !== undefined && Number.isFinite(startedMs) && eventMs >= startedMs) llmDurationMs = (llmDurationMs ?? 0) + eventMs - startedMs;
        if (startedMs === undefined) {
          const explicitDuration = finiteStatsNumber(payload["durationMs"] ?? payload["duration_ms"]);
          if (explicitDuration !== undefined) llmDurationMs = (llmDurationMs ?? 0) + explicitDuration;
        }
        if (key !== undefined) delete stepStarts[key];
      }
    }
  }
  if (event.type === "tool/call") {
    const toolCallId = String(payload["toolCallId"] ?? payload["id"] ?? event.sequence);
    toolStarts[toolCallId] = event.createdAt;
  }
  if (event.type === "tool/result") {
    const toolCallId = String(payload["toolCallId"] ?? payload["id"] ?? "");
    const startedAt = toolStarts[toolCallId];
    const startedMs = startedAt === undefined ? undefined : Date.parse(startedAt);
    if (startedMs !== undefined && Number.isFinite(startedMs) && eventMs !== undefined && eventMs >= startedMs) toolDurationMs = (toolDurationMs ?? 0) + eventMs - startedMs;
    if (startedMs === undefined) {
      const explicitDuration = finiteStatsNumber(payload["durationMs"] ?? payload["duration_ms"]);
      if (explicitDuration !== undefined) toolDurationMs = (toolDurationMs ?? 0) + explicitDuration;
    }
    delete toolStarts[toolCallId];
  }
  if (event.type === "turn/ended") {
    status = statsSessionStatus(payload["status"]);
    if (turnId !== undefined) {
      const startedAt = turnStarts[turnId];
      const startedMs = startedAt === undefined ? undefined : Date.parse(startedAt);
      if (startedMs !== undefined && Number.isFinite(startedMs) && eventMs !== undefined && eventMs >= startedMs) turnDurationMs = (turnDurationMs ?? 0) + eventMs - startedMs;
      delete turnStarts[turnId];
    }
  }
  if (event.type === "agent/status") {
    const nextStatus = statsSessionStatus(payload["status"]);
    if (nextStatus !== undefined) status = nextStatus;
  }
  if (event.type === "agent/error") status = "failed";
  const totalTokens = inputTokens === undefined || outputTokens === undefined ? undefined : inputTokens + outputTokens;
  const outputTokensPerSecond = outputTokens === undefined || llmDurationMs === undefined || llmDurationMs <= 0 ? undefined : outputTokens / (llmDurationMs / 1000);
  const cacheHitPercent = inputTokens === undefined || inputTokens <= 0 || cacheReadTokens === undefined ? undefined : Math.min(100, cacheReadTokens / inputTokens * 100);
  const effectiveTtftMs = reportedTtftMs ?? ttftMs;
  return {
    version: 1,
    sourceSequence: event.sequence,
    complete,
    ...(latestPrompt === undefined ? {} : { latestPrompt }),
    turnCount: turnIds.size,
    stepCount: previous.stepCount + (event.type === "step/started" ? 1 : 0),
    toolCallCount: previous.toolCallCount + (event.type === "tool/call" ? 1 : 0),
    ...(turnDurationMs === undefined ? {} : { turnDurationMs }),
    ...(llmDurationMs === undefined ? {} : { llmDurationMs }),
    ...(toolDurationMs === undefined ? {} : { toolDurationMs }),
    ...(effectiveTtftMs === undefined ? {} : { ttftMs: effectiveTtftMs }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(outputTokensPerSecond === undefined ? {} : { outputTokensPerSecond }),
    ...(cacheHitPercent === undefined ? {} : { cacheHitPercent }),
    ...(status === undefined ? {} : { status }),
    updatedAt: event.createdAt,
    folding: { turnIds: [...turnIds], turnStarts, stepStarts, toolStarts, ...(reportedTtftMs === undefined ? {} : { reportedTtftMs }) },
  };
}

function finiteStatsNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function addStatsOptional(previous: number | undefined, next: number | undefined): number | undefined {
  return next === undefined ? previous : previous === undefined ? next : previous + next;
}

function statsUsage(value: unknown): { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; reasoningTokens?: number } {
  if (typeof value !== "object" || value === null) return {};
  const source = value as Record<string, unknown>;
  const inputTokens = finiteStatsNumber(source["inputTokens"] ?? source["input_tokens"] ?? source["promptTokens"] ?? source["prompt_tokens"]);
  const outputTokens = finiteStatsNumber(source["outputTokens"] ?? source["output_tokens"] ?? source["completionTokens"] ?? source["completion_tokens"]);
  const cacheReadTokens = finiteStatsNumber(source["cacheReadTokens"] ?? source["cache_read_tokens"] ?? source["cachedTokens"] ?? source["cached_tokens"] ?? source["promptCacheHitTokens"] ?? source["prompt_cache_hit_tokens"]);
  const reasoningTokens = finiteStatsNumber(source["reasoningTokens"] ?? source["reasoning_tokens"]);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function statsSessionStatus(value: unknown): SessionStatus | undefined {
  if (value === "completed") return "idle";
  return value === "idle" || value === "queued" || value === "running" || value === "stopped" || value === "failed" || value === "interrupted" ? value : undefined;
}

export interface SessionProjection extends SessionSummary {
  readonly messages: readonly {
    readonly role: "user" | "assistant";
    readonly content: string;
    readonly turnId?: TurnId;
  }[];
  readonly turns: readonly TurnProjection[];
  readonly tasks: readonly TaskProjection[];
  readonly goals: readonly GoalProjection[];
  readonly plan: PlanProjection;
  readonly todos: readonly TodoItem[];
  readonly interactions: readonly InteractionProjection[];
  readonly toolCalls: readonly ToolCallProjection[];
  readonly permissions: readonly PermissionProjection[];
  readonly contextCompaction?: ContextCompactionProjection;
  readonly contextSessionMemory?: ContextSessionMemoryProjection;
  readonly contextProjectMemory?: ContextProjectMemoryProjection;
  readonly contextDiagnostics?: ContextDiagnosticsProjection;
  readonly contextRecovery?: ContextRecoveryProjection;
  readonly contextTranscript?: ContextTranscriptSegment;
  readonly contextRestore?: ContextSessionRestoreProjection;
  readonly worktrees?: readonly WorktreeProjection[];
  /** Whole-log projection; absent only for legacy projection JSON. */
  readonly stats?: SessionStatsProjection;
}

export type ContextCompactionStatus = "completed" | "failed";

export type ContextBoundaryKind = "legacy" | "session_memory" | "summary" | "micro";
export type ContextBoundaryTrigger = "manual" | "auto";

export interface ContextPreservedSegment {
  readonly headMessageId?: string;
  readonly anchorMessageId?: string;
  readonly tailMessageId?: string;
}

/** Durable, bounded metadata used to rebuild the model-visible post-compact view. */
export interface ContextBoundaryMetadata {
  readonly version: 1;
  readonly id: string;
  readonly kind: ContextBoundaryKind;
  readonly trigger: ContextBoundaryTrigger;
  readonly preCompactTokens: number;
  readonly sourceSequence: number;
  readonly lastPreCompactMessageId?: string;
  readonly messagesSummarized?: number;
  readonly preservedSegment?: ContextPreservedSegment;
  readonly preCompactDiscoveredTools?: readonly string[];
  readonly attachmentIds?: readonly string[];
  readonly tokensSaved?: number;
  readonly compactedToolIds?: readonly string[];
  readonly clearedAttachmentIds?: readonly string[];
  readonly createdAt: string;
  /** Algorithm identifier used to rebuild model view after restart. */
  readonly algorithmVersion?: string;
}

export interface ContextAttachmentProjection {
  readonly id: string;
  readonly kind: string;
  readonly tokenEstimate: number;
}

export interface ContextCompactionProjection {
  readonly status: ContextCompactionStatus;
  readonly kind?: "legacy" | "session_memory" | "summary";
  readonly sourceSequence: number;
  readonly summary: string;
  readonly originalMessageCount: number;
  readonly compactedMessageCount: number;
  readonly estimatedTokens: number;
  readonly preCompactTokens?: number;
  readonly postCompactTokens?: number;
  readonly tokensSaved?: number;
  readonly droppedMessages: number;
  readonly protectedMessageCount?: number;
  readonly truncatedToolResults?: number;
  readonly updatedAt: string;
  readonly lastSequence: number;
  readonly error?: string;
  readonly boundary?: ContextBoundaryMetadata;
  readonly attachments?: readonly ContextAttachmentProjection[];
}

export type ContextSessionMemoryExtractionStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ContextSessionMemoryExtractionTrigger = "initialization" | "threshold" | "natural_break";

/** Bounded durable state for Claude Code-style background session-memory extraction. */
export interface ContextSessionMemoryProjection {
  readonly version: 1;
  readonly status: ContextSessionMemoryExtractionStatus;
  readonly initialized: boolean;
  readonly sourceSequence?: number;
  readonly sourceMessageId?: string;
  readonly lastExtractedMessageId?: string;
  readonly lastExtractedTokens: number;
  readonly toolCallsSinceLastExtraction: number;
  readonly trigger?: ContextSessionMemoryExtractionTrigger;
  readonly extractorSessionId?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly updatedAt: string;
  readonly lastSequence: number;
  readonly memoryChars?: number;
  readonly memoryUpdatedAt?: string;
  readonly error?: string;
}

export type ContextProjectMemoryStatus = "loaded" | "recalled" | "stale" | "disabled";

/** Bounded projection for workspace/tenant-scoped Project Memory (M12). */
export interface ContextProjectMemoryProjection {
  readonly version: 1;
  readonly status: ContextProjectMemoryStatus;
  readonly scopeKey: string;
  readonly entrypointName: "MEMORY.md";
  readonly entrypointBytes: number;
  readonly entrypointLines: number;
  readonly truncated: boolean;
  readonly topicCount: number;
  readonly recalledTopicIds?: readonly string[];
  readonly staleTopicIds?: readonly string[];
  readonly ignored: boolean;
  readonly reason?: string;
  readonly updatedAt: string;
  readonly lastSequence: number;
}

export type ContextDiagnosticLevel = "unknown" | "healthy" | "warning" | "error" | "auto_compact" | "blocking";
export type ContextDiagnosticTokenSource = "provider" | "estimate" | "stale_usage";
export type ContextDiagnosticTokenConfidence = "exact" | "high" | "medium" | "low";

export interface ContextDiagnosticRecovery {
  readonly status: "started" | "transition" | "succeeded" | "failed" | "circuit_open";
  readonly attempt: number;
  readonly errorClass?: string;
  readonly transitionReason?: string;
  readonly providerStatus?: number;
  readonly lastSequence: number;
}

/** Durable, bounded M13 context diagnostics consumed by API/Web presenters. */
export interface ContextDiagnosticsProjection {
  readonly version: 1;
  readonly tokenUsage: number;
  readonly tokenSource: ContextDiagnosticTokenSource;
  readonly tokenConfidence: ContextDiagnosticTokenConfidence;
  readonly effectiveWindowTokens: number;
  readonly warningThreshold: number;
  readonly errorThreshold: number;
  readonly autoCompactThreshold: number;
  readonly blockingThreshold: number;
  readonly percentLeft: number;
  readonly level: ContextDiagnosticLevel;
  readonly lastStep?: number;
  readonly lastTurnId?: TurnId;
  readonly lastRequestId?: string;
  readonly breakdown?: Readonly<Record<string, number>>;
  readonly lastCompaction?: {
    readonly status: "completed" | "failed";
    readonly kind?: "legacy" | "session_memory" | "summary" | "micro";
    readonly preCompactTokens?: number;
    readonly postCompactTokens?: number;
    readonly tokensSaved?: number;
    readonly sequence: number;
    readonly error?: string;
  };
  readonly recoveryChain: readonly ContextDiagnosticRecovery[];
  readonly updatedAt: string;
  readonly lastSequence: number;
}

export type ContextRecoveryErrorClass =
  | "prompt_too_long"
  | "media_too_large"
  | "tool_pairing"
  | "schema"
  | "other";

export type ContextRecoveryStatus = "started" | "succeeded" | "failed" | "circuit_open";

/** Bounded diagnostic metadata for one proactive/reactive context recovery attempt. */
export interface ContextRecoveryProjection {
  readonly version: 1;
  readonly status: ContextRecoveryStatus;
  readonly requestHash: string;
  readonly errorClass: ContextRecoveryErrorClass;
  readonly providerStatus?: number;
  readonly providerCode?: string;
  readonly attempt: number;
  readonly attemptedModules: readonly string[];
  readonly transitionReason: string;
  readonly updatedAt: string;
  readonly lastSequence: number;
  readonly error?: string;
}

/** Durable link between a compact boundary and the original transcript segment. */
export interface ContextTranscriptSegment {
  readonly version: 1;
  readonly boundaryId: string;
  readonly algorithmVersion: string;
  readonly sourceSequence: number;
  readonly headMessageId?: string;
  readonly anchorMessageId?: string;
  readonly tailMessageId?: string;
  readonly createdAt: string;
}

export type ContextRestoreMode = "boundary" | "legacy";

/** Last deterministic restore decision projected from the event stream. */
export interface ContextSessionRestoreProjection {
  readonly version: 1;
  readonly status: "restored" | "fallback";
  readonly mode: ContextRestoreMode;
  readonly boundaryId?: string;
  readonly algorithmVersion?: string;
  readonly reason: string;
  readonly sourceSequence?: number;
  readonly updatedAt: string;
  readonly lastSequence: number;
}

export type WorktreeStatus = "clean" | "dirty" | "conflicted" | "attached" | "removed" | "failed";

export interface WorktreeProjection {
  readonly id: string;
  readonly repoRoot: string;
  readonly path: string;
  readonly status: WorktreeStatus;
  readonly branch?: string;
  readonly commit?: string;
  readonly sessionId?: SessionId;
  readonly taskId?: TaskId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSequence: number;
  readonly error?: string;
}

export type ToolRiskLevel = "read" | "write" | "execute" | "network";
export type ToolExecutionMode = "parallel" | "exclusive";
export type ToolApprovalMode = "auto" | "ask" | "deny";
export type ToolInterruptBehavior = "cancel" | "block";
export type ToolCaller = "agent" | "user" | "system";
export type ToolCallStatus = "pending" | "awaiting_permission" | "running" | "completed" | "failed" | "cancelled" | "denied";
export type PermissionStatus = "pending" | "approved" | "denied" | "cancelled" | "expired";
export type ToolSource =
  | { readonly kind: "builtin" }
  | { readonly kind: "mcp"; readonly serverName: string; readonly rawName: string; readonly tenantId?: TenantId };

export type McpServerScope = "user" | "project" | "session";

/** A non-secret pointer into a host-owned credential provider. */
export interface McpCredentialReference {
  readonly id: string;
  readonly kind: "header" | "env" | "oauth" | "custom";
  readonly label?: string;
  /** Optional material version; stale references fail closed after rotation. */
  readonly version?: number;
}

export type CredentialStatus = "active" | "revoked";

/** Durable credential metadata. Secret material is deliberately absent from this record. */
export interface CredentialRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: McpCredentialReference["kind"];
  readonly label?: string;
  readonly status: CredentialStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
}

/** Host-owned credential metadata backend; implementations must never persist secret material here. */
export interface CredentialBackend {
  listCredentials(tenantId?: string): readonly CredentialRecord[];
  getCredential(tenantId: string, id: string): CredentialRecord | undefined;
  upsertCredential(record: CredentialRecord): CredentialRecord;
  deleteCredential(tenantId: string, id: string): boolean;
}

/** Productization readiness is host fact, not a promise that a UI may infer. */
export type ProductizationFeatureStatus = "available" | "configured" | "deferred" | "disabled" | "unavailable";

export interface ProductizationCapability {
  readonly version: 1;
  readonly enabled: boolean;
  readonly status: "configured" | "deferred" | "unavailable";
  readonly reason: string;
  readonly auth: {
    readonly status: ProductizationFeatureStatus;
    readonly mode: "disabled" | "bearer" | "jwt";
    readonly required: boolean;
  };
  readonly multiUser: {
    readonly status: ProductizationFeatureStatus;
    readonly principalCatalog: "disabled" | "host-local" | "external";
  };
  readonly tenantIsolation: {
    readonly status: ProductizationFeatureStatus;
    readonly sessionOwnership: "disabled" | "durable" | "external";
  };
  readonly quota: {
    readonly status: ProductizationFeatureStatus;
    readonly enforcement: "disabled" | "soft" | "hard";
  };
  readonly routing: {
    readonly status: ProductizationFeatureStatus;
    readonly providerCount: number;
    readonly modelSelector: "disabled" | "host-local" | "tenant-scoped";
  };
  readonly credentials: {
    readonly status: ProductizationFeatureStatus;
    readonly secretStore: "disabled" | "host-only" | "external";
    readonly redaction: "required" | "unavailable";
  };
  readonly operations: {
    readonly status: ProductizationFeatureStatus;
    readonly backup: "deferred" | "available";
    readonly migration: "deferred" | "available";
    readonly upgrade: "deferred" | "available";
  };
}

export interface McpConfigRecord {
  readonly name: string;
  readonly scope: McpServerScope;
  /** Optional tenant owner; absent keeps legacy local MCP behavior. */
  readonly tenantId?: string;
  readonly ownerId?: string;
  readonly workspaceRoot?: string;
  readonly sessionId?: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly credentialRef?: McpCredentialReference;
  /** Persisted configuration is already scrubbed; it must never contain secret values. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface McpConfigBackend {
  listMcpConfigs(): readonly McpConfigRecord[];
  upsertMcpConfig(record: McpConfigRecord): McpConfigRecord;
  deleteMcpConfig(name: string): boolean;
}

/** Durable tenant-scoped provider/model selection; credential values never belong here. */
export interface ModelRouteRecord {
  readonly tenantId: string;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly credentialRef?: McpCredentialReference;
  /** Optional host-owned model context capability; never contains credentials. */
  readonly contextCapability?: ModelContextCapability;
  readonly updatedAt: string;
}

export interface ModelRouteBackend {
  listModelRoutes(): readonly ModelRouteRecord[];
  upsertModelRoute(record: ModelRouteRecord): ModelRouteRecord;
  deleteModelRoute(tenantId: string): boolean;
}

export interface JsonSchema {
  readonly [key: string]: unknown;
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface ToolError {
  readonly code: string;
  readonly message: string;
  readonly remedy?: string;
}

export interface ToolDiff {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly truncated?: boolean;
}

export interface ToolUsage {
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface ToolPresentation {
  readonly kind: "tool" | "diff" | "terminal" | "permission";
  readonly title: string;
  readonly text?: string;
  readonly data?: unknown;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly output?: unknown;
  /** Complete result retained for audit/replay; callers may prefer modelView for presentation. */
  readonly audit?: unknown;
  /** Budgeted view safe to place in a model/UI context. */
  readonly modelView?: unknown;
  readonly error?: ToolError;
  readonly diff?: ToolDiff;
  readonly usage?: ToolUsage;
  readonly presentation?: ToolPresentation;
}

export interface ToolContext {
  readonly sessionId: SessionId;
  readonly turnId?: TurnId;
  readonly toolCallId: ToolCallId;
  readonly workspaceRoot: string;
  readonly caller: ToolCaller;
  readonly signal: AbortSignal;
  readonly reportProgress: (payload: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly appendEvent: (type: AgentEventType, payload: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly requestUserInput: (input: UserInteractionInput) => Promise<UserInteractionAnswer>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly executionMode: ToolExecutionMode;
  readonly riskLevel: ToolRiskLevel;
  readonly approvalMode: ToolApprovalMode;
  readonly interruptBehavior: ToolInterruptBehavior;
  readonly source?: ToolSource;
  readonly execute: (input: unknown, context: ToolContext) => Promise<ToolResult>;
  readonly presentCall?: (input: unknown) => ToolPresentation;
  readonly presentResult?: (result: ToolResult) => ToolPresentation;
}

export interface ToolCallProjection {
  readonly id: ToolCallId;
  readonly name: string;
  readonly status: ToolCallStatus;
  readonly riskLevel: ToolRiskLevel;
  readonly approvalMode: ToolApprovalMode;
  readonly turnId?: TurnId;
  readonly caller?: ToolCaller;
  readonly workspaceRoot?: string;
  readonly input?: unknown;
  readonly result?: ToolResult;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSequence: number;
}

export interface PermissionProjection {
  readonly id: PermissionId;
  readonly toolCallId: ToolCallId;
  readonly turnId?: TurnId;
  readonly toolName: string;
  readonly status: PermissionStatus;
  readonly riskLevel: ToolRiskLevel;
  readonly reason: string;
  readonly caller?: ToolCaller;
  readonly workspaceRoot?: string;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSequence: number;
}

export interface PermissionRequest {
  readonly id: PermissionId;
  readonly sessionId: SessionId;
  readonly turnId?: TurnId;
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly riskLevel: ToolRiskLevel;
  readonly reason: string;
  readonly input: unknown;
  readonly caller: ToolCaller;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface UserInteractionInput {
  readonly question: string;
  readonly options?: readonly InteractionOption[];
  readonly allowFreeform?: boolean;
}

export interface UserInteractionRequest extends UserInteractionInput {
  readonly id: InteractionId;
  readonly sessionId: SessionId;
  readonly turnId?: TurnId;
  readonly toolCallId: ToolCallId;
  readonly caller: ToolCaller;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface UserInteractionAnswer {
  readonly interactionId: InteractionId;
  readonly status: "answered" | "cancelled" | "expired";
  readonly answer?: string;
}

export interface CreateSessionInput {
  readonly workspaceRoot: string;
  readonly permissionPreset?: PermissionPreset;
  readonly metadata?: ChildSessionMetadata;
  readonly ownership?: SessionOwnership;
}

export interface SendMessageInput {
  readonly content: string;
}

export type AttachmentKind = "file" | "image";
export type AttachmentStatus = "accepted" | "rejected";

/** Durable, workspace-relative receipt for one browser-provided attachment. */
export interface AttachmentReceipt {
  readonly id: string;
  readonly status: AttachmentStatus;
  readonly fileName: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly kind: AttachmentKind;
  readonly createdAt: string;
  readonly relativePath?: string;
  readonly code?: string;
  readonly reason?: string;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  /** JSON arguments as emitted by the provider. */
  readonly arguments: string;
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
}

export type ChatMessage =
  | { readonly role: "system"; readonly content: string; readonly messageId?: string; readonly contextBoundary?: ContextBoundaryMetadata }
  | { readonly role: "user"; readonly content: string; readonly messageId?: string }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ModelToolCall[]; readonly responseId?: string; readonly messageId?: string }
  | { readonly role: "tool"; readonly content: string; readonly toolCallId: string; readonly messageId?: string };

export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ModelToolDefinition[];
  readonly toolChoice?: "auto" | "none" | "required" | { readonly type: "function"; readonly name: string };
  /** Provider-owned reasoning effort. Omitted means provider default. */
  readonly reasoningEffort?: string;
  /** Distinguishes the normal agent request from a tool-less summary request. */
  readonly purpose?: "agent" | "context_summary";
  readonly signal?: AbortSignal;
}

/** Provider/model limits used by the context budget layer. */
export interface ModelContextCapability {
  readonly provider: string;
  readonly model: string;
  /** Maximum input/context window accepted by the provider. */
  readonly maxInputTokens: number;
  /** Maximum output tokens available to a normal model request. */
  readonly maxOutputTokens: number;
  readonly supportsExactCount: boolean;
  readonly supportsPromptCache: boolean;
  /** Optional provenance supplied by a host registry or adapter. */
  readonly source?: "provider" | "estimate" | "hybrid";
}

/** Host-owned status for the optional Claude Code-style historical collapse layer. */
export interface ContextCollapseCapability {
  readonly version: 1;
  readonly enabled: boolean;
  readonly status: "deferred" | "unavailable";
  readonly reason: string;
  readonly features: {
    readonly readTimeProjection: boolean;
    readonly backgroundCollapse: boolean;
    readonly overflowDrain: boolean;
    readonly snip: boolean;
  };
}

/** Host policy knobs for Claude Code-style context budgeting. */
export interface ContextBudgetConfig {
  /** Fallback input window when the adapter does not expose capability metadata. */
  readonly contextWindowTokens?: number;
  /** Fallback output reservation when the adapter does not expose capability metadata. */
  readonly maxOutputTokens?: number;
  readonly autoCompactEnabled?: boolean;
  readonly autoCompactBufferTokens?: number;
  readonly warningBufferTokens?: number;
  readonly errorBufferTokens?: number;
  readonly blockingBufferTokens?: number;
  readonly summaryOutputReservationTokens?: number;
  /** Conservative growth allowance used by predictive preflight. */
  readonly predictiveGrowthTokens?: number;
}

export type ContextBudgetSource = "provider" | "estimate" | "hybrid";

/** Computed, request-scoped budget derived from capability and host policy. */
export interface ContextBudgetSnapshot {
  readonly capability: ModelContextCapability;
  readonly reservedOutputTokens: number;
  readonly effectiveWindowTokens: number;
  readonly autoCompactBufferTokens: number;
  readonly warningThreshold: number;
  readonly errorThreshold: number;
  readonly autoCompactThreshold: number;
  readonly blockingThreshold: number;
  readonly source: ContextBudgetSource;
}

export interface ContextWarningState {
  readonly tokenUsage: number;
  readonly percentLeft: number;
  readonly isAboveWarningThreshold: boolean;
  readonly isAboveErrorThreshold: boolean;
  readonly isAboveAutoCompactThreshold: boolean;
  readonly isAtBlockingLimit: boolean;
  readonly isPredictiveCompactRecommended: boolean;
}

export type ModelStreamPart =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_call_start"; readonly index: number; readonly id?: string; readonly name?: string }
  | { readonly type: "tool_call_delta"; readonly index: number; readonly arguments: string }
  | { readonly type: "tool_call_end"; readonly index: number }
  | { readonly type: "usage"; readonly usage: ModelUsage }
  | { readonly type: "error"; readonly code: string; readonly message: string; readonly status?: number; readonly providerCode?: string }
  | { readonly type: "done" };

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly reasoningTokens?: number;
}

export interface ChatModel {
  /** Optional capability metadata; absent adapters use a conservative host fallback. */
  readonly contextCapability?: ModelContextCapability;
  stream(request: ModelRequest): AsyncIterable<ModelStreamPart>;
  /** Optional provider exact token counter used by M02 near budget boundaries. */
  countTokens?(request: ModelRequest): Promise<number | undefined>;
}

export interface EventStore {
  append(input: AppendEventInput): Promise<AgentEvent>;
  list(sessionId: SessionId, afterSequence?: number): Promise<readonly AgentEvent[]>;
  /** Optional bounded history query. Legacy stores may only implement list(). */
  listPage?(sessionId: SessionId, options?: EventListOptions): Promise<EventPage>;
  project(sessionId: SessionId): Promise<SessionProjection | undefined>;
  subscribe(sessionId: SessionId, listener: EventListener): () => void;
}

export interface EventListOptions {
  /** Exclusive lower cursor. */
  readonly afterSequence?: number;
  /** Exclusive upper cursor, used when prepending older history. */
  readonly beforeSequence?: number;
  /** Maximum number of events returned. The page is always ordered ascending. */
  readonly limit?: number;
}

export interface EventPage {
  readonly events: readonly AgentEvent[];
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly oldestSequence?: number;
  readonly newestSequence?: number;
}

export interface SessionEventStore extends EventStore {
  createSession(workspaceRoot: string, permissionPreset?: PermissionPreset, idOrMetadata?: SessionId | ChildSessionMetadata, metadata?: ChildSessionMetadata, ownership?: SessionOwnership): Promise<SessionId>;
  listSessions(includeArchived?: boolean): Promise<readonly SessionSummary[]>;
  listTasks(sessionId?: SessionId): Promise<readonly TaskProjection[]>;
  listChildSessions(parentSessionId: SessionId): Promise<readonly SessionSummary[]>;
  createChildSession(input: { readonly id?: SessionId; readonly workspaceRoot: string; readonly permissionPreset: PermissionPreset; readonly metadata: ChildSessionMetadata; readonly ownership?: SessionOwnership }): Promise<SessionId>;
  claimCommand(input: ClaimCommandInput): Promise<CommandClaim>;
  getCommand(sessionId: SessionId, commandId: string): Promise<CommandRecord | undefined>;
  forkSession(sessionId: SessionId, workspaceRoot?: string, id?: SessionId, permissionPreset?: PermissionPreset): Promise<SessionId>;
}

export interface AppendEventInput {
  readonly sessionId: SessionId;
  readonly turnId?: TurnId;
  readonly correlationId?: string;
  readonly type: AgentEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type EventListener = (event: AgentEvent) => void;

export interface ClaimCommandInput {
  readonly sessionId: SessionId;
  readonly commandId: string;
  readonly kind: string;
  readonly request: unknown;
  readonly result: unknown;
}

export interface CommandRecord {
  readonly sessionId: SessionId;
  readonly commandId: string;
  readonly kind: string;
  readonly request: unknown;
  readonly result: unknown;
  readonly createdAt: string;
}

export interface CommandClaim {
  readonly created: boolean;
  readonly record: CommandRecord;
}
