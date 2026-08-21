/** Branded identifiers prevent accidental mixing of independent runtime ids. */
export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type TurnId = Brand<string, "TurnId">;
export type TaskId = Brand<string, "TaskId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type PermissionId = Brand<string, "PermissionId">;
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
  | "turn/ended"
  | "assistant/chunk"
  | "assistant/message"
  | "task/created"
  | "task/updated"
  | "task/ended"
  | "tool/call"
  | "tool/progress"
  | "tool/result"
  | "diff/preview"
  | "permission/requested"
  | "permission/resolved"
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

export interface SessionSummary {
  readonly id: SessionId;
  readonly workspaceRoot: string;
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

export interface SessionProjection extends SessionSummary {
  readonly messages: readonly {
    readonly role: "user" | "assistant";
    readonly content: string;
    readonly turnId?: TurnId;
  }[];
  readonly turns: readonly TurnProjection[];
  readonly tasks: readonly TaskProjection[];
  readonly toolCalls: readonly ToolCallProjection[];
  readonly permissions: readonly PermissionProjection[];
}

export type ToolRiskLevel = "read" | "write" | "execute" | "network";
export type ToolExecutionMode = "parallel" | "exclusive";
export type ToolApprovalMode = "auto" | "ask" | "deny";
export type ToolInterruptBehavior = "cancel" | "block";
export type ToolCallStatus = "pending" | "awaiting_permission" | "running" | "completed" | "failed" | "cancelled" | "denied";
export type PermissionStatus = "pending" | "approved" | "denied" | "cancelled";

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
  readonly signal: AbortSignal;
  readonly reportProgress: (payload: Readonly<Record<string, unknown>>) => Promise<void>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly executionMode: ToolExecutionMode;
  readonly riskLevel: ToolRiskLevel;
  readonly approvalMode: ToolApprovalMode;
  readonly interruptBehavior: ToolInterruptBehavior;
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
  readonly input?: unknown;
  readonly result?: ToolResult;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSequence: number;
}

export interface PermissionProjection {
  readonly id: PermissionId;
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly status: PermissionStatus;
  readonly riskLevel: ToolRiskLevel;
  readonly reason: string;
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
  readonly createdAt: string;
}

export interface CreateSessionInput {
  readonly workspaceRoot: string;
}

export interface SendMessageInput {
  readonly content: string;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ModelRequest {
  readonly messages: readonly ChatMessage[];
  readonly signal?: AbortSignal;
}

export type ModelStreamPart =
  | { readonly type: "text_delta"; readonly text: string }
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
  createSession(workspaceRoot: string): Promise<SessionId>;
  listSessions(): Promise<readonly SessionSummary[]>;
  claimCommand(input: ClaimCommandInput): Promise<CommandClaim>;
  forkSession(sessionId: SessionId, workspaceRoot?: string, id?: SessionId): Promise<SessionId>;
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
