import { describe, expect, it } from "vitest";
import type { ChatMessage, ContextBudgetSnapshot } from "@coding-agent/contracts";
import {
  applyToolResultBudget,
  applyToolResultBudgetAsync,
  applyMicrocompactPass,
  createToolResultBudgetState,
  DEFAULT_MICROCOMPACT_MESSAGE,
  evaluateMicrocompactPressure,
} from "./tool-result-budget.js";
import { createToolResultStorage } from "./tool-result-storage.js";

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

function resultTool(messages: readonly ChatMessage[], toolCallId: string): string {
  return messages.find((message) => message.role === "tool" && message.toolCallId === toolCallId)?.content ?? "";
}

function parallelResultMessages(count: number, size: number): ChatMessage[] {
  const toolCalls = Array.from({ length: count }, (_, index) => ({ id: `parallel-${index}`, name: "read_file", arguments: "{}" }));
  return [
    { role: "assistant", content: "", toolCalls },
    ...toolCalls.map((call) => ({ role: "tool" as const, toolCallId: call.id, content: "x".repeat(size) })),
  ];
}

const pressureSnapshot: ContextBudgetSnapshot = {
  capability: { provider: "test", model: "test", maxInputTokens: 1_000, maxOutputTokens: 0, supportsExactCount: false, supportsPromptCache: false, source: "estimate" },
  reservedOutputTokens: 0,
  effectiveWindowTokens: 1_000,
  autoCompactBufferTokens: 100,
  warningThreshold: 700,
  errorThreshold: 800,
  autoCompactThreshold: 900,
  blockingThreshold: 990,
  source: "estimate",
};

describe("applyToolResultBudget", () => {
  it("does not trigger microcompact from count while global pressure is low", () => {
    const evaluation = evaluateMicrocompactPressure(resultMessages(10, "small"), 500, pressureSnapshot, {
      policy: { microcompactTriggerToolCount: 1, keepRecentResults: 2 },
    });
    expect(evaluation.strategy).toBe("none");
    expect(evaluation.eligibleToolResultCount).toBe(10);
  });

  it("uses global pressure deficit to select a microcompact target", () => {
    const messages = resultMessages(6, "x".repeat(400));
    const evaluation = evaluateMicrocompactPressure(messages, 950, pressureSnapshot, {
      policy: { keepRecentResults: 2, microcompactTargetHysteresisTokens: 50 },
    });
    expect(evaluation.strategy).toBe("pressure");
    const result = applyMicrocompactPass(messages, { policy: { keepRecentResults: 2 }, evaluation });
    expect(result.report.newlyClearedToolCallIds.length).toBeGreaterThan(0);
    expect(toolContents(result.messages).slice(-2).every((content) => content !== DEFAULT_MICROCOMPACT_MESSAGE)).toBe(true);
  });

  it("retains a token tail in addition to the minimum recent-result count", () => {
    const messages = resultMessages(6, "x".repeat(800));
    const evaluation = evaluateMicrocompactPressure(messages, 1_000, pressureSnapshot, {
      policy: { keepRecentResults: 2, retainRecentResultsRatio: 0.8, microcompactTargetHysteresisTokens: 900 },
    });
    expect(evaluation.strategy).toBe("pressure");
    expect(evaluation.tailBudgetTokens).toBe(640);

    const result = applyMicrocompactPass(messages, {
      policy: { keepRecentResults: 2, retainRecentResultsRatio: 0.8 },
      evaluation,
    });
    const contents = toolContents(result.messages);
    expect(contents.slice(-2).every((content) => content.startsWith("x"))).toBe(true);
    expect(contents.filter((content) => content === DEFAULT_MICROCOMPACT_MESSAGE)).toHaveLength(2);
    expect(result.report.retainedTailTokens).toBeGreaterThanOrEqual(evaluation.tailBudgetTokens);
  });

  it("keeps pressure clearing decisions stable when preparation is repeated", () => {
    const messages = resultMessages(6, "x".repeat(800));
    const policy = { keepRecentResults: 2, retainRecentResultsRatio: 0.8, microcompactTargetHysteresisTokens: 900 };
    const evaluation = evaluateMicrocompactPressure(messages, 1_000, pressureSnapshot, { policy });
    const first = applyMicrocompactPass(messages, { policy, evaluation });
    const second = applyMicrocompactPass(first.messages, {
      policy,
      alreadyClearedToolCallIds: new Set(first.report.newlyClearedToolCallIds),
      evaluation,
    });
    expect(second.messages).toEqual(first.messages);
    expect(second.report.newlyClearedToolCallIds).toEqual([]);
    expect(second.report.clearedToolCallIds).toEqual(first.report.newlyClearedToolCallIds);
  });

  it("preserves the opt-in time fallback when pressure is below threshold", () => {
    const messages = resultMessages(3, "aged");
    const timestamps = Object.fromEntries(messages.filter((message) => message.role === "tool").map((message) => [message.toolCallId, new Date(0).toISOString()]));
    const evaluation = evaluateMicrocompactPressure(messages, 100, pressureSnapshot, {
      policy: { keepRecentResults: 1, timeBasedMicrocompactEnabled: true },
      toolResultTimestamps: timestamps,
      nowMs: 60 * 60_000,
    });
    expect(evaluation.strategy).toBe("time");
  });

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
      policy: { microcompactTriggerToolCount: 99, microcompactTriggerTokens: 99_999, keepRecentResults: 1, timeBasedMicrocompactEnabled: true },
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

  it("keeps time-based microcompact disabled unless explicitly enabled", () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    const result = applyToolResultBudget(resultMessages(6), {
      policy: { microcompactTriggerToolCount: 99, microcompactTriggerTokens: 99_999, keepRecentResults: 5 },
      toolResultTimestamps: { "call-0": "2026-08-26T10:00:00.000Z" },
      nowMs: now,
    });
    expect(result.report.microcompactTrigger).toBe("none");
    expect(result.report.timeBasedMicrocompactEnabled).toBe(false);
  });

  it("enforces the 200000-character aggregate budget by replacing largest fresh results", async () => {
    const storage = createToolResultStorage({ write: async () => "created" });
    const state = createToolResultBudgetState();
    const result = await applyToolResultBudgetAsync(parallelResultMessages(10, 40_000), {
      replacementState: state,
      policy: { maxToolResultsPerMessageChars: 200_000, microcompactTriggerToolCount: 99, microcompactTriggerTokens: 99_999 },
      persistToolResult: (input) => storage.persist({ sessionId: "ses_1", workspaceRoot: ".", ...input, forcePersist: true }),
    });
    const totalChars = toolContents(result.messages).reduce((sum, content) => sum + content.length, 0);
    expect(result.report.trigger).toBe("message");
    expect(result.report.messageBudgetMessagesOverBudget).toBe(1);
    expect(result.report.messageBudgetReplacedToolCallIds.length).toBeGreaterThanOrEqual(5);
    expect(totalChars).toBeLessThanOrEqual(200_000);
    expect(state.replacements.size).toBe(result.report.messageBudgetReplacedToolCallIds.length);
  });

  it("groups tool results across user fragments until an assistant boundary", async () => {
    const storage = createToolResultStorage({ write: async () => "created" });
    const calls = [
      { id: "group-a", name: "read_file", arguments: "{}" },
      { id: "group-b", name: "read_file", arguments: "{}" },
    ];
    const result = await applyToolResultBudgetAsync([
      { role: "assistant", content: "", toolCalls: calls },
      { role: "tool", toolCallId: "group-a", content: "a".repeat(130_000) },
      { role: "user", content: "interleaved user text" },
      { role: "tool", toolCallId: "group-b", content: "b".repeat(130_000) },
    ], {
      replacementState: createToolResultBudgetState(),
      policy: { maxToolResultsPerMessageChars: 200_000, microcompactTriggerToolCount: 99, microcompactTriggerTokens: 99_999 },
      persistToolResult: (input) => storage.persist({ sessionId: "ses_1", workspaceRoot: ".", ...input, forcePersist: true }),
    });
    expect(result.report.messageBudgetMessagesOverBudget).toBe(1);
    expect(result.report.messageBudgetReplacedToolCallIds).toEqual(["group-a"]);
    expect(toolContents(result.messages)[1]).toHaveLength(130_000);
  });

  it("freezes a previously sent full result and replaces only fresh results", async () => {
    const storage = createToolResultStorage({ write: async () => "created" });
    const state = createToolResultBudgetState();
    const first = await applyToolResultBudgetAsync([
      { role: "assistant", content: "", toolCalls: [{ id: "frozen", name: "read_file", arguments: "{}" }] },
      { role: "tool", toolCallId: "frozen", content: "f".repeat(150_000) },
    ], {
      replacementState: state,
      policy: { maxToolResultsPerMessageChars: 200_000, microcompactTriggerToolCount: 99, microcompactTriggerTokens: 99_999 },
      persistToolResult: (input) => storage.persist({ sessionId: "ses_1", workspaceRoot: ".", ...input, forcePersist: true }),
    });
    expect(toolContents(first.messages)[0]).toHaveLength(150_000);
    const second = await applyToolResultBudgetAsync([
      { role: "assistant", content: "", toolCalls: [
        { id: "frozen", name: "read_file", arguments: "{}" },
        { id: "fresh", name: "read_file", arguments: "{}" },
      ] },
      { role: "tool", toolCallId: "frozen", content: "f".repeat(150_000) },
      { role: "tool", toolCallId: "fresh", content: "n".repeat(150_000) },
    ], {
      replacementState: state,
      policy: { maxToolResultsPerMessageChars: 200_000, microcompactTriggerToolCount: 99, microcompactTriggerTokens: 99_999 },
      persistToolResult: (input) => storage.persist({ sessionId: "ses_1", workspaceRoot: ".", ...input, forcePersist: true }),
    });
    expect(toolContents(second.messages)[0]).toHaveLength(150_000);
    expect(resultTool(second.messages, "fresh")).toContain("<persisted-tool-result");
    expect(second.report.messageBudgetReplacedToolCallIds).toEqual(["fresh"]);
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
