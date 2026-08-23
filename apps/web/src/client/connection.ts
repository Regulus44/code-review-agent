import type { AgentEvent, AgentEventType, SessionId } from "@code-review-agent/contracts";
import { WebApiClient } from "./api.js";
import { SessionStore } from "./store.js";

export const AGENT_EVENT_TYPES: readonly AgentEventType[] = [
  "session/created",
  "session/updated",
  "session/deleted",
  "user/message",
  "turn/steered",
  "turn/queued",
  "turn/started",
  "step/started",
  "step/ended",
  "turn/ended",
  "assistant/chunk",
  "assistant/message",
  "task/created",
  "task/updated",
  "task/input-required",
  "task/report",
  "task/artifact",
  "task/ended",
  "subagent/descriptor",
  "subagent/start",
  "subagent/end",
  "subagent/inbox",
  "subagent/settlement",
  "goal/created",
  "goal/updated",
  "goal/ended",
  "plan/updated",
  "todo/updated",
  "tool/call",
  "tool/progress",
  "tool/result",
  "diff/preview",
  "patch/preview",
  "patch/applied",
  "patch/rejected",
  "patch/rolled_back",
  "lsp/server",
  "lsp/request",
  "permission/requested",
  "permission/resolved",
  "interaction/requested",
  "interaction/resolved",
  "terminal/session",
  "job/started",
  "job/output",
  "job/ended",
  "mcp/server",
  "mcp/tool",
  "mcp/resource",
  "mcp/prompt",
  "agent/status",
  "agent/error",
];

export interface EventSourceLike {
  readonly readyState?: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface SessionConnectionOptions {
  readonly api?: WebApiClient;
  readonly store?: SessionStore;
  readonly eventSourceFactory?: (url: string) => EventSourceLike;
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  readonly maxReconnectAttempts?: number;
}

export const DEFAULT_HISTORY_PAGE_SIZE = 200;

/**
 * Owns the DSH-style history-baseline + live-event handshake. A new
 * generation invalidates all callbacks from an old Session or EventSource,
 * so switching sessions cannot leak events into the next view.
 */
export class SessionConnectionController {
  readonly store: SessionStore;

  private readonly api: WebApiClient;
  private readonly eventSourceFactory: (url: string) => EventSourceLike;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private source: EventSourceLike | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private sessionId: SessionId | undefined;
  private reconnectAttempts = 0;
  private closed = true;

  constructor(options: SessionConnectionOptions = {}) {
    this.api = options.api ?? new WebApiClient();
    this.store = options.store ?? new SessionStore();
    this.eventSourceFactory = options.eventSourceFactory ?? ((url) => new EventSource(url));
    this.reconnectDelayMs = Math.max(0, options.reconnectDelayMs ?? 250);
    this.maxReconnectDelayMs = Math.max(this.reconnectDelayMs, options.maxReconnectDelayMs ?? 8_000);
    this.maxReconnectAttempts = Math.max(0, options.maxReconnectAttempts ?? 8);
  }

  async open(sessionId: SessionId): Promise<void> {
    this.stopSource();
    this.closed = false;
    this.sessionId = sessionId;
    const generation = ++this.generation;
    this.reconnectAttempts = 0;
    this.store.clear();
    this.store.setConnection("connecting");

    try {
      const [session, history] = await Promise.all([
        this.api.getSession(sessionId),
        this.api.listEventsPage(sessionId, { limit: DEFAULT_HISTORY_PAGE_SIZE }),
      ]);
      if (!this.isCurrent(generation, sessionId)) return;
      if (session === undefined) throw new Error(`Session not found: ${sessionId}`);
      this.store.open(session, history.events, history);
      this.connect(generation, sessionId);
    } catch (error) {
      if (!this.isCurrent(generation, sessionId)) return;
      this.store.setConnection("failed", error instanceof Error ? error.message : String(error));
    }
  }

  close(): void {
    this.closed = true;
    this.sessionId = undefined;
    this.generation += 1;
    this.stopSource();
    this.store.setConnection("idle");
  }

  dispose(): void {
    this.close();
    this.store.clear();
  }

  /** Prepend one bounded page without affecting the live SSE cursor. */
  async loadOlder(limit = DEFAULT_HISTORY_PAGE_SIZE): Promise<boolean> {
    const sessionId = this.sessionId;
    const snapshot = this.store.getSnapshot();
    const generation = this.generation;
    const beforeSequence = snapshot.history.oldestSequence;
    if (this.closed || sessionId === undefined || snapshot.sessionId !== sessionId || !snapshot.history.hasOlder || beforeSequence === undefined || snapshot.history.loadingOlder) return false;
    this.store.setHistoryLoading(true);
    try {
      const page = await this.api.listEventsPage(sessionId, { beforeSequence, limit });
      if (!this.isCurrent(generation, sessionId)) return false;
      this.store.prependHistory(page.events, page);
      return page.events.length > 0;
    } catch (error) {
      if (this.isCurrent(generation, sessionId)) {
        this.store.setHistoryLoading(false);
        this.store.setConnection(this.store.getSnapshot().connection, error instanceof Error ? error.message : String(error));
      }
      throw error;
    } finally {
      if (this.isCurrent(generation, sessionId) && this.store.getSnapshot().history.loadingOlder) this.store.setHistoryLoading(false);
    }
  }

  private connect(generation: number, sessionId: SessionId): void {
    if (!this.isCurrent(generation, sessionId)) return;
    this.stopSource();
    const url = this.api.eventsUrl(sessionId, this.store.getSnapshot().lastSequence);
    let source: EventSourceLike;
    try {
      source = this.eventSourceFactory(url);
    } catch (error) {
      this.handleFailure(generation, sessionId, error);
      return;
    }
    this.source = source;
    source.onopen = () => {
      if (!this.isCurrent(generation, sessionId) || this.source !== source) return;
      this.reconnectAttempts = 0;
      this.store.setConnection("connected");
    };
    source.onerror = (error) => {
      if (!this.isCurrent(generation, sessionId) || this.source !== source) return;
      this.handleFailure(generation, sessionId, error);
    };
    for (const eventType of AGENT_EVENT_TYPES) {
      source.addEventListener(eventType, (message) => {
        if (!this.isCurrent(generation, sessionId) || this.source !== source) return;
        this.handleData(message.data, sessionId);
      });
    }
  }

  private handleData(data: string, sessionId: SessionId): void {
    try {
      const parsed: unknown = JSON.parse(data);
      const candidate = isRecord(parsed) && isRecord(parsed["event"]) ? parsed["event"] : parsed;
      if (!isAgentEvent(candidate)) return;
      this.store.apply(candidate);
    } catch (error) {
      this.store.setConnection("reconnecting", `Invalid event payload: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private handleFailure(generation: number, sessionId: SessionId, error: unknown): void {
    this.stopSource();
    this.reconnectAttempts += 1;
    const message = error instanceof Error ? error.message : "SSE connection closed";
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      this.store.setConnection("failed", message);
      return;
    }
    this.store.setConnection("reconnecting", message);
    const exponent = Math.max(0, this.reconnectAttempts - 1);
    const delay = Math.min(this.maxReconnectDelayMs, this.reconnectDelayMs * (2 ** exponent));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(generation, sessionId);
    }, delay);
  }

  private stopSource(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.source !== undefined) {
      this.source.onopen = null;
      this.source.onerror = null;
      this.source.close();
      this.source = undefined;
    }
  }

  private isCurrent(generation: number, sessionId: SessionId): boolean {
    return !this.closed && this.generation === generation && this.sessionId === sessionId;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isRecord(value)) return false;
  return typeof value["eventId"] === "string"
    && typeof value["sequence"] === "number"
    && value["schemaVersion"] === 1
    && typeof value["sessionId"] === "string"
    && typeof value["type"] === "string"
    && typeof value["createdAt"] === "string"
    && isRecord(value["payload"]);
}
