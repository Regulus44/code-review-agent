import {
  brand,
  type AgentEvent,
  type AgentEventType,
  type AppendEventInput,
  type ClaimCommandInput,
  type CommandClaim,
  type CommandRecord,
  type EventListener,
  type InteractionProjection,
  type InteractionStatus,
  type InteractionOption,
  type PermissionId,
  type PermissionProjection,
  type PermissionStatus,
  type SessionEventStore,
  type SessionId,
  type SessionProjection,
  type SessionStatus,
  type SessionSummary,
  type PermissionPreset,
  type PlanStatus,
  type TaskProjection,
  type TaskStatus,
  type ToolApprovalMode,
  type ToolCallId,
  type ToolCallProjection,
  type ToolCallStatus,
  type ToolResult,
  type ToolRiskLevel,
  type TodoItem,
  type TodoStatus,
  type TurnProjection,
  type TurnStatus,
} from "@code-review-agent/contracts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const SCHEMA_VERSION = 1 as const;

function isPermissionPreset(value: unknown): value is PermissionPreset {
  return value === "read-only" || value === "workspace-write" || value === "ask-on-write" || value === "ask-on-execute" || value === "danger-full-access";
}

function now(): string {
  return new Date().toISOString();
}

function eventId(): string {
  return `evt_${randomUUID()}`;
}

function newSessionId(): SessionId {
  return brand<string, "SessionId">(`ses_${randomUUID()}`);
}

function baseProjection(id: SessionId, workspaceRoot: string, permissionPreset: PermissionPreset = "ask-on-write", timestamp = now()): SessionProjection {
  return {
    id,
    workspaceRoot,
    permissionPreset,
    archived: false,
    deleted: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "idle",
    lastSequence: 0,
    messages: [],
    turns: [],
    tasks: [],
    plan: { content: "", status: "cleared", updatedAt: timestamp, lastSequence: 0 },
    todos: [],
    interactions: [],
    toolCalls: [],
    permissions: [],
  };
}

function statusFromTurn(status: unknown): SessionStatus | undefined {
  if (status === "failed") return "failed";
  if (status === "stopped") return "stopped";
  if (status === "interrupted") return "interrupted";
  if (status === "completed") return "idle";
  return undefined;
}

function turnStatus(value: unknown, fallback: TurnStatus): TurnStatus {
  return value === "queued" || value === "running" || value === "completed" || value === "stopped" || value === "failed" || value === "interrupted"
    ? value
    : fallback;
}

function taskStatus(value: unknown, fallback: TaskStatus): TaskStatus {
  return value === "queued" || value === "running" || value === "waiting" || value === "completed" || value === "failed" || value === "cancelled" || value === "blocked"
    ? value
    : fallback;
}

function planStatus(value: unknown, fallback: PlanStatus): PlanStatus {
  return value === "draft" || value === "active" || value === "approved" || value === "rejected" || value === "cleared" ? value : fallback;
}

function todoStatus(value: unknown, fallback: TodoStatus): TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled" ? value : fallback;
}

function interactionStatus(value: unknown, fallback: InteractionStatus): InteractionStatus {
  return value === "pending" || value === "answered" || value === "cancelled" || value === "expired" ? value : fallback;
}

function interactionOptions(value: unknown): readonly InteractionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): InteractionOption[] => {
    if (typeof item !== "object" || item === null) return [];
    const option = item as Record<string, unknown>;
    return typeof option["label"] === "string" && typeof option["value"] === "string" ? [{ label: option["label"], value: option["value"] }] : [];
  });
}

function toolCallStatus(value: unknown, fallback: ToolCallStatus): ToolCallStatus {
  return value === "pending" || value === "awaiting_permission" || value === "running" || value === "completed" || value === "failed" || value === "cancelled" || value === "denied"
    ? value
    : fallback;
}

function permissionStatus(value: unknown, fallback: PermissionStatus): PermissionStatus {
  return value === "pending" || value === "approved" || value === "denied" || value === "cancelled" || value === "expired" ? value : fallback;
}

function deriveActiveStatus(projection: SessionProjection): SessionStatus {
  if (projection.turns.some((turn) => turn.status === "running")) return "running";
  if (projection.turns.some((turn) => turn.status === "queued")) return "queued";
  return "idle";
}

function applyEvent(projection: SessionProjection, event: AgentEvent): SessionProjection {
  let next: SessionProjection = {
    ...projection,
    plan: projection.plan ?? { content: "", status: "cleared", updatedAt: event.createdAt, lastSequence: 0 },
    todos: projection.todos ?? [],
    interactions: projection.interactions ?? [],
    updatedAt: event.createdAt,
    lastSequence: event.sequence,
  };

  if (event.type === "session/created" || event.type === "session/updated" || event.type === "session/deleted") {
    const workspaceRoot = event.payload["workspaceRoot"];
    if (typeof workspaceRoot === "string") next = { ...next, workspaceRoot };
    const permissionPreset = event.payload["permissionPreset"];
    if (isPermissionPreset(permissionPreset)) next = { ...next, permissionPreset };
    if (typeof event.payload["archived"] === "boolean") next = { ...next, archived: event.payload["archived"] };
    if (event.type === "session/deleted" || event.payload["deleted"] === true) next = { ...next, deleted: true };
  }

  const turnId = event.turnId;
  if (turnId !== undefined) {
    const current = next.turns.find((turn) => turn.id === turnId);
    const timestamp = event.createdAt;
    const initial: TurnProjection = current ?? {
      id: turnId,
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSequence: event.sequence,
    };
    let updated: TurnProjection = { ...initial, updatedAt: timestamp, lastSequence: event.sequence };

    if (event.type === "user/message") {
      const content = event.payload["content"];
      if (typeof content === "string") updated = { ...updated, userMessage: content };
    }
    if (event.type === "turn/queued") updated = { ...updated, status: "queued" };
    if (event.type === "turn/started") updated = { ...updated, status: "running", startedAt: timestamp };
    if (event.type === "assistant/chunk") {
      const text = event.payload["text"];
      if (typeof text === "string") updated = { ...updated, assistantMessage: `${updated.assistantMessage ?? ""}${text}` };
    }
    if (event.type === "assistant/message") {
      const content = event.payload["content"];
      if (typeof content === "string") updated = { ...updated, assistantMessage: content };
    }
    if (event.type === "turn/ended") {
      updated = {
        ...updated,
        status: turnStatus(event.payload["status"], "completed"),
        endedAt: timestamp,
      };
    }
    if (event.type === "agent/status") {
      const status = turnStatus(event.payload["status"], updated.status);
      if (status === "stopped" || status === "interrupted") updated = { ...updated, status, endedAt: timestamp };
    }

    const turns = current === undefined ? [...next.turns, updated] : next.turns.map((turn) => (turn.id === turnId ? updated : turn));
    next = { ...next, turns };
  }

  if (event.type === "user/message") {
    const content = event.payload["content"];
    if (typeof content === "string") {
      next = {
        ...next,
        messages: [
          ...next.messages,
          {
            role: "user",
            content,
            ...(turnId === undefined ? {} : { turnId }),
          },
        ],
      };
    }
  }
  if (event.type === "assistant/message") {
    const content = event.payload["content"];
    if (typeof content === "string" && content.length > 0) {
      next = {
        ...next,
        messages: [
          ...next.messages,
          {
            role: "assistant",
            content,
            ...(turnId === undefined ? {} : { turnId }),
          },
        ],
      };
    }
  }

  if (event.type === "task/created" || event.type === "task/updated" || event.type === "task/ended") {
    const rawTaskId = event.payload["taskId"];
    if (typeof rawTaskId === "string") {
      const id = brand<string, "TaskId">(rawTaskId);
      const current = next.tasks.find((task) => task.id === id);
      const task: TaskProjection = {
        ...(current ?? {
          id,
          status: "queued" as const,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          lastSequence: event.sequence,
        }),
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
        ...(event.type === "task/created" ? { status: "queued" as const } : {}),
        ...(event.type === "task/updated" ? { status: taskStatus(event.payload["status"], current?.status ?? "queued") } : {}),
        ...(event.type === "task/ended" ? { status: taskStatus(event.payload["status"], "completed") } : {}),
        ...(typeof event.payload["title"] === "string" ? { title: event.payload["title"] as string } : {}),
        ...(Object.prototype.hasOwnProperty.call(event.payload, "result") ? { result: event.payload["result"] } : {}),
      };
      next = {
        ...next,
        tasks: current === undefined ? [...next.tasks, task] : next.tasks.map((item) => (item.id === id ? task : item)),
      };
    }
  }

  if (event.type === "plan/updated") {
    const content = typeof event.payload["content"] === "string" ? event.payload["content"] : next.plan.content;
    const status = planStatus(event.payload["status"], next.plan.status);
    next = { ...next, plan: { content, status, updatedAt: event.createdAt, lastSequence: event.sequence } };
  }

  if (event.type === "todo/updated") {
    const rawTodos = event.payload["todos"];
    if (Array.isArray(rawTodos)) {
      const todos: TodoItem[] = rawTodos.flatMap((item): TodoItem[] => {
        if (typeof item !== "object" || item === null) return [];
        const value = item as Record<string, unknown>;
        if (typeof value["id"] !== "string" || typeof value["content"] !== "string") return [];
        const status = todoStatus(value["status"], "pending");
        return [{ id: value["id"], content: value["content"], status, ...(typeof value["activeForm"] === "string" ? { activeForm: value["activeForm"] } : {}) }];
      });
      next = { ...next, todos };
    }
  }

  if (event.type === "tool/call" || event.type === "tool/progress" || event.type === "tool/result") {
    const rawToolCallId = event.payload["toolCallId"];
    if (typeof rawToolCallId === "string") {
      const id = brand<string, "ToolCallId">(rawToolCallId);
      const current = next.toolCalls.find((toolCall) => toolCall.id === id);
      const input = event.payload["input"];
      const initial: ToolCallProjection = current ?? {
        id,
        name: typeof event.payload["name"] === "string" ? event.payload["name"] : "unknown",
        status: "pending",
        riskLevel: (event.payload["riskLevel"] as ToolRiskLevel | undefined) ?? "read",
        approvalMode: (event.payload["approvalMode"] as ToolApprovalMode | undefined) ?? "auto",
        ...(event.payload["caller"] === "agent" || event.payload["caller"] === "user" || event.payload["caller"] === "system" ? { caller: event.payload["caller"] } : {}),
        ...(typeof event.payload["workspaceRoot"] === "string" ? { workspaceRoot: event.payload["workspaceRoot"] } : {}),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        ...(input === undefined ? {} : { input }),
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
      };
      const rawResult = event.payload["result"];
      const result = rawResult !== undefined ? rawResult as ToolResult : undefined;
      const status = event.type === "tool/call"
        ? "pending"
        : event.type === "tool/progress"
          ? "running"
          : toolCallStatus(event.payload["status"], result?.ok === true ? "completed" : "failed");
      const updated: ToolCallProjection = {
        ...initial,
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
        status,
        ...(result === undefined ? {} : { result }),
        ...(event.turnId === undefined || initial.turnId !== undefined ? {} : { turnId: event.turnId }),
      };
      next = {
        ...next,
        toolCalls: current === undefined ? [...next.toolCalls, updated] : next.toolCalls.map((item) => (item.id === id ? updated : item)),
      };
    }
  }

  if (event.type === "permission/requested" || event.type === "permission/resolved") {
    const rawPermissionId = event.payload["permissionId"];
    const rawToolCallId = event.payload["toolCallId"];
    if (typeof rawPermissionId === "string" && typeof rawToolCallId === "string") {
      const id = brand<string, "PermissionId">(rawPermissionId);
      const current = next.permissions.find((permission) => permission.id === id);
      const initial: PermissionProjection = current ?? {
        id,
        toolCallId: brand<string, "ToolCallId">(rawToolCallId),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        toolName: typeof event.payload["toolName"] === "string" ? event.payload["toolName"] : "unknown",
        status: "pending",
        riskLevel: (event.payload["riskLevel"] as ToolRiskLevel | undefined) ?? "write",
        reason: typeof event.payload["reason"] === "string" ? event.payload["reason"] : "Tool approval required",
        ...(event.payload["caller"] === "agent" || event.payload["caller"] === "user" || event.payload["caller"] === "system" ? { caller: event.payload["caller"] } : {}),
        ...(typeof event.payload["workspaceRoot"] === "string" ? { workspaceRoot: event.payload["workspaceRoot"] } : {}),
        ...(typeof event.payload["expiresAt"] === "string" ? { expiresAt: event.payload["expiresAt"] } : {}),
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
      };
      const updated: PermissionProjection = {
        ...initial,
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
        status: event.type === "permission/requested" ? "pending" : permissionStatus(event.payload["status"], "cancelled"),
      };
      next = {
        ...next,
        permissions: current === undefined ? [...next.permissions, updated] : next.permissions.map((item) => (item.id === id ? updated : item)),
      };
      const toolCall = next.toolCalls.find((item) => item.id === updated.toolCallId);
      if (toolCall !== undefined && event.type === "permission/requested") {
        next = { ...next, toolCalls: next.toolCalls.map((item) => (item.id === toolCall.id ? { ...item, status: "awaiting_permission", updatedAt: event.createdAt, lastSequence: event.sequence } : item)) };
      }
    }
  }

  if (event.type === "interaction/requested" || event.type === "interaction/resolved") {
    const rawInteractionId = event.payload["interactionId"];
    const rawToolCallId = event.payload["toolCallId"];
    const question = event.payload["question"];
    if (typeof rawInteractionId === "string" && typeof rawToolCallId === "string" && typeof question === "string") {
      const options = interactionOptions(event.payload["options"]);
      const current = next.interactions.find((interaction) => interaction.id === rawInteractionId);
      const initial: InteractionProjection = current ?? {
        id: brand<string, "InteractionId">(rawInteractionId),
        toolCallId: brand<string, "ToolCallId">(rawToolCallId),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        question,
        options,
        allowFreeform: event.payload["allowFreeform"] !== false,
        status: "pending",
        createdAt: typeof event.payload["createdAt"] === "string" ? event.payload["createdAt"] : event.createdAt,
        updatedAt: event.createdAt,
        expiresAt: typeof event.payload["expiresAt"] === "string" ? event.payload["expiresAt"] : new Date(Date.parse(event.createdAt) + 15 * 60_000).toISOString(),
        lastSequence: event.sequence,
      };
      const status = event.type === "interaction/requested" ? "pending" : interactionStatus(event.payload["status"], "cancelled");
      const updated: InteractionProjection = {
        ...initial,
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
        status,
        ...(typeof event.payload["answer"] === "string" ? { answer: event.payload["answer"] } : {}),
      };
      next = { ...next, interactions: current === undefined ? [...next.interactions, updated] : next.interactions.map((item) => (item.id === updated.id ? updated : item)) };
    }
  }

  if (event.type === "turn/started") {
    next = { ...next, status: "running" };
  } else if (event.type === "turn/queued") {
    next = { ...next, status: next.status === "running" ? "running" : "queued" };
  } else if (event.type === "turn/ended") {
    const terminal = statusFromTurn(event.payload["status"]);
    next = { ...next, status: terminal === "idle" ? deriveActiveStatus(next) : terminal ?? deriveActiveStatus(next) };
  } else if (event.type === "agent/error") {
    next = { ...next, status: "failed" };
  } else if (event.type === "agent/status") {
    const status = event.payload["status"];
    if (status === "stopped" || status === "interrupted" || status === "failed" || status === "idle" || status === "running" || status === "queued") {
      next = { ...next, status };
    }
    if (status === "interrupted" || status === "stopped") {
      next = {
        ...next,
        turns: next.turns.map((turn) => (turn.status === "running" ? { ...turn, status, endedAt: event.createdAt, updatedAt: event.createdAt, lastSequence: event.sequence } : turn)),
      };
    }
  }

  return next;
}

/** Rebuilds the read model from an ordered event fixture. */
export function replayProjection(initial: SessionProjection, events: readonly AgentEvent[]): SessionProjection {
  return events.reduce(applyEvent, initial);
}

interface MemorySession {
  events: AgentEvent[];
  listeners: Set<EventListener>;
  projection: SessionProjection;
  commands: Map<string, CommandRecord>;
}

/** Deterministic in-memory store retained for unit tests and local fixtures. */
export class InMemoryEventStore implements SessionEventStore {
  private readonly sessions = new Map<SessionId, MemorySession>();

  async createSession(workspaceRoot: string, permissionPreset: PermissionPreset = "ask-on-write", id = newSessionId()): Promise<SessionId> {
    if (this.sessions.has(id)) throw new Error(`Session already exists: ${id}`);
    const projection = baseProjection(id, workspaceRoot, permissionPreset);
    this.sessions.set(id, { events: [], listeners: new Set(), projection, commands: new Map() });
    await this.append({ sessionId: id, type: "session/created", payload: { workspaceRoot, permissionPreset } });
    return id;
  }

  async append(input: AppendEventInput): Promise<AgentEvent> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) throw new Error(`Unknown session: ${input.sessionId}`);
    const event: AgentEvent = {
      eventId: eventId(),
      sequence: session.events.length + 1,
      schemaVersion: SCHEMA_VERSION,
      sessionId: input.sessionId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      type: input.type,
      createdAt: now(),
      payload: input.payload,
    };
    session.events.push(event);
    session.projection = applyEvent(session.projection, event);
    for (const listener of session.listeners) listener(event);
    return event;
  }

  async list(sessionId: SessionId, afterSequence = 0): Promise<readonly AgentEvent[]> {
    return this.sessions.get(sessionId)?.events.filter((event) => event.sequence > afterSequence) ?? [];
  }

  async listSessions(includeArchived = false): Promise<readonly SessionSummary[]> {
    return [...this.sessions.values()]
      .map((session) => toSummary(session.projection))
      .filter((session) => !session.deleted && (includeArchived || !session.archived));
  }

  async project(sessionId: SessionId): Promise<SessionProjection | undefined> {
    return this.sessions.get(sessionId)?.projection;
  }

  subscribe(sessionId: SessionId, listener: EventListener): () => void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return () => undefined;
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  async claimCommand(input: ClaimCommandInput): Promise<CommandClaim> {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) throw new Error(`Unknown session: ${input.sessionId}`);
    const existing = session.commands.get(input.commandId);
    if (existing !== undefined) {
      assertSameCommand(existing, input);
      return { created: false, record: existing };
    }
    const record: CommandRecord = {
      sessionId: input.sessionId,
      commandId: input.commandId,
      kind: input.kind,
      request: input.request,
      result: input.result,
      createdAt: now(),
    };
    session.commands.set(input.commandId, record);
    return { created: true, record };
  }

  async forkSession(sessionId: SessionId, workspaceRoot?: string, id?: SessionId, permissionPreset?: PermissionPreset): Promise<SessionId> {
    const source = await this.project(sessionId);
    if (source === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const forked = await this.createSession(workspaceRoot ?? source.workspaceRoot, permissionPreset ?? source.permissionPreset, id);
    for (const message of source.messages) {
      await this.append({
        sessionId: forked,
        ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        type: message.role === "user" ? "user/message" : "assistant/message",
        payload: { content: message.content, forkedFrom: sessionId },
      });
    }
    for (const turn of source.turns.filter((item) => item.status === "completed")) {
      await this.append({ sessionId: forked, turnId: turn.id, type: "turn/ended", payload: { status: "completed", forkedFrom: sessionId } });
    }
    return forked;
  }
}

interface SqliteRow {
  [key: string]: unknown;
}

export interface SqliteEventStoreOptions {
  readonly databasePath?: string;
}

/** Durable EventStore using the Node.js built-in SQLite driver. */
export class SqliteEventStore implements SessionEventStore {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly listeners = new Map<SessionId, Set<EventListener>>();

  constructor(options: SqliteEventStoreOptions | string = {}) {
    const configured = typeof options === "string" ? options : options.databasePath;
    this.databasePath = configured ?? defaultDatabasePath();
    if (this.databasePath !== ":memory:" && !this.databasePath.startsWith("file:")) {
      mkdirSync(dirname(resolve(this.databasePath)), { recursive: true });
    }
    this.db = new DatabaseSync(this.databasePath);
    this.migrate();
    this.rebuildProjections();
    this.recoverInterruptedSessions();
  }

  close(): void {
    this.db.close();
  }

  async createSession(workspaceRoot: string, permissionPreset: PermissionPreset = "ask-on-write", id = newSessionId()): Promise<SessionId> {
    const projection = baseProjection(id, workspaceRoot, permissionPreset);
    this.withTransaction(() => {
      this.db.prepare("INSERT INTO sessions (id, workspace_root, created_at, updated_at, status, last_sequence) VALUES (?, ?, ?, ?, ?, ?)").run(id, workspaceRoot, projection.createdAt, projection.updatedAt, projection.status, 0);
      this.db.prepare("INSERT INTO projections (session_id, schema_version, projection_json) VALUES (?, ?, ?)").run(id, SCHEMA_VERSION, JSON.stringify(projection));
      this.appendSync({ sessionId: id, type: "session/created", payload: { workspaceRoot, permissionPreset } });
    });
    return id;
  }

  async append(input: AppendEventInput): Promise<AgentEvent> {
    const event = this.withTransaction(() => this.appendSync(input));
    for (const listener of this.listeners.get(input.sessionId) ?? []) listener(event);
    return event;
  }

  async list(sessionId: SessionId, afterSequence = 0): Promise<readonly AgentEvent[]> {
    const rows = this.db.prepare("SELECT event_id, sequence, session_id, turn_id, correlation_id, type, created_at, payload_json, schema_version FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC").all(sessionId, afterSequence) as SqliteRow[];
    return rows.map(readEvent);
  }

  async listSessions(includeArchived = false): Promise<readonly SessionSummary[]> {
    const rows = this.db.prepare("SELECT s.id, s.workspace_root, s.created_at, s.updated_at, s.status, s.last_sequence, p.projection_json FROM sessions s JOIN projections p ON p.session_id = s.id ORDER BY s.updated_at DESC").all() as SqliteRow[];
    return rows.map(readSummary).filter((session) => !session.deleted && (includeArchived || !session.archived));
  }

  async project(sessionId: SessionId): Promise<SessionProjection | undefined> {
    const row = this.db.prepare("SELECT projection_json FROM projections WHERE session_id = ?").get(sessionId) as SqliteRow | undefined;
    return row === undefined ? undefined : JSON.parse(String(row["projection_json"])) as SessionProjection;
  }

  subscribe(sessionId: SessionId, listener: EventListener): () => void {
    let listeners = this.listeners.get(sessionId);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => listeners?.delete(listener);
  }

  async claimCommand(input: ClaimCommandInput): Promise<CommandClaim> {
    return this.withTransaction(() => {
      const session = this.db.prepare("SELECT id FROM sessions WHERE id = ?").get(input.sessionId) as SqliteRow | undefined;
      if (session === undefined) throw new Error(`Unknown session: ${input.sessionId}`);
      const existing = this.db.prepare("SELECT session_id, command_id, kind, request_json, result_json, created_at FROM commands WHERE session_id = ? AND command_id = ?").get(input.sessionId, input.commandId) as SqliteRow | undefined;
      if (existing !== undefined) {
        const record = readCommand(existing);
        assertSameCommand(record, input);
        return { created: false, record };
      }
      const record: CommandRecord = {
        sessionId: input.sessionId,
        commandId: input.commandId,
        kind: input.kind,
        request: input.request,
        result: input.result,
        createdAt: now(),
      };
      this.db.prepare("INSERT INTO commands (session_id, command_id, kind, request_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(input.sessionId, input.commandId, input.kind, JSON.stringify(input.request), JSON.stringify(input.result), record.createdAt);
      return { created: true, record };
    });
  }

  async forkSession(sessionId: SessionId, workspaceRoot?: string, id?: SessionId, permissionPreset?: PermissionPreset): Promise<SessionId> {
    const source = await this.project(sessionId);
    if (source === undefined) throw new Error(`Unknown session: ${sessionId}`);
    const forked = await this.createSession(workspaceRoot ?? source.workspaceRoot, permissionPreset ?? source.permissionPreset, id);
    for (const message of source.messages) {
      await this.append({
        sessionId: forked,
        ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        type: message.role === "user" ? "user/message" : "assistant/message",
        payload: { content: message.content, forkedFrom: sessionId },
      });
    }
    for (const turn of source.turns.filter((item) => item.status === "completed")) {
      await this.append({ sessionId: forked, turnId: turn.id, type: "turn/ended", payload: { status: "completed", forkedFrom: sessionId } });
    }
    return forked;
  }

  private appendSync(input: AppendEventInput): AgentEvent {
    const session = this.db.prepare("SELECT id, workspace_root, created_at, updated_at, status, last_sequence FROM sessions WHERE id = ?").get(input.sessionId) as SqliteRow | undefined;
    if (session === undefined) throw new Error(`Unknown session: ${input.sessionId}`);
    const currentProjection = this.db.prepare("SELECT projection_json FROM projections WHERE session_id = ?").get(input.sessionId) as SqliteRow | undefined;
    if (currentProjection === undefined) throw new Error(`Projection missing for session: ${input.sessionId}`);
    const sequence = Number(session["last_sequence"]) + 1;
    const event: AgentEvent = {
      eventId: eventId(),
      sequence,
      schemaVersion: SCHEMA_VERSION,
      sessionId: input.sessionId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      type: input.type,
      createdAt: now(),
      payload: input.payload,
    };
    const projection = applyEvent(JSON.parse(String(currentProjection["projection_json"])) as SessionProjection, event);
    this.db.prepare("INSERT INTO events (event_id, session_id, sequence, turn_id, correlation_id, type, created_at, payload_json, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(event.eventId, event.sessionId, event.sequence, event.turnId ?? null, event.correlationId ?? null, event.type, event.createdAt, JSON.stringify(event.payload), event.schemaVersion);
    this.db.prepare("UPDATE sessions SET updated_at = ?, status = ?, last_sequence = ? WHERE id = ?").run(projection.updatedAt, projection.status, projection.lastSequence, input.sessionId);
    this.db.prepare("UPDATE projections SET schema_version = ?, projection_json = ? WHERE session_id = ?").run(SCHEMA_VERSION, JSON.stringify(projection), input.sessionId);
    return event;
  }

  private withTransaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec("PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
    const current = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as SqliteRow;
    if (Number(current["version"]) >= SCHEMA_VERSION) return;
    this.withTransaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          workspace_root TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          status TEXT NOT NULL,
          last_sequence INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          event_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          turn_id TEXT,
          correlation_id TEXT,
          type TEXT NOT NULL,
          created_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          UNIQUE(session_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS events_session_sequence_idx ON events(session_id, sequence);
        CREATE TABLE IF NOT EXISTS projections (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          schema_version INTEGER NOT NULL,
          projection_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS commands (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          command_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          request_json TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(session_id, command_id)
        );
      `);
      this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, now());
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  private recoverInterruptedSessions(): void {
    const rows = this.db.prepare("SELECT id FROM sessions WHERE status = 'running'").all() as SqliteRow[];
    for (const row of rows) {
      const id = brand<string, "SessionId">(String(row["id"]));
      this.withTransaction(() => {
        this.appendSync({
          sessionId: id,
          type: "agent/status",
          payload: { status: "interrupted", reason: "process_restart" },
        });
      });
    }
  }

  private rebuildProjections(): void {
    const rows = this.db.prepare("SELECT id, workspace_root, created_at FROM sessions ORDER BY created_at ASC").all() as SqliteRow[];
    this.withTransaction(() => {
      for (const row of rows) {
        const id = brand<string, "SessionId">(String(row["id"]));
        const initial = baseProjection(id, String(row["workspace_root"]), "ask-on-write", String(row["created_at"]));
        const events = (this.db.prepare("SELECT event_id, sequence, session_id, turn_id, correlation_id, type, created_at, payload_json, schema_version FROM events WHERE session_id = ? ORDER BY sequence ASC").all(id) as SqliteRow[]).map(readEvent);
        const projection = replayProjection(initial, events);
        this.db.prepare("INSERT INTO projections (session_id, schema_version, projection_json) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET schema_version = excluded.schema_version, projection_json = excluded.projection_json").run(id, SCHEMA_VERSION, JSON.stringify(projection));
        this.db.prepare("UPDATE sessions SET updated_at = ?, status = ?, last_sequence = ? WHERE id = ?").run(projection.updatedAt, projection.status, projection.lastSequence, id);
      }
    });
  }
}

function toSummary(projection: SessionProjection): SessionSummary {
  const { id, workspaceRoot, permissionPreset, archived, deleted, createdAt, updatedAt, status, lastSequence } = projection;
  const firstUserMessage = projection.messages.find((message) => message.role === "user")?.content.trim();
  const title = firstUserMessage === undefined || firstUserMessage.length === 0
    ? undefined
    : firstUserMessage.length > 58 ? `${firstUserMessage.slice(0, 55)}…` : firstUserMessage;
  return { id, ...(title === undefined ? {} : { title }), workspaceRoot, permissionPreset, archived: archived ?? false, deleted: deleted ?? false, createdAt, updatedAt, status, lastSequence };
}

function readSummary(row: SqliteRow): SessionSummary {
  const projection = typeof row["projection_json"] === "string" ? JSON.parse(row["projection_json"] as string) as Partial<SessionProjection> : undefined;
  const firstUserMessage = projection?.messages?.find((message) => message.role === "user")?.content.trim();
  const title = firstUserMessage === undefined || firstUserMessage.length === 0
    ? undefined
    : firstUserMessage.length > 58 ? `${firstUserMessage.slice(0, 55)}…` : firstUserMessage;
  return {
    id: brand<string, "SessionId">(String(row["id"])),
    ...(title === undefined ? {} : { title }),
    workspaceRoot: String(row["workspace_root"]),
    permissionPreset: isPermissionPreset(projection?.permissionPreset) ? projection.permissionPreset : "ask-on-write",
    archived: projection?.archived === true,
    deleted: projection?.deleted === true,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    status: String(row["status"]) as SessionStatus,
    lastSequence: Number(row["last_sequence"]),
  };
}

function readEvent(row: SqliteRow): AgentEvent {
  const turnId = row["turn_id"];
  const correlationId = row["correlation_id"];
  return {
    eventId: String(row["event_id"]),
    sequence: Number(row["sequence"]),
    schemaVersion: Number(row["schema_version"]) as 1,
    sessionId: brand<string, "SessionId">(String(row["session_id"])),
    ...(turnId === null || turnId === undefined ? {} : { turnId: brand<string, "TurnId">(String(turnId)) }),
    ...(correlationId === null || correlationId === undefined ? {} : { correlationId: String(correlationId) }),
    type: String(row["type"]) as AgentEventType,
    createdAt: String(row["created_at"]),
    payload: JSON.parse(String(row["payload_json"])) as Record<string, unknown>,
  };
}

function readCommand(row: SqliteRow): CommandRecord {
  return {
    sessionId: brand<string, "SessionId">(String(row["session_id"])),
    commandId: String(row["command_id"]),
    kind: String(row["kind"]),
    request: JSON.parse(String(row["request_json"])),
    result: JSON.parse(String(row["result_json"])),
    createdAt: String(row["created_at"]),
  };
}

function assertSameCommand(existing: CommandRecord, input: ClaimCommandInput): void {
  if (existing.kind !== input.kind || JSON.stringify(existing.request) !== JSON.stringify(input.request)) {
    throw new Error(`Command id ${input.commandId} was already used for a different request`);
  }
}

function defaultDatabasePath(): string {
  const configured = process.env["CODE_REVIEW_AGENT_DB_PATH"];
  if (configured !== undefined && configured.length > 0) return configured;
  return isAbsolute(process.cwd()) ? resolve(process.cwd(), ".data", "code-review-agent.sqlite") : ".data/code-review-agent.sqlite";
}
