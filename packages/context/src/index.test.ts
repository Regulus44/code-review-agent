import { describe, expect, it } from "vitest";
import {
  calculateContextWarningState,
  fallbackModelContextCapability,
  resolveContextBudget,
  shouldCompactBeforeRequest,
} from "./index.js";

describe("Claude Code-style context budget", () => {
  it("reserves output tokens before deriving the effective window", () => {
    const snapshot = resolveContextBudget({
      provider: "fixture",
      model: "fixture-128k",
      maxInputTokens: 128_000,
      maxOutputTokens: 32_000,
      supportsExactCount: false,
      supportsPromptCache: false,
    });
    expect(snapshot.reservedOutputTokens).toBe(20_000);
    expect(snapshot.effectiveWindowTokens).toBe(108_000);
    expect(snapshot.autoCompactThreshold).toBe(95_000);
    expect(snapshot.blockingThreshold).toBe(105_000);
    expect(snapshot.source).toBe("provider");
  });

  it("uses 13k/30k/50k auto-compact buffers by window size", () => {
    expect(resolveContextBudget({ provider: "p", model: "small", maxInputTokens: 200_000, maxOutputTokens: 0, supportsExactCount: false, supportsPromptCache: false }).autoCompactBufferTokens).toBe(13_000);
    expect(resolveContextBudget({ provider: "p", model: "mid", maxInputTokens: 500_000, maxOutputTokens: 0, supportsExactCount: false, supportsPromptCache: false }).autoCompactBufferTokens).toBe(30_000);
    expect(resolveContextBudget({ provider: "p", model: "large", maxInputTokens: 1_000_000, maxOutputTokens: 0, supportsExactCount: false, supportsPromptCache: false }).autoCompactBufferTokens).toBe(50_000);
  });

  it("reports warning, auto compact, blocking and predictive states", () => {
    const snapshot = resolveContextBudget({ provider: "p", model: "m", maxInputTokens: 100_000, maxOutputTokens: 0, supportsExactCount: false, supportsPromptCache: false });
    const state = calculateContextWarningState(87_000, snapshot, { predictiveGrowthTokens: 15_000 });
    expect(state.isAboveWarningThreshold).toBe(true);
    expect(state.isAboveErrorThreshold).toBe(true);
    expect(state.isAboveAutoCompactThreshold).toBe(true);
    expect(state.isAtBlockingLimit).toBe(false);
    expect(state.isPredictiveCompactRecommended).toBe(true);
    expect(shouldCompactBeforeRequest(state)).toBe(true);
  });

  it("supports an explicit fallback and disabled auto compact", () => {
    const capability = fallbackModelContextCapability("echo", "echo", { contextWindowTokens: 12_000 });
    const snapshot = resolveContextBudget(capability, { autoCompactEnabled: false });
    const state = calculateContextWarningState(11_900, snapshot, { autoCompactEnabled: false });
    expect(snapshot.source).toBe("estimate");
    expect(state.isAboveAutoCompactThreshold).toBe(false);
    expect(shouldCompactBeforeRequest(state, { autoCompactEnabled: false })).toBe(false);
  });
});
