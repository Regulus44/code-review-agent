import type {
  AgentEvent,
  SessionId,
  SessionProjection,
  SessionStatus,
  TurnId,
  TurnProjection,
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
  readonly history: SessionHistoryWindow;
  readonly lastSequence: number;
  readonly connection: WebConnectionState;
  readonly error?: string;
}

export interface SessionHistoryWindow {
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly loadingOlder: boolean;
  readonly oldestSequence?: number;
  readonly newestSequence?: number;
}

export interface SessionHistoryPageMetadata {
  readonly hasMoreBefore?: boolean;
  readonly hasMoreAfter?: boolean;
  readonly oldestSequence?: number;
  readonly newestSequence?: number;
}

export type SessionStoreListener = (snapshot: SessionStoreSnapshot) => void;

const EMPTY_SNAPSHOT: SessionStoreSnapshot = {
  events: [],
  history: { hasOlder: false, hasNewer: false, loadingOlder: false },
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
  private sessionBaselineSequence = 0;

  getSnapshot(): SessionStoreSnapshot {
    return this.snapshot;
  }

  subscribe(listener: SessionStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  open(session: SessionProjection, history: readonly AgentEvent[] = [], page: SessionHistoryPageMetadata = {}): void {
    const accepted = uniqueEvents(session.id, history);
    const lastSequence = page.newestSequence ?? Math.max(...accepted.map((event) => event.sequence), 0);
    this.sessionBaselineSequence = session.lastSequence;
    this.conversationState = createConversationProjection(session.id);
    this.trajectoryState = {
      sessionId: session.id,
      records: new Map(),
      lastSequence: 0,
    };
    for (const event of accepted) applyConversationEvent(this.conversationState, event);
    for (const event of accepted) applyTrajectoryEvent(this.trajectoryState, event);
    const conversation = snapshotConversationProjection(this.conversationState);
    const oldestSequence = page.oldestSequence ?? accepted[0]?.sequence;
    const newestSequence = page.newestSequence ?? accepted.at(-1)?.sequence;
    this.commit({
      sessionId: session.id,
      session,
      events: accepted,
      conversation,
      toolCallTree: buildToolCallTree(conversation.tools),
      trajectory: snapshotTrajectory(this.trajectoryState),
      history: {
        hasOlder: page.hasMoreBefore === true,
        hasNewer: page.hasMoreAfter === true,
        loadingOlder: false,
        ...(oldestSequence === undefined ? {} : { oldestSequence }),
        ...(newestSequence === undefined ? {} : { newestSequence }),
      },
      lastSequence,
      connection: "connecting",
    });
  }

  replaceProjection(session: SessionProjection): void {
    if (this.snapshot.sessionId !== session.id) return;
    this.sessionBaselineSequence = Math.max(this.sessionBaselineSequence, session.lastSequence);
    this.commit({ ...this.snapshot, session });
  }

  applyHistory(events: readonly AgentEvent[]): void {
    this.mergeHistory(events, {}, true);
  }

  prependHistory(events: readonly AgentEvent[], page: SessionHistoryPageMetadata = {}): void {
    this.mergeHistory(events, page, true);
  }

  setHistoryLoading(loadingOlder: boolean): void {
    this.commit({ ...this.snapshot, history: { ...this.snapshot.history, loadingOlder } });
  }

  apply(event: AgentEvent, notify = true): boolean {
    const currentId = this.snapshot.sessionId;
    if (currentId === undefined || event.sessionId !== currentId) return false;
    if (this.snapshot.events.some((item) => item.sequence === event.sequence)) return false;
    const isOlder = event.sequence < this.snapshot.lastSequence;
    const events = [...this.snapshot.events, event].sort((left, right) => left.sequence - right.sequence);
    const isNewer = event.sequence > this.snapshot.lastSequence;
    if (isOlder) {
      this.rebuildDerived(events);
      const conversation = snapshotConversationProjection(this.conversationState as MutableConversationProjection);
      const oldestSequence = events[0]?.sequence ?? this.snapshot.history.oldestSequence;
      this.commit({
        ...this.snapshot,
        events,
        conversation,
        toolCallTree: buildToolCallTree(conversation.tools),
        trajectory: snapshotTrajectory(this.trajectoryState as MutableTrajectoryProjection),
        history: { ...this.snapshot.history, ...(oldestSequence === undefined ? {} : { oldestSequence }) },
      }, notify);
      return true;
    }
    const shouldFoldSession = isNewer && event.sequence > this.sessionBaselineSequence;
    const session = shouldFoldSession && this.snapshot.session !== undefined ? foldProjection(this.snapshot.session, event) : this.snapshot.session;
    if (shouldFoldSession) this.sessionBaselineSequence = event.sequence;
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
      history: {
        ...this.snapshot.history,
        ...(events[0] === undefined ? {} : { oldestSequence: events[0].sequence }),
        ...(event.sequence > (this.snapshot.history.newestSequence ?? 0) ? { newestSequence: event.sequence } : {}),
      },
      lastSequence: Math.max(this.snapshot.lastSequence, event.sequence),
    }, notify);
    return true;
  }

  setConnection(connection: WebConnectionState, error?: string): void {
    if (error === undefined) {
      const { error: _previousError, ...withoutError } = this.snapshot;
      this.commit({ ...withoutError, connection });
      return;
    }
    this.commit({ ...this.snapshot, connection, error });
  }

  clear(): void {
    this.conversationState = undefined;
    this.trajectoryState = undefined;
    this.sessionBaselineSequence = 0;
    this.commit(EMPTY_SNAPSHOT);
  }

  private commit(snapshot: SessionStoreSnapshot, notify = true): void {
    this.snapshot = snapshot;
    if (notify) this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private mergeHistory(events: readonly AgentEvent[], page: SessionHistoryPageMetadata, notify: boolean): void {
    const sessionId = this.snapshot.sessionId;
    if (sessionId === undefined) return;
    const merged = uniqueEvents(sessionId, [...this.snapshot.events, ...events]);
    this.rebuildDerived(merged);
    const first = merged[0]?.sequence;
    const last = merged.at(-1)?.sequence;
    this.commit({
      ...this.snapshot,
      events: merged,
      ...(this.conversationState === undefined ? {} : { conversation: snapshotConversationProjection(this.conversationState), toolCallTree: buildToolCallTree(snapshotConversationProjection(this.conversationState).tools) }),
      ...(this.trajectoryState === undefined ? {} : { trajectory: snapshotTrajectory(this.trajectoryState) }),
      history: {
        ...this.snapshot.history,
        loadingOlder: false,
        ...(page.hasMoreBefore === undefined ? {} : { hasOlder: page.hasMoreBefore }),
        ...(page.hasMoreAfter === undefined ? {} : { hasNewer: page.hasMoreAfter }),
        ...(first === undefined ? {} : { oldestSequence: first }),
        ...(last === undefined ? {} : { newestSequence: last }),
      },
      lastSequence: Math.max(this.snapshot.lastSequence, last ?? 0),
    }, notify);
  }

  private rebuildDerived(events: readonly AgentEvent[]): void {
    if (this.snapshot.sessionId === undefined) return;
    this.conversationState = createConversationProjection(this.snapshot.sessionId);
    this.trajectoryState = { sessionId: this.snapshot.sessionId, records: new Map(), lastSequence: 0 };
    for (const event of events) {
      applyConversationEvent(this.conversationState, event);
      applyTrajectoryEvent(this.trajectoryState, event);
    }
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
        turns: upsertTurn(session.turns, event.turnId, event.createdAt, event.sequence, { userMessage: content }),
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
      return {
        ...session,
        messages,
        turns: upsertTurn(session.turns, event.turnId, event.createdAt, event.sequence, { assistantMessage: content }),
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
      };
    }
    case "turn/queued":
    case "turn/started":
    case "turn/ended": {
      const turnPatch: Partial<TurnProjection> = {
        status: turnStatusForEvent(event),
        ...(event.type === "turn/started" ? { startedAt: event.createdAt } : {}),
        ...(event.type === "turn/ended" ? { endedAt: event.createdAt } : {}),
      };
      const nextSession = {
        ...session,
        turns: upsertTurn(session.turns, event.turnId, event.createdAt, event.sequence, turnPatch),
        status: sessionStatus(event),
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
      };
      if (event.type !== "turn/started" && event.type !== "turn/ended") return nextSession;
      return {
        ...nextSession,
        turns: nextSession.turns.map((turn) => {
          if (turn.id !== event.turnId) return turn;
          const { queuePosition: _queuePosition, ...withoutQueuePosition } = turn;
          return withoutQueuePosition;
        }),
      };
    }
    case "queue/changed": {
      const rawTurnIds = payload["queuedTurnIds"];
      const queuedTurnIds = Array.isArray(rawTurnIds) ? rawTurnIds.filter((value): value is string => typeof value === "string") : [];
      const positions = new Map(queuedTurnIds.map((id, index) => [id, index + 1] as const));
      return {
        ...session,
        turns: session.turns.map((turn) => {
          const position = positions.get(turn.id);
          if (position === undefined) {
            const { queuePosition: _queuePosition, ...withoutQueuePosition } = turn;
            return withoutQueuePosition;
          }
          return { ...turn, status: "queued", queuePosition: position, lastSequence: event.sequence, updatedAt: event.createdAt };
        }),
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
      };
    }
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

function turnStatusForEvent(event: AgentEvent): TurnProjection["status"] {
  if (event.type === "turn/queued") return "queued";
  if (event.type === "turn/started") return "running";
  const status = stringValue(event.payload["status"]);
  return status === "queued" || status === "running" || status === "completed" || status === "stopped" || status === "failed" || status === "interrupted" ? status : "completed";
}

function upsertTurn(
  turns: readonly TurnProjection[],
  rawTurnId: TurnId | undefined,
  createdAt: string,
  sequence: number,
  patch: Partial<TurnProjection>,
): readonly TurnProjection[] {
  if (rawTurnId === undefined) return turns;
  const index = turns.findIndex((turn) => turn.id === rawTurnId);
  if (index < 0) {
    return [...turns, {
      id: rawTurnId,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      lastSequence: sequence,
      ...patch,
    }];
  }
  const next = [...turns];
  const previous = next[index] as TurnProjection;
  next[index] = { ...previous, ...patch, updatedAt: createdAt, lastSequence: sequence };
  return next;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
