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
    expect(store.getSnapshot().session?.turns).toMatchObject([{ id: turnId, status: "completed", userMessage: "hello", assistantMessage: "hi" }]);
  });

  it("keeps a newly queued turn visible to the queue presenter without a refetch", () => {
    const store = new SessionStore();
    store.open(session());
    store.apply(event(1, "user/message", { content: "queued prompt" }));
    store.apply(event(2, "turn/queued", {}));

    expect(store.getSnapshot().session?.turns).toMatchObject([{ id: turnId, status: "queued", userMessage: "queued prompt" }]);
  });

  it("replays steering as an additional user message without overwriting the prompt", () => {
    const store = new SessionStore();
    store.open(session());
    store.apply(event(1, "user/message", { content: "original prompt" }));
    store.apply(event(2, "turn/started", {}));
    store.apply(event(3, "turn/steered", { content: "additional guidance", receiptId: "steer_1", status: "accepted" }));

    expect(store.getSnapshot().session?.messages).toEqual([
      { role: "user", content: "original prompt", turnId },
      { role: "user", content: "additional guidance", turnId },
    ]);
    expect(store.getSnapshot().session?.turns).toMatchObject([{ id: turnId, userMessage: "original prompt", status: "running" }]);
  });

  it("replays queue order from queue/changed instead of local array order", () => {
    const secondTurn = brand<string, "TurnId">("turn_second");
    const store = new SessionStore();
    store.open(session());
    store.apply(event(1, "user/message", { content: "first" }));
    store.apply(event(2, "turn/queued", {}));
    store.apply({ ...event(3, "user/message", { content: "second" }), turnId: secondTurn });
    store.apply({ ...event(4, "turn/queued", {}), turnId: secondTurn });
    store.apply(event(5, "queue/changed", { queuedTurnIds: [secondTurn, turnId] }, false));

    expect(store.getSnapshot().session?.turns.map((turn) => [turn.id, turn.queuePosition])).toEqual([
      [turnId, 2],
      [secondTurn, 1],
    ]);
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

  it("prepends older history and rebuilds derived projections without moving the live cursor", () => {
    const store = new SessionStore();
    store.open({ ...session(), lastSequence: 5 }, [
      event(4, "assistant/message", { content: "tail" }, false),
      event(5, "turn/ended", { status: "completed" }),
    ], { hasMoreBefore: true, oldestSequence: 4, newestSequence: 5 });
    store.prependHistory([
      event(1, "user/message", { content: "older prompt" }),
      event(2, "turn/started", {}),
      event(3, "assistant/message", { content: "older answer" }),
    ], { hasMoreBefore: false, oldestSequence: 1, newestSequence: 3 });

    const snapshot = store.getSnapshot();
    expect(snapshot.events.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(snapshot.lastSequence).toBe(5);
    expect(snapshot.history.hasOlder).toBe(false);
    expect(snapshot.conversation?.nodes.filter((node) => node.kind === "user")).toHaveLength(1);
    expect(snapshot.conversation?.nodes.filter((node) => node.kind === "assistant")).toHaveLength(2);
    expect(snapshot.trajectory?.lastSequence).toBe(5);
    expect(snapshot.history.baseSequence).toBe(1);
    expect(snapshot.history.tailSequence).toBe(5);
  });

  it("rejects a non-contiguous older page and reports live gaps without mutating the window", () => {
    const store = new SessionStore();
    store.open(session(), [event(4, "assistant/message", { content: "tail" }, false)], { hasMoreBefore: true, oldestSequence: 4, newestSequence: 4 }, 7);

    expect(store.prependHistory([event(1, "user/message", { content: "missing 2" }, false), event(3, "assistant/message", { content: "out of order" }, false)], { hasMoreBefore: true })).toBe(false);
    expect(store.getSnapshot().events.map((item) => item.sequence)).toEqual([4]);
    expect(store.getSnapshot().connectionGeneration).toBe(7);
    expect(store.applyLive(event(6, "assistant/chunk", { text: "gap" }, false))).toBe("gap");
    expect(store.getSnapshot().lastSequence).toBe(4);
  });

  it("appends a contiguous repair page and drains the live cursor", () => {
    const store = new SessionStore();
    store.open(session(), [event(1, "user/message", { content: "prompt" }), event(2, "assistant/chunk", { text: "answer" })], { newestSequence: 2 });

    expect(store.appendHistory([event(3, "tool/call", { toolCallId: "tool", name: "read_file" }), event(4, "tool/result", { toolCallId: "tool", status: "completed" })], { hasMoreAfter: false })).toBe(true);
    expect(store.getSnapshot().events.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
    expect(store.getSnapshot().history.tailSequence).toBe(4);
    expect(store.applyLive(event(6, "assistant/chunk", { text: "still missing 5" }))).toBe("gap");
  });

  it("clears a stale transport error after recovery", () => {
    const store = new SessionStore();
    store.open(session());
    store.setConnection("failed", "connection lost");
    expect(store.getSnapshot().error).toBe("connection lost");
    store.setConnection("connected");
    expect(store.getSnapshot().error).toBeUndefined();
  });

  it("folds live context diagnostics, compaction receipts, and bounded recovery events", () => {
    const store = new SessionStore();
    store.open(session());
    store.apply(event(1, "step/started", {
      step: 2,
      contextBudget: { effectiveWindowTokens: 10_000, warningThreshold: 7_000, errorThreshold: 8_000, autoCompactThreshold: 9_000, blockingThreshold: 9_800 },
      contextWarning: { percentLeft: 4, isAboveWarningThreshold: true, isAboveErrorThreshold: true, isAboveAutoCompactThreshold: true, isAtBlockingLimit: false },
      tokenCount: { value: 9_600, source: "provider", confidence: "exact", breakdown: { messages: 9_000, tools: 600 } },
      modelRequestId: "request_live",
    }));
    store.apply(event(2, "context/recovery_started", { attempt: 1, errorClass: "prompt_too_long", transitionReason: "reactive_compact_retry", providerStatus: 413 }));
    store.apply(event(3, "context/summary_compacted", { kind: "summary", preCompactTokens: 9_600, postCompactTokens: 3_200, estimatedTokens: 3_200 }));
    store.apply(event(4, "context/recovery_succeeded", { attempt: 1, transitionReason: "reactive_compact_retry" }));
    store.apply(event(5, "context/microcompacted", { tokensSaved: 321 }));

    const diagnostics = store.getSnapshot().session?.contextDiagnostics;
    expect(diagnostics).toMatchObject({
      tokenUsage: 9_600,
      tokenSource: "provider",
      tokenConfidence: "exact",
      level: "auto_compact",
      lastStep: 2,
      lastRequestId: "request_live",
      lastCompaction: { status: "completed", kind: "micro", tokensSaved: 321 },
    });
    expect(diagnostics?.recoveryChain).toHaveLength(2);
  });
});
