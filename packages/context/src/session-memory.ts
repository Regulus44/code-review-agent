import type { ChatMessage } from "@coding-agent/contracts";
import { estimateContextTokens } from "./estimator.js";

export interface SessionMemoryExtractionConfig {
  readonly minimumMessageTokensToInit: number;
  readonly minimumTokensBetweenUpdate: number;
  readonly toolCallsBetweenUpdates: number;
  readonly extractionWaitTimeoutMs: number;
  readonly extractionStaleThresholdMs: number;
  readonly maxMemoryChars: number;
}

export const DEFAULT_SESSION_MEMORY_EXTRACTION_CONFIG: SessionMemoryExtractionConfig = {
  minimumMessageTokensToInit: 10_000,
  minimumTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
  extractionWaitTimeoutMs: 15_000,
  extractionStaleThresholdMs: 60_000,
  maxMemoryChars: 24_000,
};

export type SessionMemoryExtractionTrigger = "initialization" | "threshold" | "natural_break";
export type SessionMemoryExtractionStatus = "idle" | "queued" | "running" | "completed" | "failed" | "cancelled";

export interface SessionMemoryExtractionState {
  readonly status: SessionMemoryExtractionStatus;
  readonly initialized: boolean;
  readonly lastExtractedMessageId?: string;
  readonly lastExtractedTokens: number;
  readonly sourceSequence?: number;
  readonly sourceMessageId?: string;
  readonly trigger?: SessionMemoryExtractionTrigger;
  readonly toolCallsSinceLastExtraction: number;
  readonly extractorSessionId?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface SessionMemoryContextStats {
  readonly estimatedTokens: number;
  readonly lastMessageId?: string;
  readonly lastAssistantToolCalls: number;
  readonly toolCallsSinceLastExtraction: number;
}

export interface SessionMemoryExtractionDecision {
  readonly shouldExtract: boolean;
  readonly trigger?: SessionMemoryExtractionTrigger;
  readonly initialized: boolean;
  readonly tokenGrowth: number;
  readonly toolCallsSinceLastExtraction: number;
  readonly reason: "below_initialization_threshold" | "below_update_threshold" | "tool_and_natural_break_missing" | "in_flight" | "thresholds_met";
}

export interface SessionMemoryFileWriteGuard {
  readonly allowedPath: string;
  assertWritable(path: string): void;
}

export function createSessionMemoryFileWriteGuard(allowedPath: string): SessionMemoryFileWriteGuard {
  const normalized = normalizePath(allowedPath);
  if (normalized.length === 0) throw new Error("SESSION_MEMORY_PATH_REQUIRED");
  return {
    allowedPath,
    assertWritable(path: string): void {
      if (normalizePath(path) !== normalized) throw new Error("SESSION_MEMORY_WRITE_PATH_DENIED");
    },
  };
}

export interface SessionMemoryExtractionRequest {
  readonly sessionId: string;
  readonly sourceSequence: number;
  readonly sourceMessageId?: string;
  readonly messages: readonly ChatMessage[];
  readonly currentMemory?: SessionMemorySnapshotLike;
  readonly trigger: SessionMemoryExtractionTrigger;
  readonly estimatedTokens: number;
  readonly toolCallsSinceLastExtraction: number;
  readonly signal: AbortSignal;
  readonly memoryPath?: string;
  readonly memoryFileGuard?: SessionMemoryFileWriteGuard;
  /** Restricted fork capability: no parent tools, workspace writes, or execution. */
  readonly capabilities: SessionMemoryExtractionCapabilities;
}

export interface SessionMemoryExtractionCapabilities {
  readonly canReadSessionMemory: true;
  readonly canWriteSessionMemory: true;
  readonly canUseParentTools: false;
  readonly canWriteWorkspace: false;
  readonly canExecute: false;
}

export interface SessionMemorySnapshotLike {
  readonly content: string;
  readonly lastSummarizedMessageId?: string;
  readonly updatedAt?: string;
  readonly etag?: string;
}

export interface SessionMemoryExtractionResult {
  readonly snapshot?: SessionMemorySnapshotLike;
  readonly tokensAtExtraction?: number;
  readonly lastSummarizedMessageId?: string;
}

export interface SessionMemoryExtractor {
  extract(request: SessionMemoryExtractionRequest): Promise<SessionMemoryExtractionResult>;
}

export function sessionMemoryStats(
  messages: readonly ChatMessage[],
  lastExtractedMessageId?: string,
): SessionMemoryContextStats {
  const estimatedTokens = estimateContextTokens({ messages }).value;
  const lastMessageId = [...messages].reverse().find((message) => message.messageId !== undefined)?.messageId;
  const start = lastExtractedMessageId === undefined
    ? 0
    : Math.max(-1, messages.findIndex((message) => message.messageId === lastExtractedMessageId));
  let toolCallsSinceLastExtraction = 0;
  for (let index = start + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "assistant") toolCallsSinceLastExtraction += message.toolCalls?.length ?? 0;
  }
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  return {
    estimatedTokens,
    ...(lastMessageId === undefined ? {} : { lastMessageId }),
    lastAssistantToolCalls: lastAssistant?.role === "assistant" ? lastAssistant.toolCalls?.length ?? 0 : 0,
    toolCallsSinceLastExtraction,
  };
}

export function shouldExtractSessionMemory(
  state: Pick<SessionMemoryExtractionState, "initialized" | "lastExtractedTokens" | "status" | "lastExtractedMessageId">,
  stats: SessionMemoryContextStats,
  config: Partial<SessionMemoryExtractionConfig> = {},
): SessionMemoryExtractionDecision {
  const resolved = normalizeExtractionConfig(config);
  if (state.status === "queued" || state.status === "running") {
    return { shouldExtract: false, initialized: state.initialized, tokenGrowth: Math.max(0, stats.estimatedTokens - state.lastExtractedTokens), toolCallsSinceLastExtraction: stats.toolCallsSinceLastExtraction, reason: "in_flight" };
  }
  const initialized = state.initialized || stats.estimatedTokens >= resolved.minimumMessageTokensToInit;
  if (!initialized) return { shouldExtract: false, initialized, tokenGrowth: stats.estimatedTokens, toolCallsSinceLastExtraction: stats.toolCallsSinceLastExtraction, reason: "below_initialization_threshold" };
  const tokenGrowth = Math.max(0, stats.estimatedTokens - state.lastExtractedTokens);
  const enoughTokens = tokenGrowth >= resolved.minimumTokensBetweenUpdate;
  if (!enoughTokens) return { shouldExtract: false, initialized, tokenGrowth, toolCallsSinceLastExtraction: stats.toolCallsSinceLastExtraction, reason: "below_update_threshold" };
  const enoughTools = stats.toolCallsSinceLastExtraction >= resolved.toolCallsBetweenUpdates;
  const naturalBreak = stats.lastAssistantToolCalls === 0;
  if (!enoughTools && !naturalBreak) return { shouldExtract: false, initialized, tokenGrowth, toolCallsSinceLastExtraction: stats.toolCallsSinceLastExtraction, reason: "tool_and_natural_break_missing" };
  const trigger: SessionMemoryExtractionTrigger = !state.initialized ? "initialization" : naturalBreak && !enoughTools ? "natural_break" : "threshold";
  return { shouldExtract: true, trigger, initialized, tokenGrowth, toolCallsSinceLastExtraction: stats.toolCallsSinceLastExtraction, reason: "thresholds_met" };
}

export function markExtractionStarted(
  state: SessionMemoryExtractionState,
  input: { readonly sourceSequence: number; readonly sourceMessageId?: string; readonly trigger: SessionMemoryExtractionTrigger; readonly estimatedTokens: number; readonly toolCallsSinceLastExtraction: number; readonly extractorSessionId: string; readonly startedAt: string },
): SessionMemoryExtractionState {
  const { completedAt: _completedAt, error: _error, ...withoutTerminalState } = state;
  return { ...withoutTerminalState, status: "running", initialized: true, sourceSequence: input.sourceSequence, ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }), trigger: input.trigger, lastExtractedTokens: state.lastExtractedTokens, toolCallsSinceLastExtraction: input.toolCallsSinceLastExtraction, extractorSessionId: input.extractorSessionId, startedAt: input.startedAt };
}

export function markExtractionCompleted(
  state: SessionMemoryExtractionState,
  input: { readonly lastExtractedMessageId?: string; readonly tokensAtExtraction: number; readonly completedAt: string },
): SessionMemoryExtractionState {
  const { error: _error, ...withoutError } = state;
  return { ...withoutError, status: "completed", initialized: true, ...(input.lastExtractedMessageId === undefined ? {} : { lastExtractedMessageId: input.lastExtractedMessageId }), lastExtractedTokens: Math.max(0, Math.floor(input.tokensAtExtraction)), completedAt: input.completedAt };
}

export function markExtractionFailed(state: SessionMemoryExtractionState, error: string): SessionMemoryExtractionState {
  return { ...state, status: "failed", error: error.slice(0, 500) };
}

export function markExtractionCancelled(state: SessionMemoryExtractionState): SessionMemoryExtractionState {
  return { ...state, status: "cancelled" };
}

export class SessionMemoryExtractionScheduler {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, Set<AbortController>>();

  enqueue<T>(sessionId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const controllers = this.controllers.get(sessionId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.controllers.set(sessionId, controllers);
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => task(controller.signal));
    const settled = run.then(() => undefined, () => undefined).finally(() => {
      const current = this.controllers.get(sessionId);
      current?.delete(controller);
      if (current !== undefined && current.size === 0) this.controllers.delete(sessionId);
      if (this.tails.get(sessionId) === settled) this.tails.delete(sessionId);
    });
    this.tails.set(sessionId, settled);
    return run;
  }

  cancel(sessionId: string, reason = "Session memory extraction cancelled"): boolean {
    const controllers = this.controllers.get(sessionId);
    if (controllers === undefined || controllers.size === 0) return false;
    for (const controller of controllers) controller.abort(new Error(reason));
    return true;
  }

  async wait(sessionId: string, timeoutMs = DEFAULT_SESSION_MEMORY_EXTRACTION_CONFIG.extractionWaitTimeoutMs): Promise<void> {
    const pending = this.tails.get(sessionId);
    if (pending === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pending, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("SESSION_MEMORY_EXTRACTION_WAIT_TIMEOUT")), timeoutMs); })]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export function normalizeExtractionConfig(input: Partial<SessionMemoryExtractionConfig> = {}): SessionMemoryExtractionConfig {
  const value = { ...DEFAULT_SESSION_MEMORY_EXTRACTION_CONFIG, ...input };
  return {
    minimumMessageTokensToInit: positive(value.minimumMessageTokensToInit, 10_000),
    minimumTokensBetweenUpdate: positive(value.minimumTokensBetweenUpdate, 5_000),
    toolCallsBetweenUpdates: positive(value.toolCallsBetweenUpdates, 3),
    extractionWaitTimeoutMs: positive(value.extractionWaitTimeoutMs, 15_000),
    extractionStaleThresholdMs: positive(value.extractionStaleThresholdMs, 60_000),
    maxMemoryChars: positive(value.maxMemoryChars, 24_000),
  };
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}
