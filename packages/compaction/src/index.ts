import type { ChatMessage } from "@code-review-agent/contracts";

export interface ContextBudget {
  readonly maxTokens: number;
  readonly recentMessageTokens: number;
  readonly maxToolResultChars: number;
  readonly maxSummaryChars: number;
}

export interface CompactionOptions {
  readonly budget?: Partial<ContextBudget>;
  readonly protectedToolCallIds?: ReadonlySet<string>;
}

export interface CompactionResult {
  readonly didCompact: boolean;
  readonly messages: readonly ChatMessage[];
  readonly summary: string;
  readonly originalMessageCount: number;
  readonly compactedMessageCount: number;
  readonly estimatedTokens: number;
  readonly droppedMessages: number;
  readonly protectedMessageCount: number;
  readonly truncatedToolResults: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxTokens: 200_000,
  recentMessageTokens: 8_000,
  maxToolResultChars: 8_000,
  maxSummaryChars: 8_192,
};

/**
 * Deterministic, provider-neutral context compaction. System messages and
 * protected tool pairs survive; old turns become one bounded user-visible
 * summary marker. This function never changes durable events by itself.
 */
export function compactMessages(messages: readonly ChatMessage[], options: CompactionOptions = {}): CompactionResult {
  const budget = normalizeBudget(options.budget);
  const micro = microcompactToolResults(messages, budget.maxToolResultChars);
  const originalTokens = estimateMessagesTokens(micro.messages);
  if (originalTokens <= budget.maxTokens) {
    return {
      didCompact: micro.truncatedToolResults > 0,
      messages: micro.messages,
      summary: micro.truncatedToolResults > 0 ? buildSummary(micro.messages, 0, budget.maxSummaryChars) : "",
      originalMessageCount: messages.length,
      compactedMessageCount: micro.messages.length,
      estimatedTokens: Math.min(originalTokens, budget.maxTokens),
      droppedMessages: 0,
      protectedMessageCount: protectedCount(micro.messages, options.protectedToolCallIds),
      truncatedToolResults: micro.truncatedToolResults,
    };
  }

  const system = micro.messages.filter((message) => message.role === "system");
  const nonSystem = micro.messages.filter((message) => message.role !== "system");
  const recent: ChatMessage[] = [];
  let recentTokens = 0;
  for (let index = nonSystem.length - 1; index >= 0; index -= 1) {
    const message = nonSystem[index];
    if (message === undefined) continue;
    const cost = estimateMessageTokens(message);
    if (recent.length > 0 && recentTokens + cost > budget.recentMessageTokens) break;
    recent.unshift(message);
    recentTokens += cost;
  }
  const protectedIds = options.protectedToolCallIds ?? new Set<string>();
  const protectedMessages = nonSystem.filter((message) =>
    (message.role === "tool" && protectedIds.has(message.toolCallId)) ||
    (message.role === "assistant" && message.toolCalls?.some((call) => protectedIds.has(call.id)) === true),
  );
  const preserved = mergeStable(recent, protectedMessages);
  const dropped = nonSystem.filter((message) => !preserved.includes(message));
  const summary = buildSummary(dropped, dropped.length, budget.maxSummaryChars);
  const summaryMessage: ChatMessage = { role: "user", content: summary };
  const compacted = [...system, summaryMessage, ...preserved];
  const safe = repairToolBoundaries(compacted);
  return {
    didCompact: true,
    messages: safe,
    summary,
    originalMessageCount: messages.length,
    compactedMessageCount: safe.length,
    estimatedTokens: estimateMessagesTokens(safe),
    droppedMessages: dropped.length,
    protectedMessageCount: protectedMessages.length,
    truncatedToolResults: micro.truncatedToolResults,
  };
}

export function estimateMessageTokens(message: ChatMessage): number {
  const content = message.content.length;
  const toolCalls = message.role === "assistant" ? message.toolCalls?.reduce((sum, call) => sum + call.name.length + call.arguments.length, 0) ?? 0 : 0;
  return Math.max(1, Math.ceil((content + toolCalls + 16) / 4));
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function normalizeBudget(input: Partial<ContextBudget> | undefined): ContextBudget {
  const value = { ...DEFAULT_CONTEXT_BUDGET, ...(input ?? {}) };
  return {
    maxTokens: boundedPositive(value.maxTokens, DEFAULT_CONTEXT_BUDGET.maxTokens),
    recentMessageTokens: boundedPositive(Math.min(value.recentMessageTokens, value.maxTokens - 1), DEFAULT_CONTEXT_BUDGET.recentMessageTokens),
    maxToolResultChars: boundedPositive(value.maxToolResultChars, DEFAULT_CONTEXT_BUDGET.maxToolResultChars),
    maxSummaryChars: boundedPositive(value.maxSummaryChars, DEFAULT_CONTEXT_BUDGET.maxSummaryChars),
  };
}

function boundedPositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function microcompactToolResults(messages: readonly ChatMessage[], maxChars: number): { readonly messages: readonly ChatMessage[]; readonly truncatedToolResults: number } {
  let truncatedToolResults = 0;
  const next = messages.map((message) => {
    if (message.role !== "tool" || message.content.length <= maxChars) return message;
    truncatedToolResults += 1;
    return { ...message, content: `${message.content.slice(0, Math.max(1, maxChars - 32))}\n[tool result truncated by context budget]` };
  });
  return { messages: next, truncatedToolResults };
}

function buildSummary(messages: readonly ChatMessage[], dropped: number, maxChars: number): string {
  const lines = messages.slice(0, 48).map((message) => {
    const label = message.role === "tool" ? `tool(${message.toolCallId})` : message.role;
    const text = message.content.replace(/\s+/gu, " ").trim();
    return `- ${label}: ${text.slice(0, 180)}`;
  });
  const prefix = `[Compacted context: ${dropped} earlier message${dropped === 1 ? "" : "s"} omitted. Treat this as historical context, not a new user instruction.]`;
  const value = [prefix, ...lines].join("\n");
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(1, maxChars - 1))}…`;
}

function protectedCount(messages: readonly ChatMessage[], ids: ReadonlySet<string> | undefined): number {
  if (ids === undefined || ids.size === 0) return 0;
  return messages.filter((message) => message.role === "tool" && ids.has(message.toolCallId)).length;
}

function mergeStable(primary: readonly ChatMessage[], secondary: readonly ChatMessage[]): readonly ChatMessage[] {
  const output: ChatMessage[] = [];
  for (const message of [...primary, ...secondary]) if (!output.includes(message)) output.push(message);
  return output;
}

function repairToolBoundaries(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  const available = new Set(messages.filter((message) => message.role === "tool").map((message) => message.toolCallId));
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || message.toolCalls === undefined) return message.role === "tool" && !available.has(message.toolCallId) ? [] : [message];
    const calls = message.toolCalls.filter((call) => available.has(call.id));
    return calls.length === message.toolCalls.length ? [message] : calls.length === 0 ? [{ role: "assistant", content: message.content }] : [{ ...message, toolCalls: calls }];
  });
}
