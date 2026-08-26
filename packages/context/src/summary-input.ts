import type { ChatMessage } from "@code-review-agent/contracts";

export interface SummaryInputOptions {
  /** Removes attachments that the post-compact builder will re-inject. */
  readonly stripReinjectedAttachments?: boolean;
}

/**
 * Creates an immutable, provider-safe copy for the summary model. Summary
 * input deliberately does not share object identity with the live model view
 * or the durable transcript.
 */
export function buildSummaryInput(
  messages: readonly ChatMessage[],
  options: SummaryInputOptions = {},
): readonly ChatMessage[] {
  const filtered = options.stripReinjectedAttachments === false
    ? [...messages]
    : messages.filter((message) => !isReinjectedAttachment(message));
  return filtered.map((message) => {
    if (message.role === "system") return { role: "system", content: message.content };
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: replaceMediaMarkers(message.content),
        ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls.map((call) => ({ ...call })) }),
        ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
      };
    }
    if (message.role === "tool") {
      return { role: "tool", toolCallId: message.toolCallId, content: replaceMediaMarkers(message.content) };
    }
    return { role: "user", content: replaceMediaMarkers(message.content) };
  });
}

/**
 * A retry can remove the initial user round. Provider APIs generally reject
 * an assistant-first conversation, so insert a bounded marker instead of
 * mutating the original transcript.
 */
export function ensureSummaryStartsWithUser(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  const first = messages[0];
  if (first === undefined || first.role === "user" || first.role === "system") return messages;
  return [
    { role: "user", content: "[earlier conversation truncated for compaction retry]" },
    ...messages,
  ];
}

function isReinjectedAttachment(message: ChatMessage): boolean {
  if (message.role !== "user") return false;
  return /^<context-attachment\b[^>]*\bkind=(?:"skill"|'skill'|skill)(?:\s|>)/iu.test(message.content);
}

function replaceMediaMarkers(content: string): string {
  return content
    .replace(/<image(?:\s[^>]*)?>[\s\S]*?<\/image>/giu, "[image]")
    .replace(/<document(?:\s[^>]*)?>[\s\S]*?<\/document>/giu, "[document]")
    .replace(/\[(?:image|document)\s*:[^\]]*\]/giu, (value) => value.toLowerCase().startsWith("[image") ? "[image]" : "[document]");
}
