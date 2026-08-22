/** Branded identifiers prevent accidental mixing of independent runtime ids. */
export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type TurnId = Brand<string, "TurnId">;
export type TaskId = Brand<string, "TaskId">;
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
  | "user/message"
  | "turn/queued"
  | "turn/started"
  | "step/started"
  | "step/ended"
  | "turn/ended"
  | "assistant/chunk"
  | "assistant/message"
  | "task/created"
  | "task/updated"
  | "task/ended"
  | "plan/updated"
  | "todo/updated"
  | "tool/call"
  | "tool/progress"
  | "tool/result"
  | "diff/preview"
  | "permission/requested"
  | "permission/resolved"
  | "interaction/requested"
  | "interaction/resolved"
  | "terminal/session"
  | "mcp/server"
  | "mcp/tool"
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
export type PermissionPreset = "read-only" | "workspace-write" | "ask-on-write" | "ask-on-execute" | "danger-full-access";

export interface SessionSummary {
  readonly id: SessionId;
  readonly workspaceRoot: string;
  readonly permissionPreset: PermissionPreset;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: SessionStatus;
  readonly lastSequence: number;
}

export interface TurnProjection {
  readonly id: TurnId;
  readonly status: TurnStatus;
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
  readonly plan: PlanProjection;
  readonly todos: readonly TodoItem[];
  readonly interactions: readonly InteractionProjection[];
  readonly toolCalls: readonly ToolCallProjection[];
  readonly permissions: readonly PermissionProjection[];
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
  | { readonly kind: "mcp"; readonly serverName: string; readonly rawName: string };

export interface JsonSchema {
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
}

export interface SendMessageInput {
  readonly content: string;
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
  project(sessionId: SessionId): Promise<SessionProjection | undefined>;
  subscribe(sessionId: SessionId, listener: EventListener): () => void;
}

export interface SessionEventStore extends EventStore {
  createSession(workspaceRoot: string, permissionPreset?: PermissionPreset): Promise<SessionId>;
  listSessions(): Promise<readonly SessionSummary[]>;
  claimCommand(input: ClaimCommandInput): Promise<CommandClaim>;
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
