/** Branded identifiers prevent accidental mixing of independent runtime ids. */
export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type TurnId = Brand<string, "TurnId">;
export type TaskId = Brand<string, "TaskId">;
export type ToolCallId = Brand<string, "ToolCallId">;
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
