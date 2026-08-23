import { describe, expect, it } from "vitest";
import { brand, type AgentEvent, type SessionProjection } from "@code-review-agent/contracts";
import { SessionStore } from "./store.js";

const sessionId = brand<string, "SessionId">("ses_test");
const turnId = brand<string, "TurnId">("turn_test");

function session(): SessionProjection {
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
    lastSequence: 0,
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

function event(sequence: number, type: AgentEvent["type"], payload: Record<string, unknown>, withTurn = true): AgentEvent {
  return {
    eventId: `evt_${sequence}`,
    sequence,
    schemaVersion: 1,
    sessionId,
    ...(withTurn ? { turnId } : {}),
    type,
    createdAt: `2026-08-23T00:00:0${sequence}.000Z`,
    payload,
  };
}

describe("SessionStore", () => {
  it("folds a replay baseline and ignores duplicate sequences", () => {
    const store = new SessionStore();
    store.open(session(), [
      event(1, "user/message", { content: "read file" }),
      event(2, "assistant/chunk", { text: "I will inspect it." }),
    ]);
    store.apply(event(3, "assistant/chunk", { text: " Then summarize." }));
    store.apply(event(3, "assistant/chunk", { text: " duplicated" }));

    const snapshot = store.getSnapshot();
    expect(snapshot.lastSequence).toBe(3);
    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.conversation?.nodes.find((node) => node.kind === "assistant" && node.turnId === turnId)).toMatchObject({
      content: "I will inspect it. Then summarize.",
      partial: true,
    });
  });

  it("updates the session projection from turn and message events", () => {
    const store = new SessionStore();
    store.open(session());
    store.apply(event(1, "user/message", { content: "hello" }));
    store.apply(event(2, "turn/started", {}));
    store.apply(event(3, "assistant/message", { content: "hi" }));
    store.apply(event(4, "turn/ended", { status: "completed" }));

    expect(store.getSnapshot().session?.messages).toEqual([
      { role: "user", content: "hello", turnId },
      { role: "assistant", content: "hi", turnId },
    ]);
    expect(store.getSnapshot().session?.status).toBe("idle");
  });

  it("publishes conversation, tool lineage and trajectory from one event window", () => {
    const store = new SessionStore();
    store.open(session(), [
      event(1, "turn/started", {}),
      event(2, "tool/call", { toolCallId: "root", name: "read_file" }),
      event(3, "tool/call", { toolCallId: "child", name: "grep", parentCallId: "root" }),
      event(4, "tool/result", { toolCallId: "child", status: "completed", result: { ok: true } }),
    ]);

    const snapshot = store.getSnapshot();
    expect(snapshot.lastSequence).toBe(4);
    expect(snapshot.conversation?.lastSequence).toBe(4);
    expect(snapshot.trajectory?.lastSequence).toBe(4);
    expect(snapshot.trajectory?.records.map((record) => record.kind)).toEqual(["turn", "tool", "tool"]);
    expect(snapshot.toolCallTree?.roots).toHaveLength(1);
    expect(snapshot.toolCallTree?.roots[0]?.children).toHaveLength(1);
    expect(snapshot.events).toHaveLength(4);
  });

  it("does not let a late lower-sequence frame overwrite the current projection", () => {
    const store = new SessionStore();
    store.open(session());
    store.apply(event(5, "turn/ended", { status: "completed" }));
    store.apply(event(4, "turn/started", {}));

    expect(store.getSnapshot().session?.status).toBe("idle");
    expect(store.getSnapshot().conversation?.nodes.find((node) => node.kind === "turn")).toMatchObject({ status: "completed" });
    expect(store.getSnapshot().events.map((item) => item.sequence)).toEqual([4, 5]);
  });
});
