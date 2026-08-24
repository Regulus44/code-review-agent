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
  readonly worktrees?: readonly WorktreeProjection[];
}

export type ContextCompactionStatus = "completed" | "failed";

export interface ContextCompactionProjection {
  readonly status: ContextCompactionStatus;
  readonly sourceSequence: number;
  readonly summary: string;
  readonly originalMessageCount: number;
  readonly compactedMessageCount: number;
  readonly estimatedTokens: number;
  readonly droppedMessages: number;
  readonly protectedMessageCount?: number;
  readonly truncatedToolResults?: number;
  readonly updatedAt: string;
  readonly lastSequence: number;
  readonly error?: string;
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
  | { readonly role: "system" | "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ModelToolCall[] }
  | { readonly role: "tool"; readonly content: string; readonly toolCallId: string };

export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ModelToolDefinition[];
  readonly toolChoice?: "auto" | "none" | "required" | { readonly type: "function"; readonly name: string };
  readonly signal?: AbortSignal;
}

export type ModelStreamPart =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_call_start"; readonly index: number; readonly id?: string; readonly name?: string }
  | { readonly type: "tool_call_delta"; readonly index: number; readonly arguments: string }
  | { readonly type: "tool_call_end"; readonly index: number }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | { readonly type: "done" };

export interface ChatModel {
  stream(request: ModelRequest): AsyncIterable<ModelStreamPart>;
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
