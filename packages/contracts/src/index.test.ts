import { describe, expect, it } from "vitest";
import { brand, createSessionStatsProjection, reduceSessionStats, type AgentEvent, type SessionId } from "./index.js";

describe("contracts", () => {
  it("brands runtime identifiers without changing their serialized value", () => {
    const id = brand<string, "SessionId">("session-1");
    const sessionId: SessionId = id;
    expect(sessionId).toBe("session-1");
    expect(JSON.stringify(sessionId)).toBe('"session-1"');
  });

  it("folds complete-log turns, timing, tokens, and latest prompt", () => {
    const sessionId = brand<string, "SessionId">("session-stats");
    const turnId = brand<string, "TurnId">("turn-stats");
    const events: AgentEvent[] = [
      { eventId: "e1", sequence: 1, schemaVersion: 1, sessionId, turnId, type: "user/message", createdAt: "2026-08-26T00:00:00.000Z", payload: { content: "first" } },
      { eventId: "e2", sequence: 2, schemaVersion: 1, sessionId, turnId, type: "turn/started", createdAt: "2026-08-26T00:00:00.000Z", payload: {} },
      { eventId: "e3", sequence: 3, schemaVersion: 1, sessionId, turnId, type: "step/started", createdAt: "2026-08-26T00:00:00.100Z", payload: { step: 1 } },
      { eventId: "e4", sequence: 4, schemaVersion: 1, sessionId, turnId, type: "assistant/chunk", createdAt: "2026-08-26T00:00:00.300Z", payload: { text: "ok" } },
      { eventId: "e5", sequence: 5, schemaVersion: 1, sessionId, turnId, type: "assistant/message", createdAt: "2026-08-26T00:00:01.100Z", payload: { content: "ok", usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 500, reasoningTokens: 40 } } },
      { eventId: "e6", sequence: 6, schemaVersion: 1, sessionId, turnId, type: "turn/ended", createdAt: "2026-08-26T00:00:03.000Z", payload: { status: "completed" } },
    ];
    let stats = createSessionStatsProjection("2026-08-26T00:00:00.000Z");
    for (const event of events) stats = reduceSessionStats(stats, event);
    expect(stats).toMatchObject({ turnCount: 1, stepCount: 1, turnDurationMs: 3000, llmDurationMs: 1000, ttftMs: 300, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, totalTokens: 1200, cacheHitPercent: 50, latestPrompt: "first", status: "idle", sourceSequence: 6, complete: true });
  });
});
