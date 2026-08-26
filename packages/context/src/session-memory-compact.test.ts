import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@code-review-agent/contracts";
import {
  adjustIndexToPreserveAPIInvariants,
  calculateMessagesToKeepIndex,
  compactWithSessionMemory,
} from "./session-memory-compact.js";

function history(): ChatMessage[] {
  return [
    { role: "system", content: "system" },
    { role: "user", content: "old user", messageId: "m1" },
    { role: "assistant", content: "old answer", messageId: "m2", responseId: "r1" },
    { role: "assistant", content: "tool call", messageId: "m3", responseId: "r2", toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }] },
    { role: "tool", content: "tool result", messageId: "m4", toolCallId: "call-1" },
    { role: "user", content: "recent user", messageId: "m5" },
    { role: "assistant", content: "recent answer", messageId: "m6", responseId: "r3" },
  ];
}

describe("session memory compact", () => {
  it("uses an existing memory summary without invoking an LLM", () => {
    const result = compactWithSessionMemory(history(), {
      memory: { content: "Goal: finish review", lastSummarizedMessageId: "m2" },
      config: { minTokens: 1, minTextBlockMessages: 1, maxTokens: 1000 },
    });
    expect(result.didCompact).toBe(true);
    expect(result.summaryMessage?.content).toContain("Goal: finish review");
    expect(result.messages.some((message) => message.content === "old user")).toBe(false);
    expect(result.messages.some((message) => message.content === "recent user")).toBe(true);
  });

  it("does not guess when a known summarized boundary is absent", () => {
    const result = compactWithSessionMemory(history(), {
      memory: { content: "memory", lastSummarizedMessageId: "missing" },
    });
    expect(result.didCompact).toBe(false);
    expect(result.reason).toBe("boundary-not-found");
    expect(result.boundaryKnown).toBe(false);
  });

  it("uses a conservative recent window when memory has no boundary", () => {
    const result = compactWithSessionMemory(history(), {
      memory: { content: "memory" },
      config: { minTokens: 1, minTextBlockMessages: 1, maxTokens: 1000 },
    });
    expect(result.didCompact).toBe(true);
    expect(result.boundaryKnown).toBe(false);
    expect(result.messages.some((message) => message.content.includes("memory"))).toBe(true);
  });

  it("expands the start to preserve tool pairs and shared response streams", () => {
    const messages = history();
    expect(adjustIndexToPreserveAPIInvariants(messages, 4)).toBe(3);
    expect(calculateMessagesToKeepIndex(messages, 4, { minTokens: 1, minTextBlockMessages: 1, maxTokens: 1000, maxMemoryChars: 1000 })).toBeLessThanOrEqual(3);
  });

  it("preserves protected tool results when the retained window moves backward", () => {
    const result = compactWithSessionMemory(history(), {
      memory: { content: "memory" },
      config: { minTokens: 1, minTextBlockMessages: 0, maxTokens: 1000 },
      protectedToolCallIds: new Set(["call-1"]),
    });
    expect(result.messages.some((message) => message.role === "tool" && message.toolCallId === "call-1")).toBe(true);
  });

  it("truncates oversized memory instead of allowing it to consume the view", () => {
    const result = compactWithSessionMemory(history(), {
      memory: { content: "x".repeat(200) },
      config: { minTokens: 1, minTextBlockMessages: 1, maxTokens: 1000, maxMemoryChars: 32 },
    });
    expect(result.memoryTruncated).toBe(true);
    expect(result.summaryMessage?.content.length).toBeLessThan(160);
  });

  it("returns a fallback result when the rebuilt view still exceeds the threshold", () => {
    const result = compactWithSessionMemory(history(), {
      memory: { content: "memory", lastSummarizedMessageId: "m2" },
      config: { minTokens: 1, minTextBlockMessages: 1, maxTokens: 1000 },
      maxPostCompactTokens: 1,
    });
    expect(result.didCompact).toBe(false);
    expect(result.reason).toBe("threshold-exceeded");
  });
});
