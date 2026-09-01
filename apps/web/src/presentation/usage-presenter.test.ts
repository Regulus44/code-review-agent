import { describe, expect, it } from "vitest";
import { createSessionStatsProjection, reduceSessionStats, brand, type AgentEvent } from "@coding-agent/contracts";
import { formatDuration, formatTokens, presentUsage, summarizeUsage } from "./usage-presenter.js";

const event = (sequence: number, type: string, createdAt: string, payload: Record<string, unknown> = {}, turnId = "turn_1") => ({ sequence, type, createdAt, payload, turnId });

describe("usage presenter", () => {
  it("aggregates provider usage and derives timing from replayed events", () => {
    const events = [
      event(1, "turn/started", "2026-08-25T00:00:00.000Z"),
      event(2, "step/started", "2026-08-25T00:00:00.100Z", { step: 1 }),
      event(3, "assistant/chunk", "2026-08-25T00:00:00.300Z", { text: "hi" }),
      event(4, "assistant/message", "2026-08-25T00:00:01.100Z", { usage: { inputTokens: 1000, outputTokens: 200, cachedTokens: 500, reasoningTokens: 40 } }),
      event(5, "tool/call", "2026-08-25T00:00:01.200Z", { toolCallId: "call_1" }),
      event(6, "tool/result", "2026-08-25T00:00:02.200Z", { toolCallId: "call_1" }),
      event(7, "turn/ended", "2026-08-25T00:00:03.000Z", { status: "completed" }),
    ];
    expect(summarizeUsage(events)).toMatchObject({ turnCount: 1, stepCount: 1, toolCallCount: 1, turnDurationMs: 3000, llmDurationMs: 1000, toolDurationMs: 1000, ttftMs: 300, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, totalTokens: 1200, cacheHitPercent: 50 });
    expect(presentUsage(events).compactLabel).toContain("输入 1k");
  });

  it("keeps unavailable values unknown instead of estimating them", () => {
    const view = presentUsage([event(1, "turn/started", "2026-08-25T00:00:00.000Z")]);
    expect(view.compactLabel).toContain("LLM —");
    expect(view.summary.outputTokens).toBeUndefined();
    expect(view.details.find((item) => item.label === "生成速度")?.value).toBe("—");
  });

  it("formats compact token and duration values", () => {
    expect(formatTokens(2100)).toBe("2.1k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatDuration(1200)).toBe("1.2s");
    expect(formatDuration(62_000)).toBe("1m 2s");
  });

  it("presents a whole-log stats projection independently of the bounded event window", () => {
    const sessionId = brand<string, "SessionId">("usage-session");
    const turnId = brand<string, "TurnId">("usage-turn");
    const events: AgentEvent[] = [
      { eventId: "e1", sequence: 1, schemaVersion: 1, sessionId, turnId, type: "user/message", createdAt: "2026-08-26T00:00:00.000Z", payload: { content: "latest" } },
      { eventId: "e2", sequence: 2, schemaVersion: 1, sessionId, turnId, type: "turn/started", createdAt: "2026-08-26T00:00:00.000Z", payload: {} },
      { eventId: "e3", sequence: 3, schemaVersion: 1, sessionId, turnId, type: "step/started", createdAt: "2026-08-26T00:00:00.100Z", payload: { step: 1 } },
      { eventId: "e4", sequence: 4, schemaVersion: 1, sessionId, turnId, type: "assistant/message", createdAt: "2026-08-26T00:00:01.100Z", payload: { usage: { inputTokens: 100, outputTokens: 20 } } },
      { eventId: "e5", sequence: 5, schemaVersion: 1, sessionId, turnId, type: "turn/ended", createdAt: "2026-08-26T00:00:02.000Z", payload: { status: "completed" } },
    ];
    let stats = createSessionStatsProjection("2026-08-26T00:00:00.000Z");
    for (const item of events) stats = reduceSessionStats(stats, item);
    const view = presentUsage(stats);
    expect(view.source).toBe("projection");
    expect(view.complete).toBe(true);
    expect(view.summary).toMatchObject({ turnCount: 1, stepCount: 1, inputTokens: 100, outputTokens: 20, latestPrompt: "latest" });
    expect(view.title).toContain("完整会话日志");
  });
});
