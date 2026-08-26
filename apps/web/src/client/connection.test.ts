import { describe, expect, it } from "vitest";
import { AGENT_EVENT_TYPES as CONTRACT_EVENT_TYPES, brand, type AgentEvent, type SessionProjection } from "@code-review-agent/contracts";
import { WebApiClient } from "./api.js";
import { AGENT_EVENT_TYPES, SessionConnectionController, type EventSourceLike } from "./connection.js";

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

  it("loads an older page through the same generation without changing the SSE cursor", async () => {
    FakeEventSource.instances.length = 0;
    const calls: string[] = [];
    const initial = [event(4), event(5)];
    const older = [event(1), event(2), event(3)];
    const client = new WebApiClient({
      baseUrl: "http://localhost:4317",
      fetcher: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("before_sequence=4")) return new Response(JSON.stringify({ events: older, hasMoreBefore: false, hasMoreAfter: true, oldestSequence: 1, newestSequence: 3 }), { status: 200, headers: { "content-type": "application/json" } });
        if (url.includes("/events?")) return new Response(JSON.stringify({ events: initial, hasMoreBefore: true, hasMoreAfter: false, oldestSequence: 4, newestSequence: 5 }), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify(session(5)), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const controller = new SessionConnectionController({ api: client, eventSourceFactory: (url) => new FakeEventSource(url), reconnectDelayMs: 0 });
    await controller.open(sessionId);
    expect(controller.store.getSnapshot().history.hasOlder).toBe(true);
    expect(await controller.loadOlder(3)).toBe(true);
    expect(controller.store.getSnapshot().events.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(controller.store.getSnapshot().lastSequence).toBe(5);
    expect(controller.store.getSnapshot().history.hasMoreAfter).toBe(false);
    expect(calls.some((url) => url.includes("before_sequence=4") && url.includes("limit=3"))).toBe(true);
    expect(FakeEventSource.instances[0]?.url).toContain("after_sequence=5");
    controller.close();
  });

  it("repairs an SSE sequence gap from history and keeps buffered live events", async () => {
    FakeEventSource.instances.length = 0;
    const initial = [event(1), event(2)];
    const calls: string[] = [];
    const client = new WebApiClient({
      baseUrl: "http://localhost:4317",
      fetcher: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("after_sequence=2")) {
          return new Response(JSON.stringify({ events: [event(3), event(4)], hasMoreBefore: false, hasMoreAfter: false, oldestSequence: 3, newestSequence: 4 }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.includes("/events?")) return new Response(JSON.stringify({ events: initial, hasMoreBefore: false, hasMoreAfter: false, oldestSequence: 1, newestSequence: 2 }), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify(session(2)), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const controller = new SessionConnectionController({ api: client, eventSourceFactory: (url) => new FakeEventSource(url), reconnectDelayMs: 0 });
    await controller.open(sessionId);
    const source = FakeEventSource.instances[0]!;
    source.emit("assistant/chunk", event(4));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(calls.some((url) => url.includes("after_sequence=2") && url.includes("limit=200"))).toBe(true);
    expect(controller.store.getSnapshot().events.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
    expect(controller.store.getSnapshot().history.tailSequence).toBe(4);
    expect(controller.store.getSnapshot().connection).toBe("connected");
    controller.close();
  });

  it("keeps the runtime SSE registry exactly aligned with the contracts registry", () => {
    expect(AGENT_EVENT_TYPES).toEqual(CONTRACT_EVENT_TYPES);
    expect(AGENT_EVENT_TYPES).toContain("workspace/updated");
    expect(AGENT_EVENT_TYPES).toContain("queue/changed");
  });

  it("does not let an older open generation overwrite a newer session window", async () => {
    const firstSessionId = brand<string, "SessionId">("ses_old");
    const secondSessionId = brand<string, "SessionId">("ses_new");
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const client = new WebApiClient({
      baseUrl: "http://localhost:4317",
      fetcher: async (input) => {
        const url = String(input);
        const isOld = url.includes(encodeURIComponent(firstSessionId));
        if (isOld) await oldGate;
        const id = isOld ? firstSessionId : secondSessionId;
        if (url.includes("/events?")) return new Response(JSON.stringify({ events: [event(1)], hasMoreBefore: false, hasMoreAfter: false, oldestSequence: 1, newestSequence: 1 }), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ ...session(1), id }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const controller = new SessionConnectionController({ api: client, eventSourceFactory: (url) => new FakeEventSource(url), reconnectDelayMs: 0 });
    const oldOpen = controller.open(firstSessionId);
    await controller.open(secondSessionId);
    releaseOld();
    await oldOpen;

    expect(controller.store.getSnapshot().sessionId).toBe(secondSessionId);
    expect(controller.store.getSnapshot().connectionGeneration).toBe(2);
    expect(controller.store.getSnapshot().history.connectionGeneration).toBe(2);
    controller.close();
  });
});
