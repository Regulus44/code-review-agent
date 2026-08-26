import { describe, expect, it } from "vitest";
import type { SessionProjection } from "@code-review-agent/contracts";
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
    expect(view.detail).toContain("Compacted 2 messages");
    expect(view.detail).toContain("truncated 1 tool result");
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
      lastCompaction: { status: "completed", kind: "summary", preCompactTokens: 12_000, postCompactTokens: 8_000, tokensSaved: 4_000, sequence: 8 },
      recoveryChain: [{ status: "succeeded", attempt: 1, transitionReason: "reactive_compact_retry", lastSequence: 9 }],
      updatedAt: "2026-08-24T00:00:00.000Z",
      lastSequence: 9,
    } }));
    expect(view).toMatchObject({ status: "auto_compact", usedTokens: 9_500, maxTokens: 10_000, ratio: 0.95, source: "provider", confidence: "exact", percentLeft: 0 });
    expect(view.detail).toContain("Token source: provider (exact)");
    expect(view.detail).toContain("saved 4000 tokens");
    expect(view.detail).toContain("Recovery chain: 1 event");
  });

  it("returns a bounded diagnostics inspector and keeps missing diagnostics explicit", () => {
    expect(presentContextDiagnostics(session())).toEqual({ status: "unknown", detail: "No durable context diagnostics are available." });
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
