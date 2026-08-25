import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@code-review-agent/contracts";
import {
  applyToolResultBudget,
  DEFAULT_MICROCOMPACT_MESSAGE,
} from "./tool-result-budget.js";

function resultMessages(count: number, content = "result"): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `call-${index}`;
    messages.push({ role: "assistant", content: "", toolCalls: [{ id, name: "read_file", arguments: "{}" }] });
    messages.push({ role: "tool", toolCallId: id, content: `${content}-${index}` });
  }
  return messages;
}

function toolContents(messages: readonly ChatMessage[]): readonly string[] {
  return messages.filter((message) => message.role === "tool").map((message) => message.content);
}

describe("applyToolResultBudget", () => {
  it("keeps ordinary results full", () => {
    const messages = resultMessages(1);
    const result = applyToolResultBudget(messages, { policy: { maxResultChars: 100 } });
    expect(toolContents(result.messages)).toEqual(["result-0"]);
    expect(result.report.changed).toBe(false);
  });

  it("bounds an oversized compactable result without changing the input", () => {
    const messages = resultMessages(1, "x".repeat(100));
    const result = applyToolResultBudget(messages, { policy: { maxResultChars: 24 } });
    const bounded = toolContents(result.messages)[0] ?? "";
    expect(toolContents(messages)[0]).toHaveLength(102);
    expect(bounded).toContain("[tool result bounded by");
    expect(bounded.length).toBeLessThanOrEqual(24);
    expect(result.report.boundedToolCallIds).toEqual(["call-0"]);
    expect(result.report.tokensSaved).toBeGreaterThan(0);
  });

  it("microcompacts old results and keeps the newest results", () => {
    const result = applyToolResultBudget(resultMessages(6, "x".repeat(80)), {
      policy: { maxResultChars: 200, microcompactTriggerToolCount: 6, keepRecentResults: 2 },
    });
    const contents = toolContents(result.messages);
    expect(contents.slice(0, 4).every((content) => content === DEFAULT_MICROCOMPACT_MESSAGE)).toBe(true);
    expect(contents.slice(4).every((content) => content.startsWith("x"))).toBe(true);
    expect(result.report.newlyClearedToolCallIds).toEqual(["call-0", "call-1", "call-2", "call-3"]);
    expect(result.report.trigger).toBe("count");
  });

  it("protects pending tool calls and excludes non-compactable tools", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [
        { id: "protected", name: "read_file", arguments: "{}" },
        { id: "custom", name: "database_query", arguments: "{}" },
        { id: "old", name: "read_file", arguments: "{}" },
      ] },
      { role: "tool", toolCallId: "protected", content: "p".repeat(50) },
      { role: "tool", toolCallId: "custom", content: "c".repeat(50) },
      { role: "tool", toolCallId: "old", content: "o".repeat(100) },
    ];
    const result = applyToolResultBudget(messages, {
      policy: { maxResultChars: 50, microcompactTriggerToolCount: 2, keepRecentResults: 1 },
      protectedToolCallIds: new Set(["protected"]),
    });
    expect(toolContents(result.messages)[0]).toBe("p".repeat(50));
    expect(toolContents(result.messages)[1]).toBe("c".repeat(50));
    expect(toolContents(result.messages)[2]).toContain("[tool result bounded by context budget]");
    expect(result.report.protectedToolCallIds).toContain("protected");
  });

  it("uses time-based decay for old eligible results", () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const result = applyToolResultBudget(resultMessages(3), {
      policy: { microcompactTriggerToolCount: 99, microcompactTriggerTokens: 99_999, keepRecentResults: 1, timeBasedGapMs: 30 * 60_000 },
      toolResultTimestamps: {
        "call-0": "2026-08-26T10:00:00.000Z",
        "call-1": "2026-08-26T11:50:00.000Z",
        "call-2": "2026-08-26T11:55:00.000Z",
      },
      nowMs: now,
    });
    expect(result.report.trigger).toBe("time");
    expect(result.report.newlyClearedToolCallIds).toEqual(["call-0", "call-1"]);
  });

  it("uses the bounded view for token-triggered clearing", () => {
    const result = applyToolResultBudget(resultMessages(4, "x".repeat(200)), {
      policy: { maxResultChars: 20, microcompactTriggerToolCount: 99, microcompactTriggerTokens: 20, keepRecentResults: 1 },
    });
    expect(result.report.trigger).toBe("tokens");
    expect(result.report.newlyClearedToolCallIds.length).toBeGreaterThan(0);
  });

  it("is idempotent after cleared markers are applied", () => {
    const first = applyToolResultBudget(resultMessages(4), {
      policy: { microcompactTriggerToolCount: 4, keepRecentResults: 1 },
    });
    const second = applyToolResultBudget(first.messages, {
      policy: { microcompactTriggerToolCount: 4, keepRecentResults: 1 },
      alreadyClearedToolCallIds: new Set(first.report.newlyClearedToolCallIds),
    });
    expect(second.messages).toEqual(first.messages);
    expect(second.report.newlyClearedToolCallIds).toEqual([]);
  });

  it("accounts for structured media conservatively", () => {
    const content = JSON.stringify([{ type: "image", data: "a" }, { type: "document", data: "b" }]);
    const result = applyToolResultBudget([
      { role: "assistant", content: "", toolCalls: [{ id: "media", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "media", content },
    ], { policy: { maxResultChars: 10 } });
    expect(result.report.views[0]?.originalTokens).toBeGreaterThan(2_000);
    expect(result.report.tokensSaved).toBeGreaterThan(0);
  });
});
