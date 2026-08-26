import { AGENT_EVENT_TYPES } from "@code-review-agent/contracts";
import type { AgentEvent, SessionId, TurnId } from "@code-review-agent/contracts";
import { WebApiClient } from "./api.js";
import { SessionStore } from "./store.js";

export { AGENT_EVENT_TYPES };

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
  private gapRepairing = false;
  private liveBuffer: AgentEvent[] = [];

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
    this.gapRepairing = false;
    this.liveBuffer = [];
    this.store.clear();
    this.store.setConnectionGeneration(generation);
    this.store.setConnection("connecting");

    try {
      const [session, history] = await Promise.all([
        this.api.getSession(sessionId),
        this.api.listEventsPage(sessionId, { limit: DEFAULT_HISTORY_PAGE_SIZE }),
      ]);
      if (!this.isCurrent(generation, sessionId)) return;
      if (session === undefined) throw new Error(`Session not found: ${sessionId}`);
      this.store.open(session, history.events, history, generation);
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

  /** Host admission entry point for Composer submissions. */
  async sendMessage(content: string, commandId?: string, reasoningEffort?: string): Promise<{ readonly turnId: TurnId }> {
    const sessionId = this.sessionId;
    if (this.closed || sessionId === undefined) throw new Error("No active session");
    const normalized = content.trim();
    if (!normalized) throw new Error("Message cannot be empty");
    return this.api.sendMessage(sessionId, normalized, commandId, reasoningEffort);
  }

  /** Prepend one bounded page without affecting the live SSE cursor. */
  async loadOlder(limit = DEFAULT_HISTORY_PAGE_SIZE): Promise<boolean> {
    const sessionId = this.sessionId;
    const snapshot = this.store.getSnapshot();
    const generation = this.generation;
    const beforeSequence = snapshot.history.baseSequence ?? snapshot.history.oldestSequence;
    if (this.closed || sessionId === undefined || snapshot.sessionId !== sessionId || !snapshot.history.hasMoreBefore || beforeSequence === undefined || snapshot.history.loadingOlder) return false;
    this.store.setHistoryLoading(true);
    try {
      const page = await this.api.listEventsPage(sessionId, { beforeSequence, limit });
      if (!this.isCurrent(generation, sessionId)) return false;
      return this.store.prependHistory(page.events, page);
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
    const url = this.api.eventsUrl(sessionId, this.store.getSnapshot().history.tailSequence ?? this.store.getSnapshot().lastSequence);
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
      const result = this.store.applyLive(candidate);
      if (result === "gap") {
        if (!this.liveBuffer.some((event) => event.sequence === candidate.sequence)) this.liveBuffer.push(candidate);
        void this.repairGap(this.generation, sessionId);
      }
    } catch (error) {
      this.store.setConnection("reconnecting", `Invalid event payload: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async repairGap(generation: number, sessionId: SessionId): Promise<void> {
    if (this.gapRepairing || !this.isCurrent(generation, sessionId)) return;
    this.gapRepairing = true;
    this.store.setConnection("reconnecting", "Event stream gap detected; repairing history");
    try {
      while (this.isCurrent(generation, sessionId)) {
        const tail = this.store.getSnapshot().history.tailSequence ?? this.store.getSnapshot().lastSequence;
        const page = await this.api.listEventsPage(sessionId, { afterSequence: tail, limit: DEFAULT_HISTORY_PAGE_SIZE });
        if (!this.isCurrent(generation, sessionId)) return;
        if (page.events.length === 0) throw new Error(`History repair returned no events after sequence ${tail}`);
        if (!this.store.appendHistory(page.events, page)) throw new Error(`History repair page is not contiguous after sequence ${tail}`);
        this.liveBuffer.sort((left, right) => left.sequence - right.sequence);
        let progressed = true;
        while (progressed && this.liveBuffer.length > 0) {
          progressed = false;
          const next = this.liveBuffer[0];
          if (next === undefined) break;
          const result = this.store.applyLive(next, false);
          if (result === "applied" || result === "duplicate" || result === "ignored") {
            this.liveBuffer.shift();
            progressed = true;
          }
        }
        const next = this.liveBuffer[0];
        const currentTail = this.store.getSnapshot().history.tailSequence ?? this.store.getSnapshot().lastSequence;
        if (next === undefined || next.sequence === currentTail + 1) {
          if (next === undefined) {
            this.store.setConnection("connected");
            return;
          }
          continue;
        }
      }
    } catch (error) {
      if (this.isCurrent(generation, sessionId)) this.handleFailure(generation, sessionId, error);
    } finally {
      this.gapRepairing = false;
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
