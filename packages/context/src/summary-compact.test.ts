import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@coding-agent/contracts";
import { buildSummaryInput } from "./summary-input.js";
import { compactWithSummaryModel, truncateHeadForPtlRetry } from "./summary-compact.js";

function messages(): ChatMessage[] {
  return [
    { role: "user", content: "old request", messageId: "m1" },
    { role: "assistant", content: "old answer", responseId: "r1", messageId: "m2" },
    { role: "user", content: "recent request", messageId: "m3" },
    { role: "assistant", content: "recent answer", responseId: "r2", messageId: "m4" },
    { role: "user", content: "current request", messageId: "m5" },
  ];
}

describe("summary compact", () => {
  it("bounds the default summary text at 8192 characters", async () => {
    const result = await compactWithSummaryModel(messages(), {
      config: { recentMessageTokens: 10 },
      runner: async () => ({ text: "x".repeat(10_000) }),
    });
    expect(result.summary?.length).toBe(8_192);
  });

  it("builds a provider-safe summary input without internal IDs or reinjected skill content", () => {
    const input = buildSummaryInput([
      { role: "user", content: "<image>pixels</image> [document: report.pdf]", messageId: "internal" },
      { role: "user", content: '<context-attachment id="skill-1" kind="skill">stale skill</context-attachment>', messageId: "skill" },
    ]);
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ role: "user", content: "[image] [document]" });
    expect(input[0]).not.toHaveProperty("messageId");
  });

  it("summarizes with no tools and preserves a bounded recent suffix", async () => {
    const requests: Array<{ purpose: string; toolCount: number; messages: readonly ChatMessage[] }> = [];
    const result = await compactWithSummaryModel(messages(), {
      config: { recentMessageTokens: 10, maxSummaryChars: 80 },
      runner: async (request) => {
        requests.push({ purpose: request.purpose, toolCount: request.tools.length, messages: request.messages });
        return { text: "Goal and important decisions" };
      },
    });
    expect(result.didCompact).toBe(true);
    expect(result.summaryMessage?.content).toContain("<conversation-summary>");
    expect(result.messages.at(-1)?.content).toBe("current request");
    expect(requests[0]).toMatchObject({ purpose: "context_summary", toolCount: 0 });
    expect(requests[0]?.messages.at(-1)?.content).toContain("Summarize the conversation history");
  });

  it("retries prompt-too-long by dropping oldest API rounds and adding a user marker", async () => {
    let calls = 0;
    const result = await compactWithSummaryModel(messages(), {
      config: { recentMessageTokens: 10, maxPtlRetries: 3 },
      runner: async () => {
        calls += 1;
        if (calls === 1) throw new Error("PROMPT_TOO_LONG");
        return { text: "Recovered summary" };
      },
    });
    expect(result.didCompact).toBe(true);
    expect(result.retries).toBe(1);
    expect(calls).toBe(2);
  });

  it("returns a structured failure after bounded prompt-too-long retries", async () => {
    const result = await compactWithSummaryModel(messages(), {
      config: { recentMessageTokens: 10, maxPtlRetries: 1 },
      runner: async () => {
        throw new Error("context length exceeded");
      },
    });
    expect(result.didCompact).toBe(false);
    expect(result.reason).toBe("prompt-too-long");
    expect(result.retries).toBe(1);
    expect(result.error).toContain("context length");
  });

  it("does not drop the final API round during a retry", () => {
    const truncated = truncateHeadForPtlRetry(messages());
    expect(truncated).toBeDefined();
    expect(truncated?.at(-1)?.content).toBe("current request");
  });

  it("injects bounded microcompact checkpoint facts and omits covered tool evidence", async () => {
    const requests: ChatMessage[][] = [];
    const input: ChatMessage[] = [
      { role: "user", content: "inspect the repository", messageId: "u1" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-old", name: "read_file", arguments: "{}" }], messageId: "a1" },
      { role: "tool", toolCallId: "call-old", content: "[Old tool result content cleared]", messageId: "t1" },
      { role: "user", content: "continue", messageId: "u2" },
    ];
    const result = await compactWithSummaryModel(input, {
      config: { recentMessageTokens: 1 },
      historicalContext: '{"verifiedFindings":["tests pass"],"nextStep":"run lint"}',
      historicalToolCallIds: new Set(["call-old"]),
      runner: async (request) => {
        requests.push(request.messages);
        return { text: "checkpoint-aware summary" };
      },
    });
    expect(result.didCompact).toBe(true);
    expect(requests[0]?.some((message) => message.content.includes("<microcompact-checkpoint>"))).toBe(true);
    expect(requests[0]?.some((message) => message.role === "tool" && message.toolCallId === "call-old")).toBe(false);
  });
});
