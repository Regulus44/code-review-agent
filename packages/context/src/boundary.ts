import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ContextBoundaryKind,
  ContextBoundaryMetadata,
  ContextBoundaryTrigger,
  ContextPreservedSegment,
} from "@code-review-agent/contracts";

export interface CompactBoundaryOptions {
  readonly id?: string;
  readonly kind: ContextBoundaryKind;
  readonly trigger: ContextBoundaryTrigger;
  readonly preCompactTokens: number;
  readonly sourceSequence: number;
  readonly lastPreCompactMessageId?: string;
  readonly messagesSummarized?: number;
  readonly preCompactDiscoveredTools?: readonly string[];
  readonly attachmentIds?: readonly string[];
  readonly tokensSaved?: number;
  readonly compactedToolIds?: readonly string[];
  readonly clearedAttachmentIds?: readonly string[];
  readonly createdAt?: string;
  readonly algorithmVersion?: string;
}

export type CompactBoundaryMessage = Extract<ChatMessage, { role: "system" }> & {
  readonly contextBoundary: ContextBoundaryMetadata;
};

/** Creates a provider-visible system marker with durable compact metadata. */
export function createCompactBoundaryMessage(options: CompactBoundaryOptions): CompactBoundaryMessage {
  const metadata: ContextBoundaryMetadata = {
    version: 1,
    id: options.id ?? `boundary_${randomUUID()}`,
    kind: options.kind,
    trigger: options.trigger,
    preCompactTokens: finiteNonNegative(options.preCompactTokens),
    sourceSequence: finiteNonNegative(options.sourceSequence),
    ...(options.lastPreCompactMessageId === undefined ? {} : { lastPreCompactMessageId: options.lastPreCompactMessageId }),
    ...(options.messagesSummarized === undefined ? {} : { messagesSummarized: finiteNonNegative(options.messagesSummarized) }),
    ...(options.preCompactDiscoveredTools === undefined ? {} : { preCompactDiscoveredTools: [...new Set(options.preCompactDiscoveredTools)].sort() }),
    ...(options.attachmentIds === undefined ? {} : { attachmentIds: [...new Set(options.attachmentIds)].sort() }),
    ...(options.tokensSaved === undefined ? {} : { tokensSaved: finiteNonNegative(options.tokensSaved) }),
    ...(options.compactedToolIds === undefined ? {} : { compactedToolIds: [...new Set(options.compactedToolIds)].sort() }),
    ...(options.clearedAttachmentIds === undefined ? {} : { clearedAttachmentIds: [...new Set(options.clearedAttachmentIds)].sort() }),
    createdAt: options.createdAt ?? new Date().toISOString(),
    ...(options.algorithmVersion === undefined ? {} : { algorithmVersion: options.algorithmVersion }),
  };
  return {
    role: "system",
    content: options.kind === "micro" ? "Context microcompacted" : "Conversation compacted",
    messageId: metadata.id,
    contextBoundary: metadata,
  };
}

export function createMicrocompactBoundaryMessage(
  preCompactTokens: number,
  tokensSaved: number,
  compactedToolIds: readonly string[],
  sourceSequence = 0,
): ChatMessage {
  return createCompactBoundaryMessage({
    kind: "micro",
    trigger: "auto",
    preCompactTokens,
    sourceSequence,
    tokensSaved,
    compactedToolIds,
  });
}

export function isCompactBoundaryMessage(message: ChatMessage | undefined): message is CompactBoundaryMessage {
  return message?.role === "system" && message.contextBoundary?.version === 1;
}

export function findLastCompactBoundaryIndex(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isCompactBoundaryMessage(messages[index])) return index;
  }
  return -1;
}

/** Returns the current model-visible segment without changing the transcript. */
export function getMessagesAfterCompactBoundary(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  const index = findLastCompactBoundaryIndex(messages);
  return index < 0 ? [...messages] : messages.slice(index);
}

export function annotateBoundaryWithPreservedSegment(
  boundary: CompactBoundaryMessage,
  anchorMessageId: string,
  messagesToKeep: readonly ChatMessage[],
  attachmentIds: readonly string[] = [],
): CompactBoundaryMessage {
  if (!isCompactBoundaryMessage(boundary) || messagesToKeep.length === 0) return boundary;
  const headMessageId = messagesToKeep[0]?.messageId;
  const tailMessageId = messagesToKeep.at(-1)?.messageId;
  const preservedSegment: ContextPreservedSegment = {
    ...(headMessageId === undefined ? {} : { headMessageId }),
    anchorMessageId,
    ...(tailMessageId === undefined ? {} : { tailMessageId }),
  };
  return {
    ...boundary,
    contextBoundary: {
      ...boundary.contextBoundary,
      preservedSegment,
      ...(attachmentIds.length === 0 ? {} : { attachmentIds: [...new Set(attachmentIds)].sort() }),
    },
  };
}

export function boundaryFromMetadata(metadata: ContextBoundaryMetadata): CompactBoundaryMessage {
  return {
    role: "system",
    content: metadata.kind === "micro" ? "Context microcompacted" : "Conversation compacted",
    messageId: metadata.id,
    contextBoundary: { ...metadata },
  };
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
