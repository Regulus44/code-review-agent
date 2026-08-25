import type { ChatMessage, ModelToolCall } from "@code-review-agent/contracts";

export type MessageNormalizationMode = "repair" | "strict";

export interface MessageNormalizationIssue {
  readonly code: "SYSTEM_MESSAGE_MOVED" | "ASSISTANT_STREAM_MERGED" | "TOOL_CALL_ID_REPAIRED" | "TOOL_CALL_DROPPED" | "TOOL_RESULT_DROPPED";
  readonly index: number;
  readonly detail?: string;
}

export interface MessageNormalizationReport {
  readonly mode: MessageNormalizationMode;
  readonly valid: boolean;
  readonly changed: boolean;
  readonly issues: readonly MessageNormalizationIssue[];
  readonly mergedAssistantMessages: number;
  readonly droppedToolCalls: number;
  readonly droppedToolResults: number;
}

export interface MessageNormalizationResult {
  readonly messages: readonly ChatMessage[];
  readonly report: MessageNormalizationReport;
}

/** Normalizes provider-neutral messages before pairing and model dispatch. */
export function normalizeMessagesForAPI(
  messages: readonly ChatMessage[],
  options: { readonly mode?: MessageNormalizationMode } = {},
): MessageNormalizationResult {
  const mode = options.mode ?? "repair";
  const issues: MessageNormalizationIssue[] = [];
  const normalized: ChatMessage[] = [];
  let mergedAssistantMessages = 0;
  let droppedToolCalls = 0;
  let droppedToolResults = 0;
  let changed = false;
  let systemMessages: ChatMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role === "system") {
      systemMessages.push(message);
      continue;
    }
    if (message.role === "assistant") {
      const calls: ModelToolCall[] = [];
      for (let callIndex = 0; callIndex < (message.toolCalls?.length ?? 0); callIndex += 1) {
        const call = message.toolCalls?.[callIndex];
        if (call === undefined) continue;
        const id = call.id.trim();
        const name = call.name.trim();
        if (name.length === 0) {
          issues.push({ code: "TOOL_CALL_DROPPED", index, detail: "tool name is empty" });
          droppedToolCalls += 1;
          changed = true;
          continue;
        }
        const repairedId = id.length > 0 ? id : `normalized_call_${index}_${callIndex}`;
        if (repairedId !== call.id) {
          issues.push({ code: "TOOL_CALL_ID_REPAIRED", index, detail: repairedId });
          changed = true;
        }
        const argumentsText = call.arguments.trim() === "" ? "{}" : call.arguments;
        calls.push({ id: repairedId, name, arguments: argumentsText });
      }
      const responseId = message.responseId?.trim();
      const next: ChatMessage = {
        role: "assistant",
        content: message.content,
        ...(calls.length === 0 ? {} : { toolCalls: calls }),
        ...(responseId === undefined || responseId.length === 0 ? {} : { responseId }),
      };
      const previous = normalized.at(-1);
      if (previous?.role === "assistant" && previous.responseId !== undefined && previous.responseId === next.responseId) {
        normalized[normalized.length - 1] = mergeAssistantMessages(previous, next);
        mergedAssistantMessages += 1;
        issues.push({ code: "ASSISTANT_STREAM_MERGED", index, detail: next.responseId });
        changed = true;
      } else {
        normalized.push(next);
      }
      continue;
    }
    if (message.role !== "tool") {
      normalized.push(message);
      continue;
    }
    const toolCallId = message.toolCallId.trim();
    if (toolCallId.length === 0) {
      issues.push({ code: "TOOL_RESULT_DROPPED", index, detail: "tool call id is empty" });
      droppedToolResults += 1;
      changed = true;
      continue;
    }
    normalized.push({ role: "tool", toolCallId, content: message.content });
  }

  if (systemMessages.length > 0) {
    if (messages.findIndex((message) => message?.role === "system") > 0) {
      issues.push({ code: "SYSTEM_MESSAGE_MOVED", index: 0, detail: "system messages moved to request prefix" });
      changed = true;
    }
    normalized.unshift(...systemMessages);
  }

  const report: MessageNormalizationReport = {
    mode,
    valid: issues.length === 0,
    changed,
    issues,
    mergedAssistantMessages,
    droppedToolCalls,
    droppedToolResults,
  };
  if (mode === "strict" && !report.valid) return { messages, report };
  return { messages: normalized, report };
}

function mergeAssistantMessages(left: Extract<ChatMessage, { role: "assistant" }>, right: Extract<ChatMessage, { role: "assistant" }>): Extract<ChatMessage, { role: "assistant" }> {
  const toolCalls = [...(left.toolCalls ?? []), ...(right.toolCalls ?? [])];
  return {
    role: "assistant",
    content: `${left.content}${right.content}`,
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
    ...(left.responseId === undefined ? {} : { responseId: left.responseId }),
  };
}
