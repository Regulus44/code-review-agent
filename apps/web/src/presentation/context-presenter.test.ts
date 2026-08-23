import { describe, expect, it } from "vitest";
import type { SessionProjection } from "@code-review-agent/contracts";
import { presentContextMeter } from "./context-presenter.js";

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
    const view = presentContextMeter(session({ contextCompaction: { status: "completed", sourceSequence: 2, summary: "summary", originalMessageCount: 4, compactedMessageCount: 2, estimatedTokens: 80, droppedMessages: 2, updatedAt: "2026-08-24T00:00:00.000Z", lastSequence: 3 } }), 100);
    expect(view).toMatchObject({ status: "compacted", usedTokens: 80, maxTokens: 100, ratio: 0.8 });
    expect(view.detail).toContain("Compacted 2 messages");
  });
});
