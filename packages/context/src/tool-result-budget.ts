import type { ChatMessage, ContextBudgetSnapshot, ToolResultReplacementRecord } from "@coding-agent/contracts";
import { containsNonTextContent, type ToolResultStorageOutcome } from "./tool-result-storage.js";

export const DEFAULT_MICROCOMPACT_MESSAGE = "[Old tool result content cleared]";
export const DEFAULT_MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;

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

export type ToolResultBudgetTrigger = "none" | "per-result" | "message" | "count" | "tokens" | "time";
export type MicrocompactTrigger = "none" | "count" | "tokens" | "time";
/** Pressure strategy used by the decoupled microcompact pass. */
export type MicrocompactStrategy = "none" | "pressure" | "time" | "legacy-count";

export interface ToolResultBudgetPolicy {
  readonly enabled?: boolean;
  /** Optional legacy maximum for one eligible result. Single-result overflow is handled by artifact storage. */
  readonly maxResultChars?: number;
  /** Optional per-tool override; an absent entry uses maxResultChars. */
  readonly perToolResultChars?: Readonly<Record<string, number>>;
  /** Old result count that activates count-based microcompact. */
  readonly microcompactTriggerToolCount?: number;
  /** Approximate model-visible token budget for compactable tool results. */
  readonly microcompactTriggerTokens?: number;
  /** Selects the decoupled microcompact trigger. Defaults to pressure for the new pass. */
  readonly microcompactTriggerMode?: "pressure" | "legacy-count" | "disabled";
  /** Fraction of the effective context window at which pressure microcompact starts. */
  readonly microcompactTriggerRatio?: number;
  /** Hysteresis retained below the pressure threshold after clearing. */
  readonly microcompactTargetHysteresisTokens?: number;
  /** Number of newest compactable results always retained. */
  readonly keepRecentResults?: number;
  /** Fraction of the pressure threshold allocated to the newest token tail. */
  readonly retainRecentResultsRatio?: number;
  /** Enables Claude Code-style age-based microcompact. Defaults to false. */
  readonly timeBasedMicrocompactEnabled?: boolean;
  /** Age of the oldest eligible result that activates time-based microcompact. */
  readonly timeBasedGapMs?: number;
  /** Maximum aggregate tool-result characters in one final API user message. */
  readonly maxToolResultsPerMessageChars?: number;
  readonly compactableTools?: readonly string[];
}

export interface ToolResultBudgetState {
  /** Tool results that have already been sent to the model and are now frozen. */
  readonly seenIds: Set<string>;
  /** Stable model-visible replacement text keyed by tool call ID. */
  readonly replacements: Map<string, string>;
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
  readonly messageBudgetChars: number;
  readonly messageBudgetMessagesOverBudget: number;
  readonly messageBudgetReplacedToolCallIds: readonly string[];
  readonly microcompactTrigger: MicrocompactTrigger;
  readonly timeBasedMicrocompactEnabled: boolean;
  readonly timeBasedGapMs: number;
  readonly microcompactStrategy?: MicrocompactStrategy;
  readonly pressureThreshold?: number;
  readonly pressureTargetTokens?: number;
  readonly pressureUsageTokens?: number;
  readonly requiredTokensToFree?: number;
  readonly eligibleToolResultCount?: number;
  /** Maximum token tail budget used by pressure microcompact. */
  readonly tailBudgetTokens?: number;
  /** Token estimate retained in eligible results after microcompact. */
  readonly retainedTailTokens?: number;
}

export interface ToolResultBudgetResult {
  readonly messages: readonly ChatMessage[];
  readonly report: ToolResultBudgetReport;
  /** New durable replacement receipts created by the async aggregate pass. */
  readonly newlyPersistedReplacements?: readonly ToolResultReplacementRecord[];
}

export interface ApplyToolResultBudgetOptions {
  readonly policy?: ToolResultBudgetPolicy;
  readonly protectedToolCallIds?: ReadonlySet<string>;
  readonly alreadyClearedToolCallIds?: ReadonlySet<string>;
  readonly toolResultTimestamps?: Readonly<Record<string, string>>;
  readonly nowMs?: number;
  readonly replacementState?: ToolResultBudgetState;
  /** Runtime-owned persistence callback used only by the async aggregate pass. */
  readonly persistToolResult?: (input: {
    readonly toolCallId: string;
    readonly toolName?: string;
    readonly content: string;
  }) => Promise<ToolResultStorageOutcome>;
  /** Internal pressure-pass floor for the newest token tail. */
  readonly microcompactTailBudgetTokens?: number;
}

export interface MicrocompactPressureEvaluation {
  readonly strategy: MicrocompactStrategy;
  readonly pressureThreshold: number;
  readonly currentUsageTokens: number;
  readonly targetUsageTokens: number;
  readonly requiredTokensToFree: number;
  readonly eligibleToolResultCount: number;
  readonly tailBudgetTokens: number;
}

export interface ApplyMicrocompactOptions extends ApplyToolResultBudgetOptions {
  readonly evaluation: MicrocompactPressureEvaluation;
}

interface NormalizedPolicy {
  readonly enabled: boolean;
  readonly maxResultChars?: number;
  readonly perToolResultChars?: Readonly<Record<string, number>>;
  readonly microcompactTriggerToolCount: number;
  readonly microcompactTriggerTokens: number;
  readonly microcompactTriggerMode: "pressure" | "legacy-count" | "disabled";
  readonly microcompactTriggerRatio: number;
  readonly microcompactTargetHysteresisTokens: number;
  readonly keepRecentResults: number;
  readonly retainRecentResultsRatio: number;
  readonly timeBasedMicrocompactEnabled: boolean;
  readonly timeBasedGapMs: number;
  readonly maxToolResultsPerMessageChars: number;
  readonly compactableTools: readonly string[];
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
  readonly alreadyReplaced: boolean;
}

interface AggregateCandidate {
  readonly messageIndex: number;
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly content: string;
  readonly size: number;
  readonly tokens: number;
  readonly protected: boolean;
  readonly nonText: boolean;
}

interface AggregateResult {
  readonly messages: readonly ChatMessage[];
  readonly overBudgetMessageCount: number;
  readonly replacedToolCallIds: readonly string[];
  readonly tokensSaved: number;
  readonly views: readonly ToolResultContextView[];
  readonly newlyPersistedReplacements: readonly ToolResultReplacementRecord[];
}

/** Creates stable per-turn aggregate replacement state. Initial transcript results are frozen. */
export function createToolResultBudgetState(messages: readonly ChatMessage[] = []): ToolResultBudgetState {
  const state: ToolResultBudgetState = { seenIds: new Set<string>(), replacements: new Map<string, string>() };
  for (const message of messages) {
    if (message.role === "tool") state.seenIds.add(message.toolCallId);
  }
  return state;
}

/** Hydrates persisted replacement views discovered after the state was created. */
export function hydrateToolResultBudgetState(state: ToolResultBudgetState, messages: readonly ChatMessage[]): void {
  for (const message of messages) {
    if (message.role !== "tool" || !message.content.startsWith("<persisted-tool-result")) continue;
    state.seenIds.add(message.toolCallId);
    if (!state.replacements.has(message.toolCallId)) state.replacements.set(message.toolCallId, message.content);
  }
}

/**
 * Applies legacy per-result bounds and count/token/time microcompact synchronously.
 * The input messages are never mutated and the full result remains available in the
 * durable transcript/event store. Runtime uses applyToolResultBudgetAsync so the
 * message-level aggregate pass can persist selected fresh results first.
 */
export function applyToolResultBudget(
  messages: readonly ChatMessage[],
  options: ApplyToolResultBudgetOptions = {},
): ToolResultBudgetResult {
  const policy = normalizePolicy(options.policy);
  if (!policy.enabled) return unchangedResult(messages, policy, options.protectedToolCallIds ?? new Set<string>());

  const protectedIds = options.protectedToolCallIds ?? new Set<string>();
  const toolNames = toolNamesByCallId(messages);
  const records = messages.flatMap((message, messageIndex): ToolResultRecord[] => {
    if (message.role !== "tool") return [];
    const toolName = toolNames.get(message.toolCallId);
    return [{
      messageIndex,
      toolCallId: message.toolCallId,
      ...(toolName === undefined ? {} : { toolName }),
      content: message.content,
      tokens: estimateToolResultTokens(message.content),
      compactable: toolName !== undefined && policy.compactableTools.includes(toolName),
      protected: protectedIds.has(message.toolCallId),
      alreadyCleared: (options.alreadyClearedToolCallIds?.has(message.toolCallId) ?? false) || message.content === DEFAULT_MICROCOMPACT_MESSAGE,
      alreadyReplaced: message.content.startsWith("<persisted-tool-result"),
    }];
  });

  const boundedIds = new Set<string>();
  const boundedContent = new Map<string, string>();
  const views = new Map<string, ToolResultContextView>();
  let boundedCount = 0;
  let tokensSaved = 0;
  for (const record of records) {
    const maxChars = resultLimit(record.toolName, policy);
    if (!record.compactable || record.protected || record.alreadyReplaced || maxChars === undefined || record.content.length <= maxChars || record.alreadyCleared) continue;
    const bounded = boundText(record.content, maxChars);
    boundedIds.add(record.toolCallId);
    boundedContent.set(record.toolCallId, bounded);
    boundedCount += 1;
    const saved = Math.max(0, record.tokens - estimateToolResultTokens(bounded));
    tokensSaved += saved;
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

  const eligible = records.filter((record) => record.compactable && !record.protected && !record.alreadyCleared && !record.alreadyReplaced);
  const microTrigger = microcompactTrigger(eligible, policy, options, boundedContent);
  const trigger: ToolResultBudgetTrigger = microTrigger === "none" && boundedIds.size > 0 ? "per-result" : microTrigger;
  const clearIds = new Set<string>();
  if (microTrigger !== "none") {
    const clearable = eligible.slice(0, Math.max(0, eligible.length - policy.keepRecentResults));
    if (microTrigger === "tokens") {
      let remaining = eligible.reduce((sum, record) => sum + effectiveTokens(record, boundedContent), 0);
      for (const record of clearable) {
        if (remaining <= policy.microcompactTriggerTokens) break;
        const nextRemaining = remaining - effectiveTokens(record, boundedContent);
        if (options.microcompactTailBudgetTokens !== undefined && nextRemaining < options.microcompactTailBudgetTokens) break;
        clearIds.add(record.toolCallId);
        remaining = nextRemaining;
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
        tokensSaved += Math.max(0, record.tokens - estimateToolResultTokens(DEFAULT_MICROCOMPACT_MESSAGE));
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
    return bounded === undefined ? message : { ...message, content: bounded };
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
      messageBudgetChars: policy.maxToolResultsPerMessageChars,
      messageBudgetMessagesOverBudget: 0,
      messageBudgetReplacedToolCallIds: [],
      microcompactTrigger: microTrigger,
      timeBasedMicrocompactEnabled: policy.timeBasedMicrocompactEnabled,
      timeBasedGapMs: policy.timeBasedGapMs,
    },
  };
}

/** Applies aggregate message budget asynchronously, then runs count/token/time microcompact. */
export async function applyToolResultBudgetAsync(
  messages: readonly ChatMessage[],
  options: ApplyToolResultBudgetOptions = {},
): Promise<ToolResultBudgetResult> {
  const policy = normalizePolicy(options.policy);
  if (!policy.enabled) return unchangedResult(messages, policy, options.protectedToolCallIds ?? new Set<string>());

  // First apply only legacy per-result bounds. Microcompact must run after the
  // aggregate replacement pass so its trigger sees the final model view.
  const preAggregate = applyToolResultBudget(messages, {
    ...options,
    policy: withoutMicrocompact(policy),
  });
  const state = options.replacementState ?? createToolResultBudgetState();
  hydrateToolResultBudgetState(state, preAggregate.messages);
  const aggregate = await enforceAggregateBudget(preAggregate.messages, state, policy, options);

  const final = applyToolResultBudget(aggregate.messages, options);
  const aggregateChanged = aggregate.replacedToolCallIds.length > 0;
  return {
    messages: final.messages,
    report: {
      ...final.report,
      changed: final.report.changed || aggregateChanged,
      trigger: aggregateChanged ? "message" : final.report.trigger,
      tokensSaved: final.report.tokensSaved + aggregate.tokensSaved,
      views: [...aggregate.views, ...final.report.views],
      messageBudgetChars: policy.maxToolResultsPerMessageChars,
      messageBudgetMessagesOverBudget: aggregate.overBudgetMessageCount,
      messageBudgetReplacedToolCallIds: aggregate.replacedToolCallIds,
      microcompactTrigger: final.report.microcompactTrigger,
      timeBasedMicrocompactEnabled: policy.timeBasedMicrocompactEnabled,
      timeBasedGapMs: policy.timeBasedGapMs,
    },
    newlyPersistedReplacements: aggregate.newlyPersistedReplacements,
  };
}

/**
 * Runs only the deterministic artifact/per-result and per-message aggregate passes.
 * No cleared marker is written. Runtime calls this before measuring the complete
 * request-scoped model view so microcompact cannot fire on local result counts.
 */
export async function applyToolResultArtifactAggregateAsync(
  messages: readonly ChatMessage[],
  options: ApplyToolResultBudgetOptions = {},
): Promise<ToolResultBudgetResult> {
  const policy = normalizePolicy(options.policy);
  if (!policy.enabled) return unchangedResult(messages, policy, options.protectedToolCallIds ?? new Set<string>());
  const preAggregate = applyToolResultBudget(messages, {
    ...options,
    policy: withoutMicrocompact(policy),
  });
  const state = options.replacementState ?? createToolResultBudgetState();
  hydrateToolResultBudgetState(state, preAggregate.messages);
  const aggregate = await enforceAggregateBudget(preAggregate.messages, state, policy, options);
  const changed = preAggregate.report.changed || aggregate.replacedToolCallIds.length > 0;
  return {
    messages: aggregate.messages,
    report: {
      ...preAggregate.report,
      changed,
      trigger: aggregate.replacedToolCallIds.length > 0 ? "message" : preAggregate.report.trigger,
      tokensSaved: preAggregate.report.tokensSaved + aggregate.tokensSaved,
      views: [...preAggregate.report.views, ...aggregate.views],
      messageBudgetChars: policy.maxToolResultsPerMessageChars,
      messageBudgetMessagesOverBudget: aggregate.overBudgetMessageCount,
      messageBudgetReplacedToolCallIds: aggregate.replacedToolCallIds,
      microcompactTrigger: "none",
      microcompactStrategy: "none",
    },
    newlyPersistedReplacements: aggregate.newlyPersistedReplacements,
  };
}

/** Evaluates pressure against the complete model-view token usage for one request. */
export function evaluateMicrocompactPressure(
  messages: readonly ChatMessage[],
  tokenUsageTokens: number,
  snapshot: ContextBudgetSnapshot,
  options: { readonly policy?: ToolResultBudgetPolicy; readonly protectedToolCallIds?: ReadonlySet<string>; readonly alreadyClearedToolCallIds?: ReadonlySet<string>; readonly toolResultTimestamps?: Readonly<Record<string, string>>; readonly nowMs?: number } = {},
): MicrocompactPressureEvaluation {
  const policy = normalizePolicy(options.policy);
  const triggerMode = options.policy?.microcompactTriggerMode ?? "pressure";
  const usage = Math.max(0, Number.isFinite(tokenUsageTokens) ? Math.floor(tokenUsageTokens) : 0);
  const pressureThreshold = Math.min(
    snapshot.autoCompactThreshold,
    Math.max(1, Math.floor(snapshot.effectiveWindowTokens * policy.microcompactTriggerRatio)),
  );
  const targetUsageTokens = Math.max(0, pressureThreshold - policy.microcompactTargetHysteresisTokens);
  const tailBudgetTokens = Math.max(0, Math.floor(pressureThreshold * policy.retainRecentResultsRatio));
  const eligibleToolResultCount = eligibleToolResultRecords(messages, policy, options.protectedToolCallIds, options.alreadyClearedToolCallIds).length;
  if (!policy.enabled || triggerMode === "disabled") {
    return { strategy: "none", pressureThreshold, currentUsageTokens: usage, targetUsageTokens, requiredTokensToFree: Math.max(0, usage - targetUsageTokens), eligibleToolResultCount, tailBudgetTokens };
  }
  if (triggerMode === "legacy-count") {
    const legacy = microcompactTrigger(eligibleToolResultRecords(messages, policy, options.protectedToolCallIds, options.alreadyClearedToolCallIds), policy, options, new Map());
    return { strategy: legacy === "time" ? "time" : legacy !== "none" ? "legacy-count" : "none", pressureThreshold, currentUsageTokens: usage, targetUsageTokens, requiredTokensToFree: Math.max(0, usage - targetUsageTokens), eligibleToolResultCount, tailBudgetTokens };
  }
  if (usage >= pressureThreshold && eligibleToolResultCount > policy.keepRecentResults) {
    return { strategy: "pressure", pressureThreshold, currentUsageTokens: usage, targetUsageTokens, requiredTokensToFree: Math.max(0, usage - targetUsageTokens), eligibleToolResultCount, tailBudgetTokens };
  }
  if (policy.timeBasedMicrocompactEnabled) {
    const timeRecords = eligibleToolResultRecords(messages, policy, options.protectedToolCallIds, options.alreadyClearedToolCallIds);
    const timePolicy: NormalizedPolicy = {
      ...policy,
      microcompactTriggerToolCount: Number.MAX_SAFE_INTEGER,
      microcompactTriggerTokens: Number.MAX_SAFE_INTEGER,
    };
    if (microcompactTrigger(timeRecords, timePolicy, options, new Map()) === "time") {
      return { strategy: "time", pressureThreshold, currentUsageTokens: usage, targetUsageTokens, requiredTokensToFree: 0, eligibleToolResultCount, tailBudgetTokens };
    }
  }
  return { strategy: "none", pressureThreshold, currentUsageTokens: usage, targetUsageTokens, requiredTokensToFree: Math.max(0, usage - targetUsageTokens), eligibleToolResultCount, tailBudgetTokens };
}

/** Applies only the microcompact pass using a previously evaluated strategy. */
export function applyMicrocompactPass(
  messages: readonly ChatMessage[],
  options: ApplyMicrocompactOptions,
): ToolResultBudgetResult {
  const policy = normalizePolicy(options.policy);
  if (options.evaluation.strategy === "none" || !policy.enabled) {
    return unchangedResult(messages, policy, options.protectedToolCallIds ?? new Set<string>());
  }
  const eligibleTokens = eligibleToolResultRecords(messages, policy, options.protectedToolCallIds, options.alreadyClearedToolCallIds)
    .reduce((sum, record) => sum + record.tokens, 0);
  // Once the current eligible tail is within its deterministic retention
  // budget, a repeated prepare/replay must not continue clearing one result
  // at a time merely because the minimum-count guard still allows it.
  if (options.evaluation.strategy === "pressure" && eligibleTokens <= options.evaluation.tailBudgetTokens) {
    return {
      ...unchangedResult(messages, policy, options.protectedToolCallIds ?? new Set<string>()),
      report: {
        ...unchangedResult(messages, policy, options.protectedToolCallIds ?? new Set<string>()).report,
        microcompactStrategy: options.evaluation.strategy,
        pressureThreshold: options.evaluation.pressureThreshold,
        pressureTargetTokens: options.evaluation.targetUsageTokens,
        pressureUsageTokens: options.evaluation.currentUsageTokens,
        requiredTokensToFree: options.evaluation.requiredTokensToFree,
        eligibleToolResultCount: options.evaluation.eligibleToolResultCount,
        tailBudgetTokens: options.evaluation.tailBudgetTokens,
        retainedTailTokens: eligibleTokens,
      },
    };
  }
  const triggerTokens = options.evaluation.strategy === "pressure"
    ? Math.max(0, eligibleTokens - options.evaluation.requiredTokensToFree)
    : options.evaluation.strategy === "legacy-count" ? policy.microcompactTriggerTokens : Number.MAX_SAFE_INTEGER;
  const result = applyToolResultBudget(messages, {
    ...options,
    policy: {
      ...policy,
      maxResultChars: Number.MAX_SAFE_INTEGER,
      perToolResultChars: {},
      microcompactTriggerMode: "legacy-count",
      microcompactTriggerToolCount: options.evaluation.strategy === "legacy-count" ? policy.microcompactTriggerToolCount : Number.MAX_SAFE_INTEGER,
      microcompactTriggerTokens: triggerTokens,
      timeBasedMicrocompactEnabled: options.evaluation.strategy === "time",
    },
    ...(options.evaluation.strategy === "pressure" ? { microcompactTailBudgetTokens: options.evaluation.tailBudgetTokens } : {}),
  });
  return {
    ...result,
    report: {
      ...result.report,
      microcompactStrategy: options.evaluation.strategy,
      pressureThreshold: options.evaluation.pressureThreshold,
      pressureTargetTokens: options.evaluation.targetUsageTokens,
      pressureUsageTokens: options.evaluation.currentUsageTokens,
      requiredTokensToFree: options.evaluation.requiredTokensToFree,
      eligibleToolResultCount: options.evaluation.eligibleToolResultCount,
      tailBudgetTokens: options.evaluation.tailBudgetTokens,
      retainedTailTokens: eligibleToolResultRecords(
        result.messages,
        policy,
        options.protectedToolCallIds,
        options.alreadyClearedToolCallIds,
      ).reduce((sum, record) => sum + record.tokens, 0),
    },
  };
}

async function enforceAggregateBudget(
  messages: readonly ChatMessage[],
  state: ToolResultBudgetState,
  policy: NormalizedPolicy,
  options: ApplyToolResultBudgetOptions,
): Promise<AggregateResult> {
  const protectedIds = options.protectedToolCallIds ?? new Set<string>();
  const toolNames = toolNamesByCallId(messages);
  const replacementMap = new Map<string, string>();
  const replacedToolCallIds: string[] = [];
  const newlyPersistedReplacements: ToolResultReplacementRecord[] = [];
  const views: ToolResultContextView[] = [];
  let overBudgetMessageCount = 0;
  let tokensSaved = 0;

  for (const group of aggregateGroups(messages, toolNames, protectedIds)) {
    const mustReapply = group.filter((candidate) => state.replacements.has(candidate.toolCallId));
    const frozen = group.filter((candidate) => !state.replacements.has(candidate.toolCallId) && state.seenIds.has(candidate.toolCallId));
    const fresh = group.filter((candidate) => !state.replacements.has(candidate.toolCallId) && !state.seenIds.has(candidate.toolCallId) && !candidate.protected && !candidate.nonText);
    const frozenSize = frozen.reduce((sum, candidate) => sum + candidate.size, 0) + group.filter((candidate) => candidate.protected || candidate.nonText).reduce((sum, candidate) => sum + candidate.size, 0);
    const reappliedSize = mustReapply.reduce((sum, candidate) => sum + (state.replacements.get(candidate.toolCallId)?.length ?? candidate.size), 0);
    let remaining = frozenSize + reappliedSize + fresh.reduce((sum, candidate) => sum + candidate.size, 0);
    if (remaining <= policy.maxToolResultsPerMessageChars) {
      for (const candidate of fresh) state.seenIds.add(candidate.toolCallId);
      continue;
    }
    overBudgetMessageCount += 1;
    const selected = [...fresh].sort((left, right) => right.size - left.size);
    const selectedIds = new Set<string>();
    for (const candidate of selected) {
      if (remaining <= policy.maxToolResultsPerMessageChars) break;
      selectedIds.add(candidate.toolCallId);
      state.seenIds.add(candidate.toolCallId);
      if (options.persistToolResult === undefined) continue;
      let outcome: ToolResultStorageOutcome;
      try {
        outcome = await options.persistToolResult({ toolCallId: candidate.toolCallId, ...(candidate.toolName === undefined ? {} : { toolName: candidate.toolName }), content: candidate.content });
      } catch {
        continue;
      }
      if (outcome.replacement === undefined || (outcome.status !== "persisted" && outcome.status !== "failed")) continue;
      const replacement = outcome.modelView;
      state.replacements.set(candidate.toolCallId, replacement);
      replacementMap.set(candidate.toolCallId, replacement);
      replacedToolCallIds.push(candidate.toolCallId);
      newlyPersistedReplacements.push(outcome.replacement);
      remaining -= Math.max(0, candidate.size - replacement.length);
      const savedTokens = Math.max(0, candidate.tokens - estimateToolResultTokens(replacement));
      tokensSaved += savedTokens;
      views.push({
        toolCallId: candidate.toolCallId,
        ...(candidate.toolName === undefined ? {} : { toolName: candidate.toolName }),
        originalMessageIndex: candidate.messageIndex,
        mode: "bounded",
        content: replacement,
        originalTokens: candidate.tokens,
        tokensSaved: savedTokens,
      });
    }
    for (const candidate of fresh) {
      if (!selectedIds.has(candidate.toolCallId)) state.seenIds.add(candidate.toolCallId);
    }
  }

  return {
    messages: replaceToolResultContents(messages, replacementMap),
    overBudgetMessageCount,
    replacedToolCallIds,
    tokensSaved,
    views,
    newlyPersistedReplacements,
  };
}

function aggregateGroups(
  messages: readonly ChatMessage[],
  toolNames: ReadonlyMap<string, string>,
  protectedIds: ReadonlySet<string>,
): AggregateCandidate[][] {
  const groups: AggregateCandidate[][] = [];
  let current: AggregateCandidate[] = [];
  const flush = (): void => {
    if (current.length > 0) groups.push(current);
    current = [];
  };
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (message === undefined) continue;
    if (message.role === "assistant") {
      flush();
      continue;
    }
    if (message.role !== "tool") continue;
    const toolName = toolNames.get(message.toolCallId);
    current.push({
      messageIndex,
      toolCallId: message.toolCallId,
      ...(toolName === undefined ? {} : { toolName }),
      content: message.content,
      size: message.content.length,
      tokens: estimateToolResultTokens(message.content),
      protected: protectedIds.has(message.toolCallId),
      nonText: containsNonTextContent(message.content) || message.content === DEFAULT_MICROCOMPACT_MESSAGE,
    });
  }
  flush();
  return groups;
}

function replaceToolResultContents(messages: readonly ChatMessage[], replacements: ReadonlyMap<string, string>): readonly ChatMessage[] {
  if (replacements.size === 0) return messages;
  return messages.map((message) => message.role === "tool" && replacements.has(message.toolCallId)
    ? { ...message, content: replacements.get(message.toolCallId) as string }
    : message);
}

function withoutMicrocompact(policy: NormalizedPolicy): ToolResultBudgetPolicy {
  return {
    enabled: policy.enabled,
    ...(policy.maxResultChars === undefined ? {} : { maxResultChars: policy.maxResultChars }),
    ...(policy.perToolResultChars === undefined ? {} : { perToolResultChars: policy.perToolResultChars }),
    microcompactTriggerToolCount: Number.MAX_SAFE_INTEGER,
    microcompactTriggerTokens: Number.MAX_SAFE_INTEGER,
    keepRecentResults: Number.MAX_SAFE_INTEGER,
    retainRecentResultsRatio: policy.retainRecentResultsRatio,
    timeBasedMicrocompactEnabled: false,
    timeBasedGapMs: policy.timeBasedGapMs,
    maxToolResultsPerMessageChars: policy.maxToolResultsPerMessageChars,
    compactableTools: policy.compactableTools,
  };
}

function normalizePolicy(policy: ToolResultBudgetPolicy | undefined): NormalizedPolicy {
  return {
    enabled: policy?.enabled !== false,
    ...(policy?.maxResultChars === undefined ? {} : { maxResultChars: positive(policy.maxResultChars, 8_000) }),
    ...(policy?.perToolResultChars === undefined ? {} : { perToolResultChars: policy.perToolResultChars }),
    microcompactTriggerToolCount: positive(policy?.microcompactTriggerToolCount, 10),
    microcompactTriggerTokens: positive(policy?.microcompactTriggerTokens, 20_000),
    microcompactTriggerMode: policy?.microcompactTriggerMode ?? "legacy-count",
    microcompactTriggerRatio: ratio(policy?.microcompactTriggerRatio, 0.8),
    microcompactTargetHysteresisTokens: nonNegative(policy?.microcompactTargetHysteresisTokens, 8_000),
    keepRecentResults: nonNegative(policy?.keepRecentResults, 5),
    retainRecentResultsRatio: ratio(policy?.retainRecentResultsRatio, 0.16),
    timeBasedMicrocompactEnabled: policy?.timeBasedMicrocompactEnabled === true,
    timeBasedGapMs: positive(policy?.timeBasedGapMs, 60 * 60_000),
    maxToolResultsPerMessageChars: positive(policy?.maxToolResultsPerMessageChars, DEFAULT_MAX_TOOL_RESULTS_PER_MESSAGE_CHARS),
    compactableTools: policy?.compactableTools ?? DEFAULT_COMPACTABLE_TOOLS,
  };
}

function eligibleToolResultRecords(
  messages: readonly ChatMessage[],
  policy: NormalizedPolicy,
  protectedToolCallIds: ReadonlySet<string> = new Set<string>(),
  alreadyClearedToolCallIds: ReadonlySet<string> = new Set<string>(),
): ToolResultRecord[] {
  const toolNames = toolNamesByCallId(messages);
  return messages.flatMap((message, messageIndex): ToolResultRecord[] => {
    if (message.role !== "tool") return [];
    const toolName = toolNames.get(message.toolCallId);
    const record: ToolResultRecord = {
      messageIndex,
      toolCallId: message.toolCallId,
      ...(toolName === undefined ? {} : { toolName }),
      content: message.content,
      tokens: estimateToolResultTokens(message.content),
      compactable: toolName !== undefined && policy.compactableTools.includes(toolName),
      protected: protectedToolCallIds.has(message.toolCallId),
      alreadyCleared: alreadyClearedToolCallIds.has(message.toolCallId) || message.content === DEFAULT_MICROCOMPACT_MESSAGE,
      alreadyReplaced: message.content.startsWith("<persisted-tool-result"),
    };
    return record.compactable && !record.protected && !record.alreadyCleared && !record.alreadyReplaced ? [record] : [];
  });
}

function resultLimit(toolName: string | undefined, policy: NormalizedPolicy): number | undefined {
  const value = toolName === undefined ? policy.maxResultChars : policy.perToolResultChars?.[toolName] ?? policy.maxResultChars;
  return value !== undefined && value > 0 ? Math.floor(value) : undefined;
}

function microcompactTrigger(
  records: readonly ToolResultRecord[],
  policy: NormalizedPolicy,
  options: ApplyToolResultBudgetOptions,
  boundedContent: ReadonlyMap<string, string>,
): MicrocompactTrigger {
  if (records.length <= policy.keepRecentResults) return "none";
  const totalTokens = records.reduce((sum, record) => sum + effectiveTokens(record, boundedContent), 0);
  if (records.length >= policy.microcompactTriggerToolCount) return "count";
  if (totalTokens > policy.microcompactTriggerTokens) return "tokens";
  if (!policy.timeBasedMicrocompactEnabled) return "none";
  const oldest = records
    .map((record) => options.toolResultTimestamps?.[record.toolCallId])
    .filter((value): value is string => value !== undefined && Number.isFinite(Date.parse(value)))
    .map((value) => Date.parse(value))
    .sort((left, right) => left - right)[0];
  if (oldest !== undefined && (options.nowMs ?? Date.now()) - oldest >= policy.timeBasedGapMs) return "time";
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

function ratio(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

function unchangedResult(messages: readonly ChatMessage[], policy: NormalizedPolicy, protectedIds: ReadonlySet<string>): ToolResultBudgetResult {
  return {
    messages,
    report: {
      enabled: policy.enabled,
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
      messageBudgetChars: policy.maxToolResultsPerMessageChars,
      messageBudgetMessagesOverBudget: 0,
      messageBudgetReplacedToolCallIds: [],
      microcompactTrigger: "none",
      timeBasedMicrocompactEnabled: policy.timeBasedMicrocompactEnabled,
      timeBasedGapMs: policy.timeBasedGapMs,
      eligibleToolResultCount: 0,
    },
    newlyPersistedReplacements: [],
  };
}
