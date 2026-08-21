import {
  brand,
  type AgentEvent,
  type AppendEventInput,
  type EventListener,
  type EventStore,
  type SessionId,
  type SessionEventStore,
  type SessionProjection,
  type SessionSummary,
  type TurnId,
} from "@code-review-agent/contracts";
import { randomUUID } from "node:crypto";

function now(): string {
  return new Date().toISOString();
}

function eventId(): string {
  return `evt_${randomUUID()}`;
}

interface SessionRecord {
  readonly events: AgentEvent[];
  readonly listeners: Set<EventListener>;
  summary: SessionSummary;
}

/** In-memory event store used by Phase 1 and deterministic tests. */
export class InMemoryEventStore implements SessionEventStore {
  private readonly sessions = new Map<SessionId, SessionRecord>();

  async createSession(workspaceRoot: string, id = brand<string, "SessionId">(`ses_${randomUUID()}`)): Promise<SessionId> {
    if (this.sessions.has(id)) {
      throw new Error(`Session already exists: ${id}`);
    }
    const timestamp = now();
    this.sessions.set(id, {
      events: [],
      listeners: new Set(),
      summary: {
        id,
        workspaceRoot,
        createdAt: timestamp,
        updatedAt: timestamp,
        status: "idle",
        lastSequence: 0,
      },
    });
    await this.append({
      sessionId: id,
      type: "session/created",
      payload: { workspaceRoot },
    });
    return id;
  }

  async append(input: AppendEventInput): Promise<AgentEvent> {
    const record = this.sessions.get(input.sessionId);
    if (!record) {
      throw new Error(`Unknown session: ${input.sessionId}`);
    }
    const event: AgentEvent = {
      eventId: eventId(),
      sequence: record.events.length + 1,
      schemaVersion: 1,
      sessionId: input.sessionId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      type: input.type,
      createdAt: now(),
      payload: input.payload,
    };
    record.events.push(event);
    record.summary = this.summaryFromEvents(record.summary, event);
    for (const listener of record.listeners) {
      listener(event);
    }
    return event;
  }

  async list(sessionId: SessionId, afterSequence = 0): Promise<readonly AgentEvent[]> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return [];
    }
    return record.events.filter((event) => event.sequence > afterSequence);
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    return [...this.sessions.values()].map((record) => record.summary);
  }

  async project(sessionId: SessionId): Promise<SessionProjection | undefined> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return undefined;
    }
    const messages: { role: "user" | "assistant"; content: string; turnId?: TurnId }[] = [];
    for (const event of record.events) {
      if (event.type === "user/message") {
        const content = event.payload["content"];
        if (typeof content === "string") {
          messages.push({
            role: "user",
            content,
            ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          });
        }
      }
      if (event.type === "assistant/message") {
        const content = event.payload["content"];
        if (typeof content === "string") {
          messages.push({
            role: "assistant",
            content,
            ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          });
        }
      }
    }
    return { ...record.summary, messages };
  }

  subscribe(sessionId: SessionId, listener: EventListener): () => void {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return () => undefined;
    }
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  private summaryFromEvents(summary: SessionSummary, event: AgentEvent): SessionSummary {
    let status = summary.status;
    if (event.type === "turn/started") status = "running";
    if (event.type === "turn/ended") status = "idle";
    if (event.type === "agent/error") status = "failed";
    if (event.type === "agent/status" && event.payload["status"] === "stopped") status = "stopped";
    return {
      ...summary,
      status,
      updatedAt: event.createdAt,
      lastSequence: event.sequence,
    };
  }
}
