import { describe, expect, it, vi } from "vitest";
import {
  countContextTokens,
  createTokenCounter,
  estimateContextTokens,
  shouldUseExactTokenCount,
  type ModelContextView,
} from "./estimator.js";
import { resolveContextBudget } from "./index.js";

describe("M02 token estimator", () => {
  const view: ModelContextView = {
    messages: [
      { role: "system", content: "system rules" },
      { role: "user", content: "read the file" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "src/index.ts" }) }] },
      { role: "tool", toolCallId: "call_1", content: JSON.stringify({ path: "src/index.ts", content: "x".repeat(100) }) },
    ],
    tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
  };

  it("returns a breakdown that separates system, messages, schemas, arguments and results", () => {
    const result = estimateContextTokens(view);
    expect(result.source).toBe("estimate");
    expect(result.confidence).toBe("medium");
    expect(result.breakdown).toMatchObject({
      systemTokens: expect.any(Number),
      messageTokens: expect.any(Number),
      toolSchemaTokens: expect.any(Number),
      toolArgumentTokens: expect.any(Number),
      toolResultTokens: expect.any(Number),
      totalTokens: result.value,
    });
    expect(result.breakdown?.toolResultTokens).toBeGreaterThan(result.breakdown?.messageTokens ?? 0);
  });

  it("uses exact provider count only when the capability is near a budget boundary", async () => {
    const countTokens = vi.fn(async () => 777);
    const counter = createTokenCounter({ countTokens });
    const snapshot = resolveContextBudget({ provider: "fixture", model: "m", maxInputTokens: 100, maxOutputTokens: 0, supportsExactCount: true, supportsPromptCache: false });
    const estimate = counter.estimate({ messages: [{ role: "user", content: "x".repeat(90) }] });
    expect(shouldUseExactTokenCount(estimate, snapshot, { predictiveGrowthTokens: 1 })).toBe(true);
    const result = await countContextTokens(counter, { messages: [{ role: "user", content: "x".repeat(90) }] }, { preferExact: true });
    expect(result).toMatchObject({ value: 777, source: "provider", confidence: "exact", exactAttempted: true });
    expect(countTokens).toHaveBeenCalledTimes(1);
  });

  it("keeps the estimate when exact counting fails and exposes the error", async () => {
    const counter = createTokenCounter({ countTokens: async () => { throw new Error("count endpoint unavailable"); } });
    const result = await countContextTokens(counter, { messages: [{ role: "user", content: "hello" }] }, { preferExact: true });
    expect(result.source).toBe("estimate");
    expect(result.exactAttempted).toBe(true);
    expect(result.exactError).toBe("count endpoint unavailable");
    expect(result.value).toBeGreaterThan(0);
  });

  it("uses stale usage only when explicitly supplied", async () => {
    const counter = createTokenCounter({ countTokens: async () => undefined });
    const result = await countContextTokens(counter, { messages: [{ role: "user", content: "hello" }] }, { preferExact: true, staleUsage: 42 });
    expect(result).toMatchObject({ value: 42, source: "stale_usage", confidence: "low", stale: true, exactAttempted: true });
  });
});
