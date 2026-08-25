import type {
  ContextBudgetConfig,
  ContextBudgetSnapshot,
  ContextWarningState,
  ModelContextCapability,
} from "@code-review-agent/contracts";

export {
  assembleContext,
} from "./assembler.js";
export {
  countContextTokens,
  createTokenCounter,
  estimateContextTokens,
  shouldUseExactTokenCount,
} from "./estimator.js";
export type {
  CountContextTokensOptions,
  ModelContextView,
  TokenCount,
  TokenCountBreakdown,
  TokenCountConfidence,
  TokenCounter,
  TokenCountSource,
} from "./estimator.js";
export type {
  ContextAssembly,
  ContextAssemblyInput,
  ContextAttachment,
  ContextAttachmentKind,
  SystemPromptSection,
  SystemPromptSectionPhase,
} from "./assembler.js";

export type {
  ContextBudgetConfig,
  ContextBudgetSnapshot,
  ContextWarningState,
  ModelContextCapability,
} from "@code-review-agent/contracts";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 16_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 0;
export const MAX_SUMMARY_OUTPUT_TOKENS = 20_000;
export const DEFAULT_AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const DEFAULT_WARNING_BUFFER_TOKENS = 20_000;
export const DEFAULT_ERROR_BUFFER_TOKENS = 20_000;
export const DEFAULT_BLOCKING_BUFFER_TOKENS = 3_000;
export const DEFAULT_PREDICTIVE_GROWTH_TOKENS = 15_000;

/**
 * Conservative capability used when an adapter has no provider metadata.
 * The source is marked as estimate so callers can surface the limitation.
 */
export function fallbackModelContextCapability(
  provider = "unknown",
  model = "unknown",
  config: ContextBudgetConfig = {},
): ModelContextCapability {
  return {
    provider,
    model,
    maxInputTokens: positiveInteger(config.contextWindowTokens, DEFAULT_CONTEXT_WINDOW_TOKENS),
    maxOutputTokens: nonNegativeInteger(config.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
    supportsExactCount: false,
    supportsPromptCache: false,
    source: "estimate",
  };
}

/** Resolves Claude Code-style effective and action thresholds for one request. */
export function resolveContextBudget(
  capability: ModelContextCapability,
  config: ContextBudgetConfig = {},
): ContextBudgetSnapshot {
  const reservedOutputTokens = Math.min(
    positiveOrZero(capability.maxOutputTokens),
    positiveInteger(config.summaryOutputReservationTokens, MAX_SUMMARY_OUTPUT_TOKENS),
  );
  const effectiveWindowTokens = Math.max(1, positiveInteger(capability.maxInputTokens, DEFAULT_CONTEXT_WINDOW_TOKENS) - reservedOutputTokens);
  const autoCompactBufferTokens = positiveInteger(
    config.autoCompactBufferTokens,
    defaultAutoCompactBuffer(effectiveWindowTokens),
  );
  const warningBufferTokens = positiveInteger(config.warningBufferTokens, DEFAULT_WARNING_BUFFER_TOKENS);
  const errorBufferTokens = positiveInteger(config.errorBufferTokens, DEFAULT_ERROR_BUFFER_TOKENS);
  const blockingBufferTokens = positiveInteger(config.blockingBufferTokens, DEFAULT_BLOCKING_BUFFER_TOKENS);
  const source = config.contextWindowTokens !== undefined || config.maxOutputTokens !== undefined
    ? "hybrid"
    : capability.source ?? (capability.supportsExactCount || capability.provider !== "unknown"
      ? "provider"
      : "estimate");

  return {
    capability,
    reservedOutputTokens,
    effectiveWindowTokens,
    autoCompactBufferTokens,
    warningThreshold: threshold(effectiveWindowTokens - warningBufferTokens, effectiveWindowTokens),
    errorThreshold: threshold(effectiveWindowTokens - errorBufferTokens, effectiveWindowTokens),
    autoCompactThreshold: threshold(effectiveWindowTokens - autoCompactBufferTokens, effectiveWindowTokens),
    blockingThreshold: threshold(effectiveWindowTokens - blockingBufferTokens, effectiveWindowTokens),
    source,
  };
}

/**
 * Calculates the same warning/auto/blocking states used by the Claude Code
 * auto-compact gate. `predictiveGrowthTokens` is deliberately an estimate;
 * exact message counting belongs to the later M02 module.
 */
export function calculateContextWarningState(
  tokenUsage: number,
  snapshot: ContextBudgetSnapshot,
  config: ContextBudgetConfig = {},
): ContextWarningState {
  const usage = Math.max(0, Math.floor(Number.isFinite(tokenUsage) ? tokenUsage : 0));
  const autoCompactEnabled = config.autoCompactEnabled !== false;
  const thresholdForPercent = autoCompactEnabled ? snapshot.autoCompactThreshold : snapshot.effectiveWindowTokens;
  const percentLeft = Math.max(0, Math.round(((thresholdForPercent - usage) / Math.max(1, thresholdForPercent)) * 100));
  const predictiveGrowthTokens = positiveInteger(config.predictiveGrowthTokens, DEFAULT_PREDICTIVE_GROWTH_TOKENS);
  return {
    tokenUsage: usage,
    percentLeft,
    isAboveWarningThreshold: usage >= snapshot.warningThreshold,
    isAboveErrorThreshold: usage >= snapshot.errorThreshold,
    isAboveAutoCompactThreshold: autoCompactEnabled && usage >= snapshot.autoCompactThreshold,
    isAtBlockingLimit: usage >= snapshot.blockingThreshold,
    isPredictiveCompactRecommended: autoCompactEnabled && usage + predictiveGrowthTokens >= snapshot.effectiveWindowTokens,
  };
}

export function shouldCompactBeforeRequest(
  state: ContextWarningState,
  config: ContextBudgetConfig = {},
): boolean {
  if (config.autoCompactEnabled === false) return false;
  return state.isAboveAutoCompactThreshold || state.isPredictiveCompactRecommended;
}

function defaultAutoCompactBuffer(effectiveWindowTokens: number): number {
  if (effectiveWindowTokens >= 800_000) return 50_000;
  if (effectiveWindowTokens >= 400_000) return 30_000;
  return Math.min(DEFAULT_AUTOCOMPACT_BUFFER_TOKENS, Math.max(1, Math.floor(effectiveWindowTokens * 0.2)));
}

function threshold(value: number, max: number): number {
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function positiveOrZero(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
