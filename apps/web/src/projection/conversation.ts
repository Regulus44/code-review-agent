import type {
  AgentEvent,
  InteractionId,
  PermissionId,
  SessionId,
  TaskId,
  ToolCallId,
  ToolCallStatus,
  ToolCaller,
  ToolRiskLevel,
  TurnId,
} from "@code-review-agent/contracts";

export type ConversationNodeKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "turn"
  | "tool"
  | "permission"
  | "interaction"
  | "task"
  | "event";

export interface ConversationNodeBase {
  readonly key: string;
  readonly kind: ConversationNodeKind;
  readonly sequence: number;
  readonly lastSequence: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly eventType: string;
  readonly turnId?: TurnId;
}

export interface MessageNode extends ConversationNodeBase {
  readonly kind: "user" | "assistant" | "reasoning";
  readonly content: string;
  readonly partial: boolean;
}

export interface TurnNode extends ConversationNodeBase {
  readonly kind: "turn";
  readonly status: "queued" | "running" | "completed" | "stopped" | "failed" | "interrupted" | "unknown";
}

export interface ToolCallView {
  readonly id: ToolCallId;
  readonly name: string;
  readonly status: ToolCallStatus | "unknown";
  readonly riskLevel: ToolRiskLevel | "unknown";
  readonly input?: unknown;
  readonly result?: unknown;
  readonly progress?: readonly string[];
  readonly presentation?: unknown;
  readonly rootCallId?: string;
  readonly parentCallId?: string;
  readonly turnId?: TurnId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sequence: number;
  readonly lastSequence: number;
}

export interface ToolNode extends ConversationNodeBase {
  readonly kind: "tool";
  readonly tool: ToolCallView;
}

export interface PermissionNode extends ConversationNodeBase {
  readonly kind: "permission";
  readonly permissionId: PermissionId;
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
  readonly status: "pending" | "approved" | "denied" | "cancelled" | "expired" | "unknown";
  readonly reason: string;
  readonly caller?: ToolCaller;
  readonly workspaceRoot?: string;
  readonly expiresAt?: string;
  readonly input?: unknown;
}

export interface InteractionNode extends ConversationNodeBase {
  readonly kind: "interaction";
  readonly interactionId: InteractionId;
  readonly toolCallId: ToolCallId;
  readonly question: string;
  readonly status: "pending" | "answered" | "cancelled" | "expired" | "unknown";
  readonly caller?: ToolCaller;
  readonly allowFreeform: boolean;
  readonly expiresAt?: string;
  readonly answer?: string;
  readonly options: readonly { readonly label: string; readonly value: string }[];
}

export interface TaskNode extends ConversationNodeBase {
  readonly kind: "task";
  readonly taskId: TaskId;
  readonly status: string;
  readonly title?: string;
  readonly childSessionId?: SessionId;
  readonly summary?: string;
}

export interface GenericEventNode extends ConversationNodeBase {
  readonly kind: "event";
  readonly payload: Readonly<Record<string, unknown>>;
}

export type ConversationNode =
  | MessageNode
  | TurnNode
  | ToolNode
  | PermissionNode
  | InteractionNode
  | TaskNode
  | GenericEventNode;

export interface ConversationProjection {
  readonly sessionId: SessionId;
  readonly nodes: readonly ConversationNode[];
  readonly tools: readonly ToolCallView[];
  readonly lastSequence: number;
}

export interface MutableConversationProjection {
  readonly sessionId: SessionId;
  readonly nodes: Map<string, ConversationNode>;
  readonly toolById: Map<ToolCallId, ToolCallView>;
  lastSequence: number;
}

export function projectConversation(sessionId: SessionId, events: readonly AgentEvent[]): ConversationProjection {
  const projection = createConversationProjection(sessionId);
  for (const event of uniqueSortedEvents(sessionId, events)) applyConversationEvent(projection, event);
  return snapshotConversationProjection(projection);
}

export function createConversationProjection(sessionId: SessionId): MutableConversationProjection {
  return { sessionId, nodes: new Map(), toolById: new Map(), lastSequence: 0 };
}

export function applyConversationEvent(projection: MutableConversationProjection, event: AgentEvent): boolean {
  if (event.sessionId !== projection.sessionId) return false;
  if (event.sequence <= projection.lastSequence && hasEventSequence(projection, event.sequence)) return false;

  projection.lastSequence = Math.max(projection.lastSequence, event.sequence);
  const turnId = event.turnId;
  const base = (key: string, kind: ConversationNodeKind, previous?: ConversationNode): ConversationNodeBase => ({
    key,
    kind,
    sequence: previous?.sequence ?? event.sequence,
    lastSequence: event.sequence,
    createdAt: previous?.createdAt ?? event.createdAt,
    updatedAt: event.createdAt,
    eventType: event.type,
    ...(turnId === undefined ? {} : { turnId }),
  });

  switch (event.type) {
    case "session/created":
    case "session/updated":
    case "session/deleted":
      return false;
    case "user/message": {
      const content = stringValue(event.payload["content"]);
      if (content === undefined) return markUnkeyedEvent(projection, event);
      const key = messageKey("user", turnId, event.eventId);
      const previous = projection.nodes.get(key);
      projection.nodes.set(key, { ...base(key, "user", previous), kind: "user", content, partial: false });
      return true;
    }
    case "assistant/chunk": {
      const text = stringValue(event.payload["text"]) ?? stringValue(event.payload["content"]);
      if (text === undefined || text.length === 0) return markUnkeyedEvent(projection, event);
      const channel = stringValue(event.payload["channel"]) ?? stringValue(event.payload["kind"]);
      const kind: "assistant" | "reasoning" = channel === "reasoning" || channel === "thought" ? "reasoning" : "assistant";
      const key = messageKey(kind, turnId, event.eventId);
      const previous = projection.nodes.get(key);
      const oldContent = isMessageNode(previous) ? previous.content : "";
      projection.nodes.set(key, {
        ...base(key, kind, previous),
        kind,
        content: `${oldContent}${text}`,
        partial: true,
      });
      return true;
    }
    case "assistant/message": {
      const content = stringValue(event.payload["content"]) ?? "";
      const key = messageKey("assistant", turnId, event.eventId);
      const previous = projection.nodes.get(key);
      const previousContent = isMessageNode(previous) ? previous.content : "";
      // A final message replaces the partial stream when it is non-empty; an
      // empty final message must not erase streamed text from a provider that
      // only emits tool calls.
      const finalContent = content.length > 0 ? content : previousContent;
      projection.nodes.set(key, {
        ...base(key, "assistant", previous),
        kind: "assistant",
        content: finalContent,
        partial: false,
      });
      return true;
    }
    case "turn/queued":
    case "turn/started":
    case "turn/ended": {
      if (turnId === undefined) return markUnkeyedEvent(projection, event);
      const key = `turn:${turnId}`;
      const previous = projection.nodes.get(key);
      projection.nodes.set(key, {
        ...base(key, "turn", previous),
        kind: "turn",
        status: turnStatus(event.type === "turn/queued" ? "queued" : event.type === "turn/started" ? "running" : event.payload["status"]),
      });
      return true;
    }
    case "tool/call":
    case "tool/progress":
    case "tool/result": {
      const rawId = stringValue(event.payload["toolCallId"]);
      if (rawId === undefined) return markUnkeyedEvent(projection, event);
      const id = rawId as ToolCallId;
      const previous = projection.toolById.get(id);
      const status = event.type === "tool/call"
        ? "pending"
        : event.type === "tool/progress"
          ? "running"
          : toolStatus(event.payload["status"], resultOk(event.payload["result"]) ? "completed" : "failed");
      const progress = event.type === "tool/progress"
        ? appendProgress(previous?.progress, event.payload["message"] ?? event.payload["text"])
        : previous?.progress;
      const parentCallId = stringValue(event.payload["parentCallId"]) ?? previous?.parentCallId;
      const rootCallId = stringValue(event.payload["rootCallId"]) ?? previous?.rootCallId;
      const tool: ToolCallView = {
        id,
        name: stringValue(event.payload["name"]) ?? previous?.name ?? "unknown",
        status,
        riskLevel: riskLevel(event.payload["riskLevel"]) ?? previous?.riskLevel ?? "unknown",
        ...(event.payload["input"] === undefined ? previous?.input === undefined ? {} : { input: previous.input } : { input: event.payload["input"] }),
        ...(event.payload["result"] === undefined ? previous?.result === undefined ? {} : { result: previous.result } : { result: event.payload["result"] }),
        ...(progress === undefined ? {} : { progress }),
        ...(event.payload["presentation"] === undefined ? previous?.presentation === undefined ? {} : { presentation: previous.presentation } : { presentation: event.payload["presentation"] }),
        ...(parentCallId === undefined ? {} : { parentCallId }),
        ...(rootCallId === undefined ? {} : { rootCallId }),
        ...(turnId === undefined ? previous?.turnId === undefined ? {} : { turnId: previous.turnId } : { turnId }),
        createdAt: previous?.createdAt ?? event.createdAt,
        updatedAt: event.createdAt,
        sequence: previous?.sequence ?? event.sequence,
        lastSequence: event.sequence,
      };
      projection.toolById.set(id, tool);
      const key = `tool:${id}`;
      const node = projection.nodes.get(key);
      projection.nodes.set(key, { ...base(key, "tool", node), kind: "tool", tool });
      return true;
    }
    case "permission/requested":
    case "permission/resolved": {
      const permissionId = stringValue(event.payload["permissionId"]);
      const toolCallId = stringValue(event.payload["toolCallId"]);
      if (permissionId === undefined || toolCallId === undefined) return markUnkeyedEvent(projection, event);
      const key = `permission:${permissionId}`;
      const previous = projection.nodes.get(key);
      const old = isPermissionNode(previous) ? previous : undefined;
      const caller = toolCaller(event.payload["caller"]) ?? old?.caller;
      const workspaceRoot = stringValue(event.payload["workspaceRoot"]) ?? old?.workspaceRoot;
      const expiresAt = stringValue(event.payload["expiresAt"]) ?? old?.expiresAt;
      projection.nodes.set(key, {
        ...base(key, "permission", previous),
        kind: "permission",
        permissionId: permissionId as PermissionId,
        toolCallId: toolCallId as ToolCallId,
        toolName: stringValue(event.payload["toolName"]) ?? old?.toolName ?? "unknown",
        status: event.type === "permission/requested" ? "pending" : permissionStatus(event.payload["status"]),
        reason: stringValue(event.payload["reason"]) ?? old?.reason ?? "Tool approval required",
        ...(caller === undefined ? {} : { caller }),
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(event.payload["input"] === undefined ? old?.input === undefined ? {} : { input: old.input } : { input: event.payload["input"] }),
      });
      return true;
    }
    case "interaction/requested":
    case "interaction/resolved": {
      const interactionId = stringValue(event.payload["interactionId"]);
      const toolCallId = stringValue(event.payload["toolCallId"]);
      const question = stringValue(event.payload["question"]);
      if (interactionId === undefined || toolCallId === undefined || question === undefined) return markUnkeyedEvent(projection, event);
      const key = `interaction:${interactionId}`;
      const previous = projection.nodes.get(key);
      const old = isInteractionNode(previous) ? previous : undefined;
      const answer = stringValue(event.payload["answer"]) ?? old?.answer;
      const caller = toolCaller(event.payload["caller"]) ?? old?.caller;
      const expiresAt = stringValue(event.payload["expiresAt"]) ?? old?.expiresAt;
      projection.nodes.set(key, {
        ...base(key, "interaction", previous),
        kind: "interaction",
        interactionId: interactionId as InteractionId,
        toolCallId: toolCallId as ToolCallId,
        question,
        status: event.type === "interaction/requested" ? "pending" : interactionStatus(event.payload["status"]),
        options: interactionOptions(event.payload["options"], old?.options ?? []),
        allowFreeform: booleanValue(event.payload["allowFreeform"]) ?? old?.allowFreeform ?? true,
        ...(caller === undefined ? {} : { caller }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(answer === undefined ? {} : { answer }),
      });
      return true;
    }
    case "task/created":
    case "task/updated":
    case "task/input-required":
    case "task/report":
    case "task/artifact":
    case "task/ended": {
      const taskId = stringValue(event.payload["taskId"]);
      if (taskId === undefined) return markUnkeyedEvent(projection, event);
      const key = `task:${taskId}`;
      const previous = projection.nodes.get(key);
      const old = isTaskNode(previous) ? previous : undefined;
      const report = asRecord(event.payload["report"]);
      const title = stringValue(event.payload["title"]) ?? old?.title;
      const childSessionId = stringValue(event.payload["childSessionId"]) ?? old?.childSessionId;
      const summary = stringValue(report?.["summary"]) ?? old?.summary;
      projection.nodes.set(key, {
        ...base(key, "task", previous),
        kind: "task",
        taskId: taskId as TaskId,
        status: stringValue(event.payload["status"]) ?? (event.type === "task/input-required" ? "waiting" : old?.status ?? "queued"),
        ...(title === undefined ? {} : { title }),
        ...(childSessionId === undefined ? {} : { childSessionId: childSessionId as SessionId }),
        ...(summary === undefined ? {} : { summary }),
      });
      return true;
    }
    case "step/started":
    case "step/ended":
    case "agent/error":
      if (turnId !== undefined) {
        const key = `turn:${turnId}`;
        const previous = projection.nodes.get(key);
        projection.nodes.set(key, {
          ...base(key, "turn", previous),
          kind: "turn",
          status: event.type === "agent/error" ? "failed" : previous && isTurnNode(previous) ? previous.status : "running",
        });
        return true;
      }
      return markUnkeyedEvent(projection, event);
    default:
      return markUnkeyedEvent(projection, event);
  }
}

export function snapshotConversationProjection(projection: MutableConversationProjection): ConversationProjection {
  return {
    sessionId: projection.sessionId,
    nodes: [...projection.nodes.values()].sort((left, right) => left.sequence - right.sequence || left.key.localeCompare(right.key)),
    tools: [...projection.toolById.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id)),
    lastSequence: projection.lastSequence,
  };
}

function uniqueSortedEvents(sessionId: SessionId, events: readonly AgentEvent[]): readonly AgentEvent[] {
  const bySequence = new Map<number, AgentEvent>();
  for (const event of events) if (event.sessionId === sessionId) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function hasEventSequence(projection: MutableConversationProjection, sequence: number): boolean {
  return [...projection.nodes.values()].some((node) => node.sequence <= sequence && node.lastSequence >= sequence)
    || [...projection.toolById.values()].some((tool) => tool.sequence <= sequence && tool.lastSequence >= sequence);
}

function markUnkeyedEvent(projection: MutableConversationProjection, event: AgentEvent): boolean {
  const key = `event:${event.eventId}`;
  if (projection.nodes.has(key)) return false;
  projection.nodes.set(key, {
    key,
    kind: "event",
    sequence: event.sequence,
    lastSequence: event.sequence,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
    eventType: event.type,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    payload: event.payload,
  });
  return true;
}

function messageKey(kind: "user" | "assistant" | "reasoning", turnId: TurnId | undefined, eventId: string): string {
  return `${kind}:${turnId ?? eventId}`;
}

function isMessageNode(node: ConversationNode | undefined): node is MessageNode {
  return node?.kind === "user" || node?.kind === "assistant" || node?.kind === "reasoning";
}

function isTurnNode(node: ConversationNode | undefined): node is TurnNode {
  return node?.kind === "turn";
}

function isPermissionNode(node: ConversationNode | undefined): node is PermissionNode {
  return node?.kind === "permission";
}

function isInteractionNode(node: ConversationNode | undefined): node is InteractionNode {
  return node?.kind === "interaction";
}

function isTaskNode(node: ConversationNode | undefined): node is TaskNode {
  return node?.kind === "task";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toolCaller(value: unknown): ToolCaller | undefined {
  return value === "agent" || value === "user" || value === "system" ? value : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null ? value as Readonly<Record<string, unknown>> : undefined;
}

function riskLevel(value: unknown): ToolRiskLevel | undefined {
  return value === "read" || value === "write" || value === "execute" || value === "network" ? value : undefined;
}

function toolStatus(value: unknown, fallback: ToolCallStatus): ToolCallStatus {
  return value === "pending" || value === "awaiting_permission" || value === "running" || value === "completed" || value === "failed" || value === "cancelled" || value === "denied" ? value : fallback;
}

function resultOk(value: unknown): boolean {
  return asRecord(value)?.["ok"] === true;
}

function turnStatus(value: unknown): TurnNode["status"] {
  return value === "queued" || value === "running" || value === "completed" || value === "stopped" || value === "failed" || value === "interrupted" ? value : "unknown";
}

function permissionStatus(value: unknown): PermissionNode["status"] {
  return value === "pending" || value === "approved" || value === "denied" || value === "cancelled" || value === "expired" ? value : "unknown";
}

function interactionStatus(value: unknown): InteractionNode["status"] {
  return value === "pending" || value === "answered" || value === "cancelled" || value === "expired" ? value : "unknown";
}

function interactionOptions(value: unknown, fallback: readonly { readonly label: string; readonly value: string }[]): readonly { readonly label: string; readonly value: string }[] {
  if (!Array.isArray(value)) return fallback;
  return value.flatMap((item): { readonly label: string; readonly value: string }[] => {
    const record = asRecord(item);
    return typeof record?.["label"] === "string" && typeof record["value"] === "string" ? [{ label: record["label"], value: record["value"] }] : [];
  });
}

function appendProgress(previous: readonly string[] | undefined, value: unknown): readonly string[] | undefined {
  const text = stringValue(value);
  if (text === undefined || text.length === 0) return previous;
  return [...(previous ?? []), text];
}
