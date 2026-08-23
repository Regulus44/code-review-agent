import { describe, expect, it } from "vitest";
import { compactMessages, estimateMessagesTokens } from "./index.js";

describe("context compaction", () => {
  it("keeps system and recent messages while replacing older context with a bounded summary", () => {
    const messages = [
      { role: "system", content: "system" } as const,
      { role: "user", content: "old user " + "x".repeat(400) } as const,
      { role: "assistant", content: "old answer " + "x".repeat(400) } as const,
      { role: "user", content: "recent user" } as const,
      { role: "assistant", content: "recent answer" } as const,
    ];
    const result = compactMessages(messages, { budget: { maxTokens: 120, recentMessageTokens: 40, maxSummaryChars: 300 } });
    expect(result.didCompact).toBe(true);
    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages.some((message) => message.content.includes("Compacted context"))).toBe(true);
    expect(result.summary.length).toBeLessThanOrEqual(300);
    expect(result.droppedMessages).toBeGreaterThan(0);
  });

  it("microcompacts oversized tool output without touching tool identity", () => {
    const result = compactMessages([
      { role: "system", content: "system" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "call_1", content: "secret-output-" + "x".repeat(100) },
    ], { budget: { maxTokens: 10_000, maxToolResultChars: 40 } });
    const tool = result.messages.find((message) => message.role === "tool");
    expect(tool).toMatchObject({ toolCallId: "call_1" });
    expect(tool?.content).toContain("tool result truncated");
    expect(result.truncatedToolResults).toBe(1);
  });

  it("preserves protected tool results and repairs orphaned tool calls", () => {
    const result = compactMessages([
      { role: "system", content: "system" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_old", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "call_old", content: "protected" },
      { role: "user", content: "new" },
    ], { budget: { maxTokens: 20, recentMessageTokens: 8 }, protectedToolCallIds: new Set(["call_old"]) });
    expect(result.messages.some((message) => message.role === "tool" && message.toolCallId === "call_old")).toBe(true);
    expect(estimateMessagesTokens(result.messages)).toBeGreaterThan(0);
  });
});
