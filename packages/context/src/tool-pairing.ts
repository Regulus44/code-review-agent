import type { ChatMessage, ModelToolCall } from "@code-review-agent/contracts";

export type ToolPairingMode = "repair" | "strict";

export type ToolPairingIssueCode =
  | "DUPLICATE_TOOL_CALL_ID"
  | "DUPLICATE_TOOL_RESULT"
  | "MISSING_TOOL_RESULT"
  | "ORPHAN_TOOL_RESULT"
  | "TOOL_RESULT_OUTSIDE_ASSISTANT_ROUND";

export interface ToolPairingIssue {
  readonly code: ToolPairingIssueCode;
  readonly toolCallId: string;
  readonly messageIndex: number;
}

export interface ToolPairingReport {
  readonly mode: ToolPairingMode;
  readonly valid: boolean;
  readonly repaired: boolean;
  readonly issues: readonly ToolPairingIssue[];
  readonly syntheticResultCount: number;
  readonly removedOrphanResultCount: number;
  readonly removedDuplicateCallCount: number;
}

export interface ToolPairingResult {
  readonly messages: readonly ChatMessage[];
  readonly report: ToolPairingReport;
}

/** Ensures every assistant tool call has one following result and no orphan result survives. */
export function ensureToolResultPairing(
  messages: readonly ChatMessage[],
  options: { readonly mode?: ToolPairingMode } = {},
): ToolPairingResult {
  const mode = options.mode ?? "repair";
  const issues: ToolPairingIssue[] = [];
  const output: ChatMessage[] = [];
  const seenCallIds = new Set<string>();
  let syntheticResultCount = 0;
  let removedOrphanResultCount = 0;
  let removedDuplicateCallCount = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role !== "assistant") {
      if (message.role === "tool") {
        const issue: ToolPairingIssue = { code: "TOOL_RESULT_OUTSIDE_ASSISTANT_ROUND", toolCallId: message.toolCallId, messageIndex: index };
        issues.push(issue);
        if (mode === "repair") {
          removedOrphanResultCount += 1;
          continue;
        }
      }
      output.push(message.role === "system" ? { role: "system", content: message.content } : { role: "user", content: message.content });
      continue;
    }

    const uniqueCalls: ModelToolCall[] = [];
    for (const call of message.toolCalls ?? []) {
      if (seenCallIds.has(call.id)) {
        issues.push({ code: "DUPLICATE_TOOL_CALL_ID", toolCallId: call.id, messageIndex: index });
        if (mode === "repair") {
          removedDuplicateCallCount += 1;
          continue;
        }
      }
      seenCallIds.add(call.id);
      uniqueCalls.push(call);
    }
    const assistant: ChatMessage = {
      role: "assistant",
      content: message.content,
      ...(uniqueCalls.length === 0 ? {} : { toolCalls: uniqueCalls }),
      ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
    };
    output.push(assistant);
    if (uniqueCalls.length === 0) continue;

    const expected = new Set(uniqueCalls.map((call) => call.id));
    const results = new Map<string, ChatMessage>();
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]?.role === "tool") {
      const result = messages[cursor];
      if (result?.role !== "tool") break;
      if (!expected.has(result.toolCallId)) {
        issues.push({ code: "ORPHAN_TOOL_RESULT", toolCallId: result.toolCallId, messageIndex: cursor });
        if (mode === "repair") {
          removedOrphanResultCount += 1;
          cursor += 1;
          continue;
        }
        output.push(result);
        cursor += 1;
        continue;
      }
      if (results.has(result.toolCallId)) {
        issues.push({ code: "DUPLICATE_TOOL_RESULT", toolCallId: result.toolCallId, messageIndex: cursor });
        if (mode === "repair") {
          cursor += 1;
          continue;
        }
      }
      results.set(result.toolCallId, result);
      cursor += 1;
    }
    for (const call of uniqueCalls) {
      const result = results.get(call.id);
      if (result !== undefined) {
        output.push(result);
        continue;
      }
      issues.push({ code: "MISSING_TOOL_RESULT", toolCallId: call.id, messageIndex: index });
      if (mode === "repair") {
        syntheticResultCount += 1;
        output.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ ok: false, error: { code: "MISSING_TOOL_RESULT", message: "The tool result was missing from the model-visible history." } }) });
      }
    }
    index = cursor - 1;
  }

  const report: ToolPairingReport = {
    mode,
    valid: issues.length === 0,
    repaired: mode === "repair" && issues.length > 0,
    issues,
    syntheticResultCount,
    removedOrphanResultCount,
    removedDuplicateCallCount,
  };
  if (mode === "strict" && !report.valid) return { messages, report };
  return { messages: output, report };
}
