import type { ChatMessage } from "@code-review-agent/contracts";

export const DEFAULT_MICROCOMPACT_MESSAGE = "[Old tool result content cleared]";

export const DEFAULT_COMPACTABLE_TOOLS: readonly string[] = [
  "read_file",
  "bash",
  "pwsh",
  "grep",
  "glob",
  "web_search",
  "web_fetch",
  "edit_file",
  "write_file",
];

export type ToolResultBudgetTrigger = "none" | "per-result" | "count" | "tokens" | "time";

export interface ToolResultBudgetPolicy {
  readonly enabled?: boolean;
  /** Optional legacy maximum for one eligible result. Single-result overflow is handled by artifact storage. */
  readonly maxResultChars?: number;
  /** Optional per-tool override; an absent entry uses maxResultChars. */
  readonly perToolResultChars?: Readonly<Record<string, number>>;
  /** Old result count that activates age/count based microcompact. */
  readonly microcompactTriggerToolCount?: number;
  /** Approximate model-visible token budget for compactable tool results. */
  readonly microcompactTriggerTokens?: number;
  /** Number of newest compactable results always retained. */
  readonly keepRecentResults?: number;
  /** Age of the oldest eligible result that activates time-based microcompact. */
  readonly timeBasedGapMs?: number;
  readonly compactableTools?: readonly string[];
}

export interface ToolResultContextView {
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly originalMessageIndex: number;
  readonly mode: "full" | "bounded" | "cleared";
  readonly content: string;
  readonly originalTokens: number;
  readonly tokensSaved: number;
}

export interface ToolResultBudgetReport {
  readonly enabled: boolean;
  readonly changed: boolean;
  readonly trigger: ToolResultBudgetTrigger;
  readonly boundedCount: number;
  readonly clearedCount: number;
  readonly tokensSaved: number;
  readonly boundedToolCallIds: readonly string[];
  readonly clearedToolCallIds: readonly string[];
  readonly newlyClearedToolCallIds: readonly string[];
  readonly protectedToolCallIds: readonly string[];
  readonly views: readonly ToolResultContextView[];
}

export interface ToolResultBudgetResult {
  readonly messages: readonly ChatMessage[];
  readonly report: ToolResultBudgetReport;
}

export interface ApplyToolResultBudgetOptions {
  readonly policy?: ToolResultBudgetPolicy;
  readonly protectedToolCallIds?: ReadonlySet<string>;
  readonly alreadyClearedToolCallIds?: ReadonlySet<string>;
  readonly toolResultTimestamps?: Readonly<Record<string, string>>;
  readonly nowMs?: number;
}

interface ToolResultRecord {
  readonly messageIndex: number;
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly content: string;
  readonly tokens: number;
  readonly compactable: boolean;
  readonly protected: boolean;
  readonly alreadyCleared: boolean;
}

/**
 * Applies non-destructive per-result bounds and microcompact to a model view.
 * The input messages are never mutated and the full result remains available
 * in the durable transcript/event store.
 */
export function applyToolResultBudget(
  messages: readonly ChatMessage[],
  options: ApplyToolResultBudgetOptions = {},
): ToolResultBudgetResult {
  const policy = normalizePolicy(options.policy);
  const protectedIds = options.protectedToolCallIds ?? new Set<string>();
  const alreadyCleared = options.alreadyClearedToolCallIds ?? new Set<string>();
  if (policy.enabled === false) return unchangedResult(messages, false, protectedIds);

  const toolNames = toolNamesByCallId(messages);
  const compactableTools = new Set(policy.compactableTools ?? DEFAULT_COMPACTABLE_TOOLS);
  const records = messages.flatMap((message, messageIndex): ToolResultRecord[] => {
    if (message.role !== "tool") return [];
    const toolCallId = message.toolCallId;
    const toolName = toolNames.get(toolCallId);
    return [{
      messageIndex,
      toolCallId,
      ...(toolName === undefined ? {} : { toolName }),
      content: message.content,
      tokens: estimateToolResultTokens(message.content),
      compactable: toolName !== undefined && compactableTools.has(toolName),
      protected: protectedIds.has(toolCallId),
      alreadyCleared: alreadyCleared.has(toolCallId) || message.content === DEFAULT_MICROCOMPACT_MESSAGE,
    }];
  });

  const boundedIds = new Set<string>();
  const boundedContent = new Map<string, string>();
  const views = new Map<string, ToolResultContextView>();
  let boundedCount = 0;
  let tokensSaved = 0;
  for (const record of records) {
    const maxChars = resultLimit(record.toolName, policy);
    if (!record.compactable || record.protected || maxChars === undefined || record.content.length <= maxChars || record.alreadyCleared) continue;
    const bounded = boundText(record.content, maxChars);
    boundedIds.add(record.toolCallId);
    boundedContent.set(record.toolCallId, bounded);
    boundedCount += 1;
    const saved = Math.max(0, record.tokens - estimateToolResultTokens(bounded));
    views.set(record.toolCallId, {
      toolCallId: record.toolCallId,
      ...(record.toolName === undefined ? {} : { toolName: record.toolName }),
      originalMessageIndex: record.messageIndex,
      mode: "bounded",
      content: bounded,
      originalTokens: record.tokens,
      tokensSaved: saved,
    });
  }

  const eligible = records.filter((record) => record.compactable && !record.protected && !record.alreadyCleared);
  const microTrigger = microcompactTrigger(eligible, policy, options, boundedContent);
  const trigger: ToolResultBudgetTrigger = microTrigger === "none" && boundedIds.size > 0 ? "per-result" : microTrigger;
  const clearIds = new Set<string>();
  if (microTrigger !== "none") {
    const keepRecent = Math.max(0, policy.keepRecentResults ?? 5);
    const clearable = eligible.slice(0, Math.max(0, eligible.length - keepRecent));
    if (microTrigger === "tokens") {
      let remaining = eligible.reduce((sum, record) => sum + effectiveTokens(record, boundedContent), 0);
      const limit = policy.microcompactTriggerTokens ?? Number.POSITIVE_INFINITY;
      for (const record of clearable) {
        if (remaining <= limit) break;
        clearIds.add(record.toolCallId);
        remaining -= effectiveTokens(record, boundedContent);
      }
    } else {
      for (const record of clearable) clearIds.add(record.toolCallId);
    }
  }

  let clearedCount = 0;
  const clearedIds: string[] = [];
  const newlyClearedIds: string[] = [];
  const nextMessages = messages.map((message, messageIndex): ChatMessage => {
    if (message.role !== "tool") return message;
    const record = records.find((candidate) => candidate.toolCallId === message.toolCallId && candidate.messageIndex === messageIndex);
    if (record === undefined) return message;
    if (record.alreadyCleared || clearIds.has(record.toolCallId)) {
      const newlyCleared = !record.alreadyCleared;
      if (newlyCleared) {
        clearedCount += 1;
        newlyClearedIds.push(record.toolCallId);
      }
      clearedIds.push(record.toolCallId);
      views.set(record.toolCallId, {
        toolCallId: record.toolCallId,
        ...(record.toolName === undefined ? {} : { toolName: record.toolName }),
        originalMessageIndex: record.messageIndex,
        mode: "cleared",
        content: DEFAULT_MICROCOMPACT_MESSAGE,
        originalTokens: record.tokens,
        tokensSaved: newlyCleared ? Math.max(0, record.tokens - estimateToolResultTokens(DEFAULT_MICROCOMPACT_MESSAGE)) : 0,
      });
      return { ...message, content: DEFAULT_MICROCOMPACT_MESSAGE };
    }
    const bounded = boundedContent.get(record.toolCallId);
    if (bounded === undefined) return message;
    const saved = Math.max(0, record.tokens - estimateToolResultTokens(bounded));
    tokensSaved += saved;
    return { ...message, content: bounded };
  });

  const finalBoundedIds = [...boundedIds].filter((toolCallId) => !clearIds.has(toolCallId));

  return {
    messages: nextMessages,
    report: {
      enabled: true,
      changed: boundedCount > 0 || clearedCount > 0,
      trigger,
      boundedCount: finalBoundedIds.length,
      clearedCount,
      tokensSaved,
      boundedToolCallIds: finalBoundedIds,
      clearedToolCallIds: clearedIds,
      newlyClearedToolCallIds: newlyClearedIds,
      protectedToolCallIds: [...protectedIds],
      views: [...views.values()],
    },
  };
}

function normalizePolicy(policy: ToolResultBudgetPolicy | undefined): Pick<ToolResultBudgetPolicy, "enabled" | "maxResultChars" | "microcompactTriggerToolCount" | "microcompactTriggerTokens" | "keepRecentResults" | "timeBasedGapMs"> & Required<Pick<ToolResultBudgetPolicy, "enabled" | "microcompactTriggerToolCount" | "microcompactTriggerTokens" | "keepRecentResults" | "timeBasedGapMs">> & Pick<ToolResultBudgetPolicy, "perToolResultChars" | "compactableTools"> {
  return {
    enabled: policy?.enabled !== false,
    ...(policy?.maxResultChars === undefined ? {} : { maxResultChars: positive(policy.maxResultChars, 8_000) }),
    microcompactTriggerToolCount: positive(policy?.microcompactTriggerToolCount, 10),
    microcompactTriggerTokens: positive(policy?.microcompactTriggerTokens, 20_000),
    keepRecentResults: nonNegative(policy?.keepRecentResults, 5),
    timeBasedGapMs: positive(policy?.timeBasedGapMs, 30 * 60_000),
    ...(policy?.perToolResultChars === undefined ? {} : { perToolResultChars: policy.perToolResultChars }),
    ...(policy?.compactableTools === undefined ? {} : { compactableTools: policy.compactableTools }),
  };
}

function resultLimit(toolName: string | undefined, policy: ReturnType<typeof normalizePolicy>): number | undefined {
  const value = toolName === undefined ? policy.maxResultChars : policy.perToolResultChars?.[toolName] ?? policy.maxResultChars;
  return value !== undefined && value > 0 ? Math.floor(value) : undefined;
}

function microcompactTrigger(
  records: readonly ToolResultRecord[],
  policy: ReturnType<typeof normalizePolicy>,
  options: ApplyToolResultBudgetOptions,
  boundedContent: ReadonlyMap<string, string>,
): ToolResultBudgetTrigger {
  if (records.length <= policy.keepRecentResults) return "none";
  const totalTokens = records.reduce((sum, record) => sum + effectiveTokens(record, boundedContent), 0);
  if (records.length >= policy.microcompactTriggerToolCount) return "count";
  if (totalTokens > policy.microcompactTriggerTokens) return "tokens";
  const timestamp = records
    .map((record) => options.toolResultTimestamps?.[record.toolCallId])
    .find((value) => value !== undefined && Number.isFinite(Date.parse(value)));
  if (timestamp !== undefined && (options.nowMs ?? Date.now()) - Date.parse(timestamp) >= policy.timeBasedGapMs) return "time";
  return "none";
}

function effectiveTokens(record: ToolResultRecord, boundedContent: ReadonlyMap<string, string>): number {
  return estimateToolResultTokens(boundedContent.get(record.toolCallId) ?? record.content);
}

function toolNamesByCallId(messages: readonly ChatMessage[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  }
  return names;
}

function boundText(content: string, maxChars: number): string {
  const marker = "\n[tool result bounded by context budget]";
  if (content.length <= maxChars) return content;
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  return `${content.slice(0, Math.max(1, maxChars - marker.length))}${marker}`;
}

function estimateToolResultTokens(content: string): number {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) {
      const media = parsed.filter((item) => typeof item === "object" && item !== null && ((item as { type?: unknown }).type === "image" || (item as { type?: unknown }).type === "document")).length;
      if (media > 0) return media * 2_000 + Math.max(1, Math.ceil(content.length / 4));
    }
  } catch {
    // Plain text and non-JSON tool views use the conservative text estimate.
  }
  return Math.max(1, Math.ceil((content.length + 16) / 4));
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function unchangedResult(messages: readonly ChatMessage[], enabled: boolean, protectedIds: ReadonlySet<string>): ToolResultBudgetResult {
  return {
    messages,
    report: {
      enabled,
      changed: false,
      trigger: "none",
      boundedCount: 0,
      clearedCount: 0,
      tokensSaved: 0,
      boundedToolCallIds: [],
      clearedToolCallIds: [],
      newlyClearedToolCallIds: [],
      protectedToolCallIds: [...protectedIds],
      views: [],
    },
  };
}
