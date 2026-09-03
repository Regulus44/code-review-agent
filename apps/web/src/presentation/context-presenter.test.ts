import { describe, expect, it } from "vitest";
import type { SessionProjection } from "@coding-agent/contracts";
import { presentContextDiagnostics, presentContextMeter } from "./context-presenter.js";

const session = (overrides: Partial<SessionProjection> = {}): SessionProjection => ({
  id: "ses_context" as SessionProjection["id"], workspaceRoot: ".", permissionPreset: "ask-on-write", status: "idle", title: "Context", archived: false, deleted: false,
  createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z", lastSequence: 3,
  messages: [{ role: "user", content: "hello" }], turns: [], tasks: [], goals: [], plan: { content: "", status: "cleared", updatedAt: "2026-08-24T00:00:00.000Z", lastSequence: 0 }, todos: [], interactions: [], toolCalls: [], permissions: [], ...overrides,
});

describe("presentContextMeter", () => {
  it("shows unknown budget instead of inventing a provider limit", () => {
    expect(presentContextMeter(session())).toMatchObject({ status: "unknown", usedTokens: expect.any(Number) });
  });

  it("surfaces durable compaction status and ratio", () => {
    const view = presentContextMeter(session({ contextCompaction: { status: "completed", sourceSequence: 2, summary: "summary", originalMessageCount: 4, compactedMessageCount: 2, estimatedTokens: 80, droppedMessages: 2, truncatedToolResults: 1, updatedAt: "2026-08-24T00:00:00.000Z", lastSequence: 3 } }), 100);
    expect(view).toMatchObject({ status: "compacted", usedTokens: 80, maxTokens: 100, ratio: 0.8 });
    expect(view.detail).toContain("压缩 2 条消息");
    expect(view.detail).toContain("截断 1 个工具结果");
  });

  it("prefers durable provider diagnostics and exposes threshold state", () => {
    const view = presentContextMeter(session({ contextDiagnostics: {
      version: 1,
      tokenUsage: 9_500,
      tokenSource: "provider",
      tokenConfidence: "exact",
      effectiveWindowTokens: 10_000,
      warningThreshold: 7_000,
      errorThreshold: 8_000,
      autoCompactThreshold: 9_000,
      blockingThreshold: 9_800,
      percentLeft: 0,
      level: "auto_compact",
      lastStep: 2,
      lastRequestId: "request_fixture",
      lastToolResultBudget: { enabled: true, changed: true, trigger: "tokens", messageBudgetChars: 200_000, messageBudgetMessagesOverBudget: 0, messageBudgetReplacedToolCallIds: [], boundedCount: 0, clearedCount: 2, tokensSaved: 1_300, microcompactTrigger: "tokens", microcompact: { strategy: "pressure", pressureThreshold: 9_000, targetTokens: 8_000, preCompactTokens: 9_200, postCompactTokens: 7_900, checkpoint: { status: "persisted", checkpointId: "mc_fixture" }, coverage: { sourceSequenceStart: 4, sourceSequenceEnd: 12, coveredResultCount: 4, clearedResultCount: 2, toolCallIds: ["call_1", "call_2"] } }, timeBasedMicrocompactEnabled: false, timeBasedGapMs: 3_600_000, lastSequence: 8 },
      lastCompaction: { status: "completed", kind: "summary", preCompactTokens: 12_000, postCompactTokens: 8_000, tokensSaved: 4_000, sequence: 8 },
      recoveryChain: [{ status: "succeeded", attempt: 1, transitionReason: "reactive_compact_retry", lastSequence: 9 }],
      updatedAt: "2026-08-24T00:00:00.000Z",
      lastSequence: 9,
    } }));
    expect(view).toMatchObject({ status: "auto_compact", usedTokens: 9_500, maxTokens: 10_000, ratio: 0.95, source: "provider", confidence: "exact", percentLeft: 0 });
    expect(view.detail).toContain("Token 来源：provider（exact）");
    expect(view.detail).toContain("节省 4000 tokens");
    expect(view.detail).toContain("Microcompact：pressure，9200→7900 tokens；checkpoint persisted；覆盖 4 个结果，清理 2 个");
    expect(view.detail).toContain("恢复链：1 个事件");
  });

  it("returns a bounded diagnostics inspector and keeps missing diagnostics explicit", () => {
    expect(presentContextDiagnostics(session())).toEqual({ status: "unknown", detail: "暂无持久化上下文诊断信息。" });
    const diagnostics = session({ contextDiagnostics: {
      version: 1,
      tokenUsage: 10,
      tokenSource: "stale_usage",
      tokenConfidence: "low",
      effectiveWindowTokens: 100,
      warningThreshold: 60,
      errorThreshold: 70,
      autoCompactThreshold: 80,
      blockingThreshold: 90,
      percentLeft: 88,
      level: "healthy",
      recoveryChain: [],
      updatedAt: "2026-08-24T00:00:00.000Z",
      lastSequence: 4,
    } });
    expect(presentContextDiagnostics(diagnostics)).toMatchObject({ status: "healthy", detail: expect.stringContaining("stale_usage/low"), diagnostics: diagnostics.contextDiagnostics });
  });
});
