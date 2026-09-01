import type {
  ContextBudgetConfig,
  ContextBudgetSnapshot,
  ContextWarningState,
  ModelContextCapability,
} from "@coding-agent/contracts";

export {
  assembleContext,
} from "./assembler.js";
export { groupMessagesByApiRound } from "./api-round.js";
export { normalizeMessagesForAPI } from "./api-normalize.js";
export { ensureToolResultPairing } from "./tool-pairing.js";
export {
  applyToolResultBudget,
  applyToolResultBudgetAsync,
  createToolResultBudgetState,
  hydrateToolResultBudgetState,
  DEFAULT_COMPACTABLE_TOOLS,
  DEFAULT_MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  DEFAULT_MICROCOMPACT_MESSAGE,
} from "./tool-result-budget.js";
export {
  buildToolResultModelView,
  containsNonTextContent,
  createToolResultStorage,
  estimateToolResultTokens,
  truncateUtf8,
  DEFAULT_TOOL_RESULT_MAX_TOKENS,
  DEFAULT_TOOL_RESULT_PERSIST_THRESHOLD_CHARS,
  DEFAULT_TOOL_RESULT_PREVIEW_BYTES,
  TOOL_RESULT_ARTIFACTS_ROOT,
} from "./tool-result-storage.js";
export { adjustIndexToPreserveAPIInvariants, calculateMessagesToKeepIndex, compactWithSessionMemory, DEFAULT_SESSION_MEMORY_COMPACT_CONFIG } from "./session-memory-compact.js";
export {
  createSessionMemoryFileWriteGuard,
  markExtractionCancelled,
  markExtractionCompleted,
  markExtractionFailed,
  markExtractionStarted,
  normalizeExtractionConfig,
  sessionMemoryStats,
  shouldExtractSessionMemory,
  SessionMemoryExtractionScheduler,
  DEFAULT_SESSION_MEMORY_EXTRACTION_CONFIG,
} from "./session-memory.js";
export {
  FileSessionMemoryStore,
  createDefaultSessionMemoryExtractor,
  DEFAULT_SESSION_MEMORY_FILE_MAX_BYTES,
  DEFAULT_SESSION_MEMORY_FILE_MAX_CHARS,
  SESSION_MEMORY_FILE_VERSION,
} from "./session-memory-file.js";
export { buildSummaryInput, ensureSummaryStartsWithUser } from "./summary-input.js";
export { compactWithSummaryModel, truncateHeadForPtlRetry, DEFAULT_SUMMARY_COMPACT_CONFIG } from "./summary-compact.js";
export {
  annotateBoundaryWithPreservedSegment,
  boundaryFromMetadata,
  createCompactBoundaryMessage,
  createMicrocompactBoundaryMessage,
  findLastCompactBoundaryIndex,
  getMessagesAfterCompactBoundary,
  isCompactBoundaryMessage,
} from "./boundary.js";
export {
  DEFAULT_POST_COMPACT_ATTACHMENT_CONFIG,
  extractContextAttachmentIds,
  renderContextAttachment,
  selectPostCompactAttachments,
} from "./attachments.js";
export { buildPostCompactMessages } from "./post-compact.js";
export { restoreModelViewFromTranscript } from "./transcript-replay.js";
export {
  buildProjectMemoryPrompt,
  parseProjectMemoryIndex,
  recallRelevantProjectMemory,
  selectProjectMemoryHeaders,
  truncateProjectMemoryEntrypoint,
  validateProjectMemoryTopic,
  PROJECT_MEMORY_ENTRYPOINT_NAME,
  PROJECT_MEMORY_MAX_ENTRYPOINT_BYTES,
  PROJECT_MEMORY_MAX_ENTRYPOINT_LINES,
  PROJECT_MEMORY_MAX_RECALLED_TOPICS,
  PROJECT_MEMORY_TYPES,
} from "./project-memory.js";
export { FileProjectMemoryStore, ProjectMemoryWriterPolicy, DEFAULT_PROJECT_MEMORY_MAX_TOPIC_BYTES, DEFAULT_PROJECT_MEMORY_MAX_TOPICS, PROJECT_MEMORY_FILE_VERSION } from "./project-memory-fs.js";
export {
  classifyProviderContextError,
  fingerprintModelRequest,
  isReactiveContextError,
  ContextRecoveryGuard,
} from "./recovery.js";
export type { ProviderContextError, RecoveryGuardSnapshot } from "./recovery.js";
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
  ApiRound,
} from "./api-round.js";
export type {
  MessageNormalizationIssue,
  MessageNormalizationMode,
  MessageNormalizationReport,
  MessageNormalizationResult,
} from "./api-normalize.js";
export type {
  ToolPairingIssue,
  ToolPairingIssueCode,
  ToolPairingMode,
  ToolPairingReport,
  ToolPairingResult,
} from "./tool-pairing.js";
export type {
  ApplyToolResultBudgetOptions,
  MicrocompactTrigger,
  ToolResultBudgetPolicy,
  ToolResultBudgetReport,
  ToolResultBudgetResult,
  ToolResultBudgetTrigger,
  ToolResultBudgetState,
  ToolResultContextView,
} from "./tool-result-budget.js";
export type {
  ToolResultStorage,
  ToolResultStorageConfig,
  ToolResultStorageInput,
  ToolResultStorageOutcome,
  ToolResultStorageStatus,
  ToolResultStorageWriter,
} from "./tool-result-storage.js";
export type {
  SessionMemoryCompactConfig,
  SessionMemoryCompactOptions,
  SessionMemoryCompactReason,
  SessionMemoryCompactResult,
  SessionMemoryStore,
  SessionMemorySnapshot,
} from "./session-memory-compact.js";
export type {
  SessionMemoryContextStats,
  SessionMemoryExtractionCapabilities,
  SessionMemoryExtractionConfig,
  SessionMemoryExtractionDecision,
  SessionMemoryExtractionRequest,
  SessionMemoryExtractionResult,
  SessionMemoryExtractionState,
  SessionMemoryExtractionStatus,
  SessionMemoryExtractionTrigger,
  SessionMemoryExtractor,
  SessionMemoryFileWriteGuard,
  SessionMemorySnapshotLike,
} from "./session-memory.js";
export type {
  SummaryInputOptions,
} from "./summary-input.js";
export type {
  SummaryCompactConfig,
  SummaryCompactOptions,
  SummaryCompactReason,
  SummaryCompactResult,
  SummaryRequest,
  SummaryResponse,
  SummaryRunner,
} from "./summary-compact.js";
export type { CompactBoundaryMessage, CompactBoundaryOptions } from "./boundary.js";
export type {
  PostCompactAttachmentConfig,
  PostCompactAttachmentInput,
  PostCompactAttachmentProvider,
  SelectedPostCompactAttachments,
} from "./attachments.js";
export type { PostCompactRebuildInput, PostCompactRebuildResult } from "./post-compact.js";
export type { TranscriptRestoreInput, TranscriptRestoreResult } from "./transcript-replay.js";
export type {
  ProjectMemoryEntrypoint,
  ProjectMemoryEntrypointResult,
  ProjectMemoryIndexEntry,
  ProjectMemoryReference,
  ProjectMemoryRecallOptions,
  ProjectMemoryRecallResult,
  ProjectMemoryScope,
  ProjectMemoryStore,
  ProjectMemoryTopic,
  ProjectMemoryTopicHeader,
  ProjectMemoryType,
  ProjectMemoryTopicInput,
  ProjectMemoryValidation,
} from "./project-memory.js";

export type {
  ContextBudgetConfig,
  ContextBudgetSnapshot,
  ContextWarningState,
  ModelContextCapability,
} from "@coding-agent/contracts";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
export const DEFAULT_MAX_OUTPUT_REQUEST_TOKENS = 32_000;
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
    defaultMaxOutputTokens: Math.min(
      nonNegativeInteger(config.defaultMaxOutputTokens, DEFAULT_MAX_OUTPUT_REQUEST_TOKENS),
      nonNegativeInteger(config.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
    ),
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
  const resolvedMaxOutputTokens = nonNegativeInteger(config.maxOutputTokens, positiveOrZero(capability.maxOutputTokens));
  const reservedOutputTokens = Math.min(
    resolvedMaxOutputTokens,
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
  const source = config.contextWindowTokens !== undefined || config.maxOutputTokens !== undefined || config.defaultMaxOutputTokens !== undefined
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
