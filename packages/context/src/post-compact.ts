import type { ChatMessage } from "@code-review-agent/contracts";
import { annotateBoundaryWithPreservedSegment, type CompactBoundaryMessage, type CompactBoundaryOptions, createCompactBoundaryMessage } from "./boundary.js";
import {
  DEFAULT_POST_COMPACT_ATTACHMENT_CONFIG,
  renderContextAttachment,
  selectPostCompactAttachments,
  type PostCompactAttachmentConfig,
  type SelectedPostCompactAttachments,
} from "./attachments.js";
import type { ContextAttachment } from "./assembler.js";

export interface PostCompactRebuildInput {
  readonly boundary: CompactBoundaryOptions;
  readonly summaryMessages?: readonly ChatMessage[];
  readonly preservedMessages: readonly ChatMessage[];
  readonly attachments?: readonly ContextAttachment[];
  readonly hookResults?: readonly ContextAttachment[];
  readonly attachmentConfig?: Partial<PostCompactAttachmentConfig>;
}

export interface PostCompactRebuildResult {
  readonly messages: readonly ChatMessage[];
  readonly boundary: CompactBoundaryMessage;
  readonly attachments: readonly ContextAttachment[];
  readonly attachmentMetadata: SelectedPostCompactAttachments["metadata"];
  readonly droppedAttachmentIds: readonly string[];
  readonly attachmentTokens: number;
}

/**
 * Builds the Claude Code-style order: boundary → summary → preserved tail →
 * bounded attachments → hook results. All returned objects are fresh.
 */
export function buildPostCompactMessages(input: PostCompactRebuildInput): PostCompactRebuildResult {
  const summaryMessages = (input.summaryMessages ?? []).filter((message) => message.role !== "system").map(cloneMessage);
  const preservedMessages = input.preservedMessages.filter((message) => message.role !== "system").map(cloneMessage);
  const existingIds = new Set(
    [...summaryMessages, ...preservedMessages]
      .flatMap((message) => extractAttachmentIdsFromMessage(message))
      .filter((id): id is string => id !== undefined),
  );
  const selection = selectPostCompactAttachments(
    [...(input.attachments ?? []), ...(input.hookResults ?? [])],
    { ...DEFAULT_POST_COMPACT_ATTACHMENT_CONFIG, ...(input.attachmentConfig ?? {}) },
    existingIds,
  );
  const boundaryBase = createCompactBoundaryMessage(input.boundary);
  const boundary = annotateBoundaryWithPreservedSegment(
    boundaryBase,
    boundaryBase.messageId ?? boundaryBase.contextBoundary?.id ?? "boundary",
    preservedMessages,
    selection.attachments.map((attachment) => attachment.id),
  );
  const attachmentMessages = selection.attachments.map((attachment): ChatMessage => ({ role: "user", content: renderContextAttachment(attachment) }));
  return {
    messages: [boundary, ...summaryMessages, ...preservedMessages, ...attachmentMessages],
    boundary,
    attachments: selection.attachments,
    attachmentMetadata: selection.metadata,
    droppedAttachmentIds: selection.droppedAttachmentIds,
    attachmentTokens: selection.estimatedTokens,
  };
}

function cloneMessage(message: ChatMessage): ChatMessage {
  if (message.role === "assistant") return { ...message, ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls.map((call) => ({ ...call })) }) };
  return { ...message };
}

function extractAttachmentIdsFromMessage(message: ChatMessage): Array<string | undefined> {
  const match = /<context-attachment\b[^>]*\bid=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/iu.exec(message.content);
  return [match?.[1] ?? match?.[2] ?? match?.[3]];
}
