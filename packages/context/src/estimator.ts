import type {
  ChatMessage,
  ChatModel,
  ContextBudgetConfig,
  ContextBudgetSnapshot,
  ModelRequest,
  ModelToolDefinition,
} from "@code-review-agent/contracts";

export type TokenCountSource = "provider" | "estimate" | "stale_usage";
export type TokenCountConfidence = "exact" | "high" | "medium" | "low";

export interface ModelContextView {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ModelToolDefinition[];
}

export interface TokenCountBreakdown {
  readonly systemTokens: number;
  readonly messageTokens: number;
  readonly toolSchemaTokens: number;
  readonly toolArgumentTokens: number;
  readonly toolResultTokens: number;
  readonly totalTokens: number;
}

export interface TokenCount {
  readonly value: number;
  readonly source: TokenCountSource;
  readonly confidence: TokenCountConfidence;
  readonly stale?: boolean;
  readonly exactAttempted?: boolean;
  readonly exactError?: string;
  readonly breakdown?: TokenCountBreakdown;
}

export interface TokenCounter {
  estimate(input: ModelContextView): TokenCount;
  countExact?(input: ModelContextView, signal?: AbortSignal): Promise<TokenCount | undefined>;
}

export interface CountContextTokensOptions {
  readonly preferExact?: boolean;
  readonly signal?: AbortSignal;
  /** Last trusted provider usage, used only when exact counting fails. */
  readonly staleUsage?: number;
}

/**
 * Fast provider-neutral count used on every request. Structured JSON is
 * intentionally more conservative than natural language; exact provider
 * tokenization belongs behind TokenCounter.countExact().
 */
export function estimateContextTokens(input: ModelContextView): TokenCount {
  const breakdown = emptyBreakdown();
  let systemTokens = 0;
  let messageTokens = 0;
  let toolSchemaTokens = 0;
  let toolArgumentTokens = 0;
  let toolResultTokens = 0;

  for (const message of input.messages) {
    if (message.role === "system") {
      systemTokens += estimateText(message.content);
      continue;
    }
    if (message.role === "tool") {
      toolResultTokens += estimateStructured(message.content);
      continue;
    }
    messageTokens += estimateText(message.content);
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) toolArgumentTokens += estimateStructured(call.arguments);
    }
  }

  for (const tool of input.tools ?? []) toolSchemaTokens += estimateStructured(JSON.stringify(tool));

  const totalTokens = systemTokens + messageTokens + toolSchemaTokens + toolArgumentTokens + toolResultTokens;
  const result: TokenCountBreakdown = {
    ...breakdown,
    systemTokens,
    messageTokens,
    toolSchemaTokens,
    toolArgumentTokens,
    toolResultTokens,
    totalTokens,
  };
  return {
    value: totalTokens,
    source: "estimate",
    confidence: "medium",
    breakdown: result,
  };
}

/** Adapts an optional ChatModel.countTokens seam to the common TokenCounter API. */
export function createTokenCounter(model: Pick<ChatModel, "countTokens">): TokenCounter {
  return {
    estimate: estimateContextTokens,
    ...(model.countTokens === undefined
      ? {}
      : {
          countExact: async (input: ModelContextView, signal?: AbortSignal): Promise<TokenCount | undefined> => {
            const request: ModelRequest = {
              messages: input.messages,
              ...(input.tools === undefined ? {} : { tools: input.tools }),
              ...(signal === undefined ? {} : { signal }),
            };
            const value = await model.countTokens?.(request);
            if (!Number.isFinite(value) || value === undefined || value < 0) return undefined;
            return { value: Math.floor(value), source: "provider", confidence: "exact" };
          },
        }),
  };
}

/**
 * Estimates first, then optionally asks the provider for an exact count.
 * A failed exact call never becomes zero and never hides the estimate.
 */
export async function countContextTokens(
  counter: TokenCounter,
  input: ModelContextView,
  options: CountContextTokensOptions = {},
): Promise<TokenCount> {
  const estimate = counter.estimate(input);
  if (options.preferExact !== true || counter.countExact === undefined) return estimate;

  try {
    const exact = await counter.countExact(input, options.signal);
    if (exact !== undefined && Number.isFinite(exact.value) && exact.value >= 0) {
      return { ...exact, value: Math.floor(exact.value), exactAttempted: true };
    }
    return withExactFailure(estimate, "provider returned no usable token count", options.staleUsage);
  } catch (error) {
    return withExactFailure(estimate, error instanceof Error ? error.message : String(error), options.staleUsage);
  }
}

/** Exact counting is reserved for boundary decisions, not every hot-path step. */
export function shouldUseExactTokenCount(
  estimate: TokenCount,
  snapshot: ContextBudgetSnapshot,
  config: ContextBudgetConfig = {},
): boolean {
  if (!snapshot.capability.supportsExactCount) return false;
  const growth = positiveInteger(config.predictiveGrowthTokens, 15_000);
  return estimate.value >= snapshot.warningThreshold || estimate.value + growth >= snapshot.effectiveWindowTokens;
}

function withExactFailure(estimate: TokenCount, error: string, staleUsage: number | undefined): TokenCount {
  if (staleUsage !== undefined && Number.isFinite(staleUsage) && staleUsage >= 0) {
    return {
      value: Math.floor(staleUsage),
      source: "stale_usage",
      confidence: "low",
      stale: true,
      exactAttempted: true,
      exactError: error,
    };
  }
  return { ...estimate, exactAttempted: true, exactError: error };
}

function estimateText(value: string): number {
  return Math.max(1, Math.ceil((value.length + 16) / 4));
}

function estimateStructured(value: string): number {
  return Math.max(1, Math.ceil((value.length + 16) / 2));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function emptyBreakdown(): TokenCountBreakdown {
  return { systemTokens: 0, messageTokens: 0, toolSchemaTokens: 0, toolArgumentTokens: 0, toolResultTokens: 0, totalTokens: 0 };
}
