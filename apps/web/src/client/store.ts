import type {
  AgentEvent,
  ContextDiagnosticRecovery,
  SessionId,
  SessionProjection,
  SessionStatus,
  TurnId,
  TurnProjection,
} from "@code-review-agent/contracts";
import { createSessionStatsProjection, reduceSessionStats } from "@code-review-agent/contracts";
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
  /** Monotonic session-connection generation; stale requests must not commit. */
  readonly connectionGeneration: number;
  readonly connection: WebConnectionState;
  readonly error?: string;
}

export interface SessionHistoryWindow {
  /** Generation that installed this window. */
  readonly connectionGeneration: number;
  /** First sequence currently installed in the bounded window. */
  readonly baseSequence?: number;
  /** Last sequence currently installed and used as the live cursor. */
  readonly tailSequence?: number;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly loadingOlder: boolean;
  /** @deprecated Use hasMoreBefore/baseSequence/tailSequence. */
  readonly hasOlder: boolean;
  /** @deprecated Use hasMoreAfter. */
  readonly hasNewer: boolean;
  /** @deprecated Use baseSequence. */
  readonly oldestSequence?: number;
  /** @deprecated Use tailSequence. */
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
  history: { connectionGeneration: 0, hasMoreBefore: false, hasMoreAfter: false, hasOlder: false, hasNewer: false, loadingOlder: false },
  lastSequence: 0,
  connectionGeneration: 0,
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

  open(session: SessionProjection, history: readonly AgentEvent[] = [], page: SessionHistoryPageMetadata = {}, connectionGeneration = this.snapshot.connectionGeneration): void {
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
        connectionGeneration,
        hasMoreBefore: page.hasMoreBefore === true,
        hasMoreAfter: page.hasMoreAfter === true,
        hasOlder: page.hasMoreBefore === true,
        hasNewer: page.hasMoreAfter === true,
        loadingOlder: false,
        ...(oldestSequence === undefined ? {} : { baseSequence: oldestSequence }),
        ...(newestSequence === undefined ? {} : { tailSequence: newestSequence }),
        ...(oldestSequence === undefined ? {} : { oldestSequence }),
        ...(newestSequence === undefined ? {} : { newestSequence }),
      },
      lastSequence,
      connectionGeneration,
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

  prependHistory(events: readonly AgentEvent[], page: SessionHistoryPageMetadata = {}): boolean {
    const sessionId = this.snapshot.sessionId;
    const base = this.snapshot.history.baseSequence ?? this.snapshot.history.oldestSequence;
    const accepted = sessionId === undefined ? [] : uniqueEvents(sessionId, events);
    if (accepted.length === 0 || !isContiguous(accepted) || (base !== undefined && accepted.at(-1)!.sequence + 1 !== base)) return false;
    const { hasMoreAfter: _ignoredHasMoreAfter, ...olderPage } = page;
    this.mergeHistory(accepted, olderPage, true);
    return true;
  }

  /** Install a contiguous page after the current live tail (gap repair). */
  appendHistory(events: readonly AgentEvent[], page: SessionHistoryPageMetadata = {}): boolean {
    const sessionId = this.snapshot.sessionId;
    const tail = this.snapshot.history.tailSequence ?? this.snapshot.lastSequence;
    const accepted = sessionId === undefined ? [] : uniqueEvents(sessionId, events);
    if (sessionId === undefined || accepted.length === 0 || !isContiguous(accepted) || accepted[0]!.sequence !== tail + 1) return false;
    for (const event of accepted) this.apply(event, false);
    const history = this.snapshot.history;
    this.commit({
      ...this.snapshot,
      history: {
        ...history,
        loadingOlder: false,
        ...(page.hasMoreAfter === undefined ? {} : { hasMoreAfter: page.hasMoreAfter, hasNewer: page.hasMoreAfter }),
      },
    });
    return true;
  }

  setConnectionGeneration(connectionGeneration: number): void {
    this.commit({ ...this.snapshot, connectionGeneration, history: { ...this.snapshot.history, connectionGeneration } });
  }

  setHistoryLoading(loadingOlder: boolean): void {
    this.commit({ ...this.snapshot, history: { ...this.snapshot.history, loadingOlder } });
  }

  applyLive(event: AgentEvent, notify = true): "applied" | "duplicate" | "gap" | "ignored" {
    const currentId = this.snapshot.sessionId;
    if (currentId === undefined || event.sessionId !== currentId) return "ignored";
    const tail = this.snapshot.history.tailSequence ?? this.snapshot.lastSequence;
    if (event.sequence <= tail) return this.snapshot.events.some((item) => item.sequence === event.sequence) ? "duplicate" : "ignored";
    if (event.sequence !== tail + 1) return "gap";
    return this.apply(event, notify) ? "applied" : "duplicate";
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
        history: { ...this.snapshot.history, ...(oldestSequence === undefined ? {} : { baseSequence: oldestSequence, oldestSequence }) },
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
        ...(events[0] === undefined ? {} : { baseSequence: events[0].sequence, oldestSequence: events[0].sequence }),
        ...(event.sequence > (this.snapshot.history.newestSequence ?? 0) ? { tailSequence: event.sequence, newestSequence: event.sequence } : {}),
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
        ...(page.hasMoreBefore === undefined ? {} : { hasMoreBefore: page.hasMoreBefore, hasOlder: page.hasMoreBefore }),
        ...(page.hasMoreAfter === undefined ? {} : { hasMoreAfter: page.hasMoreAfter, hasNewer: page.hasMoreAfter }),
        ...(first === undefined ? {} : { baseSequence: first, oldestSequence: first }),
        ...(last === undefined ? {} : { tailSequence: Math.max(this.snapshot.history.tailSequence ?? 0, last), newestSequence: Math.max(this.snapshot.history.newestSequence ?? 0, last) }),
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

function isContiguous(events: readonly AgentEvent[]): boolean {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence !== events[index - 1]!.sequence + 1) return false;
  }
  return true;
}

function uniqueEvents(sessionId: SessionId, events: readonly AgentEvent[]): readonly AgentEvent[] {
  const bySequence = new Map<number, AgentEvent>();
  for (const event of events) {
    if (event.sessionId === sessionId) bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function foldProjection(session: SessionProjection, event: AgentEvent): SessionProjection {
  const baseline = session.stats ?? createSessionStatsProjection(session.updatedAt, false);
  const stats = reduceSessionStats(baseline, event, baseline.complete);
  return { ...foldProjectionCore(session, event), stats };
}

function foldProjectionCore(session: SessionProjection, event: AgentEvent): SessionProjection {
  const payload = event.payload;
  switch (event.type) {
    case "session/model_selected": {
      const provider = stringValue(payload["provider"]);
      const model = stringValue(payload["model"]);
      if (provider === undefined || model === undefined) return session;
      const reasoningEffort = stringValue(payload["reasoningEffort"]);
      return {
        ...session,
        modelSelection: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
      };
    }
    case "session/updated":
      {
        const title = stringValue(payload["title"]);
        const preset = stringValue(payload["permissionPreset"]);
        const archived = booleanValue(payload["archived"]);
        const activeWorkspaceRoot = stringValue(payload["activeWorkspaceRoot"]);
        const clearedActive = payload["activeWorkspaceRoot"] === null;
        const base = clearedActive
          ? (() => { const { activeWorkspaceRoot: _activeWorkspaceRoot, activeWorktreeId: _activeWorktreeId, ...withoutActiveWorktree } = session; return withoutActiveWorktree; })()
          : session;
        return {
          ...base,
          ...(title === undefined ? {} : { title }),
          ...(preset === undefined ? {} : { permissionPreset: preset as SessionProjection["permissionPreset"] }),
          ...(archived === undefined ? {} : { archived }),
          ...(activeWorkspaceRoot === undefined ? {} : { activeWorkspaceRoot }),
          updatedAt: event.createdAt,
          lastSequence: event.sequence,
        };
      }
    case "session/deleted":
      return { ...session, deleted: true, updatedAt: event.createdAt, lastSequence: event.sequence };
    case "worktree/switched": {
      const id = stringValue(payload["id"]);
      const root = stringValue(payload["path"]);
      return { ...session, ...(id === undefined ? {} : { activeWorktreeId: id }), ...(root === undefined ? {} : { activeWorkspaceRoot: root }), updatedAt: event.createdAt, lastSequence: event.sequence };
    }
    case "worktree/cleaned": {
      if (session.activeWorktreeId !== stringValue(payload["id"])) return { ...session, updatedAt: event.createdAt, lastSequence: event.sequence };
      const { activeWorktreeId: _activeWorktreeId, activeWorkspaceRoot: _activeWorkspaceRoot, ...withoutActiveWorktree } = session;
      return { ...withoutActiveWorktree, updatedAt: event.createdAt, lastSequence: event.sequence };
    }
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
    case "turn/steered": {
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
      return foldContextDiagnostics(session, event) ?? { ...session, updatedAt: event.createdAt, lastSequence: Math.max(session.lastSequence, event.sequence) };
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

function foldContextDiagnostics(session: SessionProjection, event: AgentEvent): SessionProjection | undefined {
  const previous = session.contextDiagnostics;
  if (event.type === "step/started") {
    const budget = recordValue(event.payload["contextBudget"]);
    const warning = recordValue(event.payload["contextWarning"]);
    const tokenCount = recordValue(event.payload["tokenCount"]);
    if (budget === undefined || warning === undefined || tokenCount === undefined) return undefined;
    const tokenUsage = numberValue(tokenCount["value"], previous?.tokenUsage ?? 0);
    const effectiveWindowTokens = numberValue(budget["effectiveWindowTokens"], previous?.effectiveWindowTokens ?? 0);
    const level = warning["isAtBlockingLimit"] === true ? "blocking" : warning["isAboveAutoCompactThreshold"] === true ? "auto_compact" : warning["isAboveErrorThreshold"] === true ? "error" : warning["isAboveWarningThreshold"] === true ? "warning" : effectiveWindowTokens > 0 ? "healthy" : "unknown";
    const source = tokenCount["source"] === "provider" || tokenCount["source"] === "stale_usage" ? tokenCount["source"] : "estimate";
    const confidence = tokenCount["confidence"] === "exact" || tokenCount["confidence"] === "high" || tokenCount["confidence"] === "low" ? tokenCount["confidence"] : "medium";
    const breakdown = recordValue(tokenCount["breakdown"]);
    const normalizedBreakdown = breakdown === undefined ? previous?.breakdown : Object.fromEntries(Object.entries(breakdown).filter(([, item]) => typeof item === "number").slice(0, 16)) as Readonly<Record<string, number>>;
    return {
      ...session,
      contextDiagnostics: {
        version: 1,
        tokenUsage,
        tokenSource: source,
        tokenConfidence: confidence,
        effectiveWindowTokens,
        warningThreshold: numberValue(budget["warningThreshold"], previous?.warningThreshold ?? 0),
        errorThreshold: numberValue(budget["errorThreshold"], previous?.errorThreshold ?? 0),
        autoCompactThreshold: numberValue(budget["autoCompactThreshold"], previous?.autoCompactThreshold ?? 0),
        blockingThreshold: numberValue(budget["blockingThreshold"], previous?.blockingThreshold ?? 0),
        percentLeft: numberValue(warning["percentLeft"], previous?.percentLeft ?? 0),
        level,
        ...(typeof event.payload["step"] === "number" ? { lastStep: Math.max(0, Math.floor(event.payload["step"] as number)) } : {}),
        ...(event.turnId === undefined ? {} : { lastTurnId: event.turnId }),
        ...(typeof event.payload["modelRequestId"] === "string" ? { lastRequestId: (event.payload["modelRequestId"] as string).slice(0, 128) } : {}),
        ...(normalizedBreakdown === undefined ? {} : { breakdown: normalizedBreakdown }),
        ...(previous?.lastCompaction === undefined ? {} : { lastCompaction: previous.lastCompaction }),
        recoveryChain: previous?.recoveryChain ?? [],
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
      },
      updatedAt: event.createdAt,
      lastSequence: event.sequence,
    };
  }
  if (event.type === "context/recovery_started" || event.type === "context/recovery_transition" || event.type === "context/recovery_succeeded" || event.type === "context/recovery_failed" || event.type === "context/recovery_circuit_open") {
    const baseline = previous ?? emptyContextDiagnostics(event);
    const status: ContextDiagnosticRecovery["status"] = event.type === "context/recovery_started"
      ? "started"
      : event.type === "context/recovery_transition"
        ? "transition"
        : event.type === "context/recovery_succeeded"
          ? "succeeded"
          : event.type === "context/recovery_circuit_open" ? "circuit_open" : "failed";
    return {
      ...session,
      contextDiagnostics: {
        ...baseline,
        recoveryChain: [...baseline.recoveryChain, { status, attempt: numberValue(event.payload["attempt"], 0), ...(typeof event.payload["errorClass"] === "string" ? { errorClass: event.payload["errorClass"] as string } : {}), ...(typeof event.payload["transitionReason"] === "string" ? { transitionReason: event.payload["transitionReason"] as string } : {}), ...(typeof event.payload["providerStatus"] === "number" ? { providerStatus: event.payload["providerStatus"] as number } : {}), lastSequence: event.sequence } satisfies ContextDiagnosticRecovery].slice(-16),
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
      },
      updatedAt: event.createdAt,
      lastSequence: event.sequence,
    };
  }
  if (event.type === "context/compacted" || event.type === "context/compaction_failed" || event.type === "context/microcompacted" || event.type === "context/session_memory_compacted" || event.type === "context/session_memory_compaction_failed" || event.type === "context/summary_compacted" || event.type === "context/summary_compaction_failed" || event.type === "context/compact_boundary") {
    const baseline = previous ?? emptyContextDiagnostics(event);
    const post = numberValue(event.payload["postCompactTokens"], numberValue(event.payload["estimatedTokens"], 0));
    const pre = event.payload["preCompactTokens"] === undefined ? undefined : numberValue(event.payload["preCompactTokens"], 0);
    const explicitSaved = typeof event.payload["tokensSaved"] === "number" ? numberValue(event.payload["tokensSaved"], 0) : undefined;
    const boundary = event.type === "context/compact_boundary" ? recordValue(event.payload["boundary"]) : undefined;
    const rawKind = event.payload["kind"] ?? boundary?.["kind"] ?? (event.type === "context/microcompacted" ? "micro" : undefined);
    const kind = rawKind === "legacy" || rawKind === "session_memory" || rawKind === "summary" || rawKind === "micro" ? rawKind : undefined;
    return {
      ...session,
      contextDiagnostics: {
        ...baseline,
        lastCompaction: { status: event.type.endsWith("failed") ? "failed" : "completed", ...(kind === undefined ? {} : { kind }), ...(pre === undefined ? {} : { preCompactTokens: pre }), ...(post === 0 ? {} : { postCompactTokens: post }), ...(pre === undefined ? explicitSaved === undefined ? {} : { tokensSaved: explicitSaved } : { tokensSaved: Math.max(0, pre - post) }), sequence: event.sequence, ...(typeof event.payload["error"] === "string" ? { error: event.payload["error"] as string } : {}) },
        updatedAt: event.createdAt,
        lastSequence: event.sequence,
      },
      updatedAt: event.createdAt,
      lastSequence: event.sequence,
    };
  }
  return undefined;
}

function emptyContextDiagnostics(event: AgentEvent): NonNullable<SessionProjection["contextDiagnostics"]> {
  return {
    version: 1,
    tokenUsage: 0,
    tokenSource: "estimate",
    tokenConfidence: "low",
    effectiveWindowTokens: 0,
    warningThreshold: 0,
    errorThreshold: 0,
    autoCompactThreshold: 0,
    blockingThreshold: 0,
    percentLeft: 0,
    level: "unknown",
    ...(event.turnId === undefined ? {} : { lastTurnId: event.turnId }),
    recoveryChain: [],
    updatedAt: event.createdAt,
    lastSequence: event.sequence,
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}
