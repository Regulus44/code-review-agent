import { describe, expect, it } from "vitest";
import { brand, type AgentEvent, type SessionProjection } from "@code-review-agent/contracts";
import { WebApiClient } from "./api.js";
import { SessionConnectionController, type EventSourceLike } from "./connection.js";

const sessionId = brand<string, "SessionId">("ses_connection");
const turnId = brand<string, "TurnId">("turn_connection");

function session(lastSequence = 0): SessionProjection {
  const now = "2026-08-23T00:00:00.000Z";
  return {
    id: sessionId,
    workspaceRoot: "D:/workspace",
    permissionPreset: "ask-on-write",
    archived: false,
    deleted: false,
    createdAt: now,
    updatedAt: now,
    status: "idle",
    lastSequence,
    messages: [],
    turns: [],
    tasks: [],
    goals: [],
    plan: { content: "", status: "cleared", updatedAt: now, lastSequence: 0 },
    todos: [],
    interactions: [],
    toolCalls: [],
    permissions: [],
  };
}

function event(sequence: number): AgentEvent {
  return {
    eventId: `evt_${sequence}`,
    sequence,
    schemaVersion: 1,
    sessionId,
    turnId,
    type: "assistant/chunk",
    createdAt: `2026-08-23T00:00:0${sequence}.000Z`,
    payload: { text: `chunk-${sequence}` },
  };
}

class FakeEventSource implements EventSourceLike {
  static readonly instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, value: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(value) } as MessageEvent<string>);
  }
}

describe("SessionConnectionController", () => {
  it("replays history, consumes live events and reconnects from the latest sequence", async () => {
    FakeEventSource.instances.length = 0;
    const history = [event(1)];
    const client = new WebApiClient({
      baseUrl: "http://localhost:4317",
      fetcher: async (input) => {
        const url = String(input);
        const body = url.includes("/events?") ? history : session(1);
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const controller = new SessionConnectionController({
      api: client,
      eventSourceFactory: (url) => new FakeEventSource(url),
      reconnectDelayMs: 0,
      maxReconnectAttempts: 2,
    });

    await controller.open(sessionId);
    const first = FakeEventSource.instances[0];
    expect(first?.url).toContain("after_sequence=1");
    first?.onopen?.({} as Event);
    first?.emit("assistant/chunk", event(2));
    expect(controller.store.getSnapshot().lastSequence).toBe(2);

    first?.onerror?.({} as Event);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const second = FakeEventSource.instances[1];
    expect(first?.closed).toBe(true);
    expect(second?.url).toContain("after_sequence=2");
    second?.emit("assistant/chunk", event(3));
    expect(controller.store.getSnapshot().lastSequence).toBe(3);

    controller.close();
    expect(controller.store.getSnapshot().connection).toBe("idle");
    expect(second?.closed).toBe(true);
  });
});
