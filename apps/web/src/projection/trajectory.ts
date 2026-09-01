import type { AgentEvent, SessionId, TaskId, ToolCallId, TurnId } from "@coding-agent/contracts";

export type TrajectoryKind = "turn" | "step" | "assistant" | "tool" | "task" | "permission" | "interaction" | "event";

export interface TrajectoryRecord {
  readonly key: string;
  readonly kind: TrajectoryKind;
  readonly label: string;
  readonly status: string;
  readonly sourceSeq: number;
  readonly lastSeq: number;
  readonly sessionId: SessionId;
  readonly turnId?: TurnId;
  readonly taskId?: TaskId;
  readonly callId?: ToolCallId;
  readonly rootCallId?: string;
  readonly parentCallId?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly running: boolean;
  readonly detail?: unknown;
}

export interface TrajectoryProjection {
  readonly sessionId: SessionId;
  readonly records: readonly TrajectoryRecord[];
  readonly lastSequence: number;
}

interface MutableRecord {
  readonly key: string;
  readonly kind: TrajectoryKind;
  label: string;
  readonly sessionId: SessionId;
  readonly sourceSeq: number;
  lastSeq: number;
  status: string;
  turnId?: TurnId;
  taskId?: TaskId;
  callId?: ToolCallId;
  rootCallId?: string;
  parentCallId?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  running: boolean;
  detail?: unknown;
}

export interface MutableTrajectoryProjection {
  readonly sessionId: SessionId;
  readonly records: Map<string, MutableRecord>;
  lastSequence: number;
}

export function projectTrajectory(sessionId: SessionId, events: readonly AgentEvent[]): TrajectoryProjection {
  const projection: MutableTrajectoryProjection = { sessionId, records: new Map(), lastSequence: 0 };
  const bySequence = new Map<number, AgentEvent>();
  for (const event of events) if (event.sessionId === sessionId) bySequence.set(event.sequence, event);
  for (const event of [...bySequence.values()].sort((left, right) => left.sequence - right.sequence)) applyTrajectoryEvent(projection, event);
  return snapshotTrajectory(projection);
}

export function applyTrajectoryEvent(projection: MutableTrajectoryProjection, event: AgentEvent): boolean {
  if (event.sessionId !== projection.sessionId) return false;
  if (event.sequence <= projection.lastSequence && [...projection.records.values()].some((record) => record.lastSeq === event.sequence)) return false;
  projection.lastSequence = Math.max(projection.lastSequence, event.sequence);
  const turnId = event.turnId;

  if (event.type === "turn/queued" || event.type === "turn/started" || event.type === "turn/ended") {
    if (turnId === undefined) return false;
    const status = event.type === "turn/queued" ? "queued" : event.type === "turn/started" ? "running" : stringValue(event.payload["status"]) ?? "completed";
    upsert(projection, `turn:${turnId}`, "turn", `Turn ${String(turnId)}`, event, {
      status,
      ...(turnId === undefined ? {} : { turnId }),
      terminal: event.type === "turn/ended",
      detail: event.payload,
    });
    return true;
  }

  if (event.type === "step/started" || event.type === "step/ended") {
    if (turnId === undefined) return false;
    const step = numberValue(event.payload["step"]);
    if (step === undefined) return false;
    upsert(projection, `step:${turnId}:${step}`, "step", `Step ${step}`, event, {
      status: event.type === "step/started" ? "running" : stringValue(event.payload["status"]) ?? "completed",
      turnId,
      terminal: event.type === "step/ended",
      detail: event.payload,
    });
    return true;
  }

  if (event.type === "assistant/chunk" || event.type === "assistant/message") {
    const key = `assistant:${turnId ?? event.eventId}`;
    upsert(projection, key, "assistant", "Assistant", event, {
      status: event.type === "assistant/chunk" ? "streaming" : "completed",
      ...(turnId === undefined ? {} : { turnId }),
      terminal: event.type === "assistant/message",
      detail: event.type === "assistant/message" ? event.payload["content"] : event.payload["text"],
    });
    return true;
  }

  if (event.type === "tool/call" || event.type === "tool/progress" || event.type === "tool/result") {
    const rawId = stringValue(event.payload["toolCallId"]);
    if (rawId === undefined) return false;
    const callId = rawId as ToolCallId;
    const name = stringValue(event.payload["name"]) ?? `Tool ${rawId}`;
    const status = event.type === "tool/call" ? "pending" : event.type === "tool/progress" ? "running" : stringValue(event.payload["status"]) ?? "completed";
    const rootCallId = stringValue(event.payload["rootCallId"]);
    const parentCallId = stringValue(event.payload["parentCallId"]);
    upsert(projection, `tool:${rawId}`, "tool", name, event, {
      status,
      ...(turnId === undefined ? {} : { turnId }),
      callId,
      ...(rootCallId === undefined ? {} : { rootCallId }),
      ...(parentCallId === undefined ? {} : { parentCallId }),
      terminal: event.type === "tool/result",
      detail: event.payload["result"] ?? event.payload["message"] ?? event.payload["input"],
    });
    return true;
  }

  if (event.type.startsWith("task/")) {
    const rawId = stringValue(event.payload["taskId"]);
    if (rawId === undefined) return false;
    const taskId = rawId as TaskId;
    const status = event.type === "task/input-required" ? "waiting" : event.type === "task/ended" ? stringValue(event.payload["status"]) ?? "completed" : event.type === "task/report" ? "reported" : stringValue(event.payload["status"]) ?? "queued";
    upsert(projection, `task:${rawId}`, "task", stringValue(event.payload["title"]) ?? `Task ${rawId}`, event, {
      status,
      taskId,
      terminal: event.type === "task/ended",
      detail: event.payload["report"] ?? event.payload["artifact"] ?? event.payload,
    });
    return true;
  }

  if (event.type === "permission/requested" || event.type === "permission/resolved") {
    const id = stringValue(event.payload["permissionId"]);
    if (id === undefined) return false;
    upsert(projection, `permission:${id}`, "permission", stringValue(event.payload["toolName"]) ?? "Permission", event, {
      status: event.type === "permission/requested" ? "pending" : stringValue(event.payload["status"]) ?? "resolved",
      ...(turnId === undefined ? {} : { turnId }),
      terminal: event.type === "permission/resolved",
      detail: event.payload,
    });
    return true;
  }

  if (event.type === "interaction/requested" || event.type === "interaction/resolved") {
    const id = stringValue(event.payload["interactionId"]);
    if (id === undefined) return false;
    upsert(projection, `interaction:${id}`, "interaction", "Agent question", event, {
      status: event.type === "interaction/requested" ? "pending" : stringValue(event.payload["status"]) ?? "resolved",
      ...(turnId === undefined ? {} : { turnId }),
      terminal: event.type === "interaction/resolved",
      detail: event.payload,
    });
    return true;
  }

  if (event.type === "agent/error") {
    upsert(projection, `event:${event.eventId}`, "event", "Agent error", event, { status: "failed", terminal: true, detail: event.payload });
    return true;
  }
  return false;
}

export function snapshotTrajectory(projection: MutableTrajectoryProjection): TrajectoryProjection {
  return {
    sessionId: projection.sessionId,
    records: [...projection.records.values()].sort((left, right) => left.sourceSeq - right.sourceSeq || left.key.localeCompare(right.key)).map((record) => ({
      key: record.key,
      kind: record.kind,
      label: record.label,
      status: record.status,
      sourceSeq: record.sourceSeq,
      lastSeq: record.lastSeq,
      sessionId: record.sessionId,
      ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
      ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
      ...(record.callId === undefined ? {} : { callId: record.callId }),
      ...(record.rootCallId === undefined ? {} : { rootCallId: record.rootCallId }),
      ...(record.parentCallId === undefined ? {} : { parentCallId: record.parentCallId }),
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
      ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
      running: record.running,
      ...(record.detail === undefined ? {} : { detail: record.detail }),
    })),
    lastSequence: projection.lastSequence,
  };
}

function upsert(
  projection: MutableTrajectoryProjection,
  key: string,
  kind: TrajectoryKind,
  label: string,
  event: AgentEvent,
  input: {
    readonly status: string;
    readonly terminal: boolean;
    readonly turnId?: TurnId;
    readonly taskId?: TaskId;
    readonly callId?: ToolCallId;
    readonly rootCallId?: string;
    readonly parentCallId?: string;
    readonly detail?: unknown;
  },
): void {
  const current = projection.records.get(key);
  const next: MutableRecord = current ?? {
    key,
    kind,
    label,
    sessionId: projection.sessionId,
    sourceSeq: event.sequence,
    lastSeq: event.sequence,
    status: input.status,
    running: !input.terminal,
  };
  next.lastSeq = Math.max(next.lastSeq, event.sequence);
  next.status = input.status;
  next.label = label;
  next.running = !input.terminal;
  if (next.startedAt === undefined && !input.terminal) next.startedAt = event.createdAt;
  if (input.terminal) {
    next.endedAt = event.createdAt;
    next.running = false;
    if (next.startedAt !== undefined) {
      const duration = Date.parse(event.createdAt) - Date.parse(next.startedAt);
      if (Number.isFinite(duration) && duration >= 0) next.durationMs = duration;
    }
  }
  if (input.turnId !== undefined) next.turnId = input.turnId;
  if (input.taskId !== undefined) next.taskId = input.taskId;
  if (input.callId !== undefined) next.callId = input.callId;
  if (input.rootCallId !== undefined) next.rootCallId = input.rootCallId;
  if (input.parentCallId !== undefined) next.parentCallId = input.parentCallId;
  if (input.detail !== undefined) next.detail = input.detail;
  projection.records.set(key, next);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
