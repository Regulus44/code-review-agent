import type {
  AgentEvent,
  SessionId,
  SessionProjection,
  SessionStatus,
  TurnId,
} from "@code-review-agent/contracts";
import {
  applyConversationEvent,
  createConversationProjection,
  snapshotConversationProjection,
  type ConversationProjection,
  type MutableConversationProjection,
} from "../projection/conversation.js";
import { buildToolCallTree, type ToolCallTree } from "../projection/tool-call-tree.js";
import {
  applyTrajectoryEvent,
  snapshotTrajectory,
  type MutableTrajectoryProjection,
  type TrajectoryProjection,
} from "../projection/trajectory.js";

export type WebConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

export interface SessionStoreSnapshot {
  readonly sessionId?: SessionId;
  readonly session?: SessionProjection;
  readonly events: readonly AgentEvent[];
  readonly conversation?: ConversationProjection;
  readonly toolCallTree?: ToolCallTree;
  readonly trajectory?: TrajectoryProjection;
  readonly lastSequence: number;
  readonly connection: WebConnectionState;
  readonly error?: string;
}

export type SessionStoreListener = (snapshot: SessionStoreSnapshot) => void;

const EMPTY_SNAPSHOT: SessionStoreSnapshot = {
  events: [],
  lastSequence: 0,
  connection: "idle",
};

/**
 * Session-aware client store. It keeps the event window and a projection
 * baseline together, applies higher-sequence-wins, and exposes immutable
 * snapshots to Chat, Tool and Trajectory consumers.
 */
export class SessionStore {
  private snapshot: SessionStoreSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<SessionStoreListener>();
  private conversationState: MutableConversationProjection | undefined;
  private trajectoryState: MutableTrajectoryProjection | undefined;

  getSnapshot(): SessionStoreSnapshot {
    return this.snapshot;
  }

  subscribe(listener: SessionStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  open(session: SessionProjection, history: readonly AgentEvent[] = []): void {
    const accepted = uniqueEvents(session.id, history);
    const lastSequence = Math.max(session.lastSequence, ...accepted.map((event) => event.sequence), 0);
    this.conversationState = createConversationProjection(session.id);
    this.trajectoryState = {
      sessionId: session.id,
      records: new Map(),
      lastSequence: 0,
    };
    for (const event of accepted) applyConversationEvent(this.conversationState, event);
    for (const event of accepted) applyTrajectoryEvent(this.trajectoryState, event);
    const conversation = snapshotConversationProjection(this.conversationState);
    this.commit({
      sessionId: session.id,
      session,
      events: accepted,
      conversation,
      toolCallTree: buildToolCallTree(conversation.tools),
      trajectory: snapshotTrajectory(this.trajectoryState),
      lastSequence,
      connection: "connecting",
    });
  }

  replaceProjection(session: SessionProjection): void {
    if (this.snapshot.sessionId !== session.id) return;
    this.commit({ ...this.snapshot, session, lastSequence: Math.max(this.snapshot.lastSequence, session.lastSequence) });
  }

  applyHistory(events: readonly AgentEvent[]): void {
    for (const event of events) this.apply(event, false);
    this.notify();
  }

  apply(event: AgentEvent, notify = true): boolean {
    const currentId = this.snapshot.sessionId;
    if (currentId === undefined || event.sessionId !== currentId) return false;
    if (event.sequence <= this.snapshot.lastSequence && this.snapshot.events.some((item) => item.sequence === event.sequence)) return false;
    const events = [...this.snapshot.events, event].sort((left, right) => left.sequence - right.sequence);
    const isNewer = event.sequence > this.snapshot.lastSequence;
    const session = isNewer && this.snapshot.session !== undefined ? foldProjection(this.snapshot.session, event) : this.snapshot.session;
    if (isNewer && this.conversationState !== undefined) applyConversationEvent(this.conversationState, event);
    if (isNewer && this.trajectoryState !== undefined) applyTrajectoryEvent(this.trajectoryState, event);
    const conversation = isNewer && this.conversationState !== undefined
      ? snapshotConversationProjection(this.conversationState)
      : this.snapshot.conversation;
    this.commit({
      ...this.snapshot,
      ...(session === undefined ? {} : { session }),
      events,
      ...(conversation === undefined ? {} : {
        conversation,
        toolCallTree: buildToolCallTree(conversation.tools),
      }),
      ...(this.trajectoryState === undefined ? {} : { trajectory: snapshotTrajectory(this.trajectoryState) }),
      lastSequence: Math.max(this.snapshot.lastSequence, event.sequence),
    }, notify);
    return true;
  }

  setConnection(connection: WebConnectionState, error?: string): void {
    this.commit({
      ...this.snapshot,
      connection,
      ...(error === undefined ? {} : { error }),
    });
  }

  clear(): void {
    this.conversationState = undefined;
    this.trajectoryState = undefined;
    this.commit(EMPTY_SNAPSHOT);
  }

  private commit(snapshot: SessionStoreSnapshot, notify = true): void {
    this.snapshot = snapshot;
    if (notify) this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

function uniqueEvents(sessionId: SessionId, events: readonly AgentEvent[]): readonly AgentEvent[] {
  const bySequence = new Map<number, AgentEvent>();
  for (const event of events) {
    if (event.sessionId === sessionId) bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function foldProjection(session: SessionProjection, event: AgentEvent): SessionProjection {
  const payload = event.payload;
  switch (event.type) {
    case "session/updated":
      {
        const title = stringValue(payload["title"]);
        const preset = stringValue(payload["permissionPreset"]);
        const archived = booleanValue(payload["archived"]);
        return {
          ...session,
          ...(title === undefined ? {} : { title }),
          ...(preset === undefined ? {} : { permissionPreset: preset as SessionProjection["permissionPreset"] }),
          ...(archived === undefined ? {} : { archived }),
          updatedAt: event.createdAt,
          lastSequence: event.sequence,
        };
      }
    case "session/deleted":
      return { ...session, deleted: true, updatedAt: event.createdAt, lastSequence: event.sequence };
    case "user/message": {
      const content = stringValue(payload["content"]);
      if (content === undefined) return session;
      return {
        ...session,
        messages: appendMessage(session.messages, { role: "user", content, ...(event.turnId === undefined ? {} : { turnId: event.turnId }) }),
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
      };
    }
    case "assistant/message": {
      const content = stringValue(payload["content"]);
      if (content === undefined) return session;
      const messages = [...session.messages];
      const index = event.turnId === undefined ? -1 : findMessage(messages, "assistant", event.turnId);
      const message = { role: "assistant" as const, content, ...(event.turnId === undefined ? {} : { turnId: event.turnId }) };
      if (index < 0) messages.push(message);
      else messages[index] = message;
      return { ...session, messages, updatedAt: event.createdAt, lastSequence: event.sequence };
    }
    case "turn/queued":
    case "turn/started":
    case "turn/ended":
      return { ...session, status: sessionStatus(event), updatedAt: event.createdAt, lastSequence: event.sequence };
    default:
      return { ...session, updatedAt: event.createdAt, lastSequence: Math.max(session.lastSequence, event.sequence) };
  }
}

function appendMessage(messages: SessionProjection["messages"], message: SessionProjection["messages"][number]): SessionProjection["messages"] {
  if (message.turnId !== undefined && messages.some((item) => item.role === message.role && item.turnId === message.turnId && item.content === message.content)) return messages;
  return [...messages, message];
}

function findMessage(messages: SessionProjection["messages"], role: "user" | "assistant", turnId: TurnId): number {
  return messages.findIndex((item) => item.role === role && item.turnId === turnId);
}

function sessionStatus(event: AgentEvent): SessionStatus {
  const status = stringValue(event.payload["status"]);
  if (status === "queued" || status === "running" || status === "stopped" || status === "failed" || status === "interrupted") return status;
  return "idle";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
