import type { ChatMessage, ModelRequest, ModelToolDefinition } from "@code-review-agent/contracts";
import { AnthropicMessagesError } from "./errors.js";
import type { AnthropicContentBlock, AnthropicToolDefinition, AnthropicWireMessage, AnthropicWireRequest } from "./types.js";

export function serializeAnthropicRequest(request: ModelRequest, model: string, maxOutputTokens: number): AnthropicWireRequest {
  const { system, messages } = serializeMessages(request.messages);
  const tools = request.toolChoice === "none" ? undefined : request.tools?.map(toAnthropicTool);
  const toolChoice = request.toolChoice === "required"
    ? { type: "any" as const }
    : typeof request.toolChoice === "object"
      ? { type: "tool" as const, name: request.toolChoice.name }
      : undefined;
  return {
    model,
    max_tokens: maxOutputTokens,
    stream: true,
    messages,
    ...(system.length === 0 ? {} : { system }),
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
}

function serializeMessages(messages: readonly ChatMessage[]): { readonly system: string; readonly messages: readonly AnthropicWireMessage[] } {
  const system: string[] = [];
  const wire: AnthropicWireMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    const role = message.role === "assistant" ? "assistant" as const : "user" as const;
    const blocks = contentBlocksFor(message);
    if (blocks.length === 0) continue;
    const previous = wire.at(-1);
    if (previous?.role === role) {
      wire[wire.length - 1] = { role, content: [...previous.content, ...blocks] };
    } else {
      wire.push({ role, content: blocks });
    }
  }
  if (wire.length === 0) throw new AnthropicMessagesError("ANTHROPIC_MESSAGE_EMPTY", "Anthropic Messages requires at least one non-system message");
  return { system: system.join("\n\n"), messages: wire };
}

function contentBlocksFor(message: Exclude<ChatMessage, { readonly role: "system" }>): readonly AnthropicContentBlock[] {
  if (message.role === "tool") {
    return [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }];
  }
  if (message.role === "user") return [{ type: "text", text: message.content }];
  const blocks: AnthropicContentBlock[] = [];
  if (message.content.length > 0) blocks.push({ type: "text", text: message.content });
  for (const call of message.toolCalls ?? []) {
    let input: unknown;
    try {
      input = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments) as unknown;
    } catch {
      throw new AnthropicMessagesError("ANTHROPIC_TOOL_ARGUMENTS_INVALID", `Tool ${call.name} has invalid JSON arguments`);
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new AnthropicMessagesError("ANTHROPIC_TOOL_ARGUMENTS_INVALID", `Tool ${call.name} arguments must be a JSON object`);
    }
    blocks.push({ type: "tool_use", id: call.id, name: call.name, input: input as Record<string, unknown> });
  }
  return blocks;
}

function toAnthropicTool(tool: ModelToolDefinition): AnthropicToolDefinition {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}
