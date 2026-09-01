import type { ModelStreamPart, ModelUsage } from "@coding-agent/contracts";
import { AnthropicMessagesError } from "./errors.js";
import type { AnthropicOpenBlock, AnthropicSseEvent } from "./types.js";

export class AnthropicStreamState {
  private readonly blocks = new Map<number, AnthropicOpenBlock>();
  private terminal = false;

  consume(event: AnthropicSseEvent): readonly ModelStreamPart[] {
    if (this.terminal) throw new AnthropicMessagesError("ANTHROPIC_STREAM_PROTOCOL_ERROR", "Received an event after message_stop");
    switch (event.event) {
      case "ping":
        return [];
      case "message_start":
        return usagePart(usageFrom(valueRecord(event.data["message"])?.["usage"]));
      case "content_block_start":
        return this.startBlock(event.data);
      case "content_block_delta":
        return this.deltaBlock(event.data);
      case "content_block_stop":
        return this.stopBlock(event.data);
      case "message_delta":
        return this.messageDelta(event.data);
      case "message_stop":
        if (this.blocks.size !== 0) throw new AnthropicMessagesError("ANTHROPIC_STREAM_PROTOCOL_ERROR", "message_stop arrived with open content blocks");
        this.terminal = true;
        return [{ type: "done" }];
      case "error":
        return [streamError(event.data)];
      default:
        return [];
    }
  }

  isTerminal(): boolean {
    return this.terminal;
  }

  private startBlock(data: Readonly<Record<string, unknown>>): readonly ModelStreamPart[] {
    const index = nonNegativeIndex(data["index"]);
    if (this.blocks.has(index)) throw new AnthropicMessagesError("ANTHROPIC_STREAM_PROTOCOL_ERROR", `Duplicate content block index ${index}`);
    const block = valueRecord(data["content_block"]);
    const type = block?.["type"];
    if (type === "text") {
      this.blocks.set(index, { kind: "text" });
      return [];
    }
    if (type === "tool_use") {
      const id = block?.["id"];
      const name = block?.["name"];
      if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) {
        throw new AnthropicMessagesError("ANTHROPIC_STREAM_PROTOCOL_ERROR", "tool_use block is missing id or name");
      }
      this.blocks.set(index, { kind: "tool", id, name });
      return [{ type: "tool_call_start", index, id, name }];
    }
    if (type === "thinking" || type === "redacted_thinking") {
      // Reasoning blocks are provider-internal for this adapter. Keep the
      // stream aligned while withholding thinking text/signatures from the
      // provider-neutral model event contract.
      this.blocks.set(index, { kind: "thinking" });
      return [];
    }
    throw new AnthropicMessagesError("ANTHROPIC_STREAM_PROTOCOL_ERROR", `Unsupported content block type: ${String(type)}`);
  }

  private deltaBlock(data: Readonly<Record<string, unknown>>): readonly ModelStreamPart[] {
    const index = nonNegativeIndex(data["index"]);
    const open = this.blocks.get(index);
    if (open === undefined) throw new AnthropicMessagesError("ANTHROPIC_STREAM_PROTOCOL_ERROR", `Delta for unopened content block ${index}`);
    const delta = valueRecord(data["delta"]);
    const type = delta?.["type"];
    if (open.kind === "text" && type === "text_delta") {
      const text = delta?.["text"];
      if (typeof text !== "string") throw new AnthropicMessagesError("ANTHROPIC_STREAM_PROTOCOL_ERROR", "text_delta is missing text");
      return text.length === 0 ? [] : [{ type: "text_delta", text }];
    }
    if (open.kind === "tool" && type === "input_json_delta") {
      const partial = delta?.["partial_json"];
      if (typeof partial !== "string") throw new AnthropicMessagesError("ANTHROPIC_STREAM_PROTOCOL_ERROR", "input_json_delta is missing partial_json");
      return partial.length === 0 ? [] : [{ type: "tool_call_delta", index, arguments: partial }];
    }
    if (open.kind === "thinking" && (type === "thinking_delta" || type === "signature_delta" || type === "text_delta")) return [];
    throw new AnthropicMessagesError("ANTHROPIC_STREAM_PROTOCOL_ERROR", `Unexpected ${String(type)} for ${open.kind} block`);
  }

  private stopBlock(data: Readonly<Record<string, unknown>>): readonly ModelStreamPart[] {
    const index = nonNegativeIndex(data["index"]);
    const open = this.blocks.get(index);
    if (open === undefined) throw new AnthropicMessagesError("ANTHROPIC_STREAM_PROTOCOL_ERROR", `Stop for unopened content block ${index}`);
    this.blocks.delete(index);
    return open.kind === "tool" ? [{ type: "tool_call_end", index }] : [];
  }

  private messageDelta(data: Readonly<Record<string, unknown>>): readonly ModelStreamPart[] {
    const delta = valueRecord(data["delta"]);
    const stopReason = delta?.["stop_reason"];
    if (stopReason === "max_tokens") {
      this.terminal = true;
      return [{ type: "error", code: "ANTHROPIC_MAX_TOKENS", message: "Anthropic Messages stopped because max_tokens was reached" }];
    }
    return usagePart(usageFrom(data["usage"]));
  }
}

export function parseSseFrames(buffer: string): { readonly frames: readonly AnthropicSseEvent[]; readonly remainder: string } {
  const normalized = buffer.replace(/\r\n/gu, "\n");
  const rawFrames = normalized.split("\n\n");
  const remainder = rawFrames.pop() ?? "";
  const frames = rawFrames.flatMap(parseSseFrame);
  return { frames, remainder };
}

function parseSseFrame(frame: string): readonly AnthropicSseEvent[] {
  const event = frame.split("\n").find((line) => line.startsWith("event:"))?.slice("event:".length).trim();
  const payload = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice("data:".length).trim()).join("\n");
  if (event === undefined || event.length === 0 || payload.length === 0) return [];
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    throw new AnthropicMessagesError("ANTHROPIC_STREAM_PROTOCOL_ERROR", "Anthropic stream emitted invalid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new AnthropicMessagesError("ANTHROPIC_STREAM_PROTOCOL_ERROR", "Anthropic stream event data must be an object");
  }
  return [{ event, data: data as Record<string, unknown> }];
}

function usageFrom(value: unknown): ModelUsage | undefined {
  const usage = valueRecord(value);
  if (usage === undefined) return undefined;
  const inputTokens = nonNegativeNumber(usage["input_tokens"]);
  const outputTokens = nonNegativeNumber(usage["output_tokens"]);
  const cacheReadTokens = nonNegativeNumber(usage["cache_read_input_tokens"]);
  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
  };
}

function usagePart(usage: ModelUsage | undefined): readonly ModelStreamPart[] {
  return usage === undefined ? [] : [{ type: "usage", usage }];
}

function streamError(data: Readonly<Record<string, unknown>>): Extract<ModelStreamPart, { readonly type: "error" }> {
  const error = valueRecord(data["error"]);
  const providerCode = typeof error?.["type"] === "string" ? error["type"] : undefined;
  const message = typeof error?.["message"] === "string" ? error["message"].slice(0, 300) : "Anthropic Messages stream returned an error";
  const status = typeof error?.["status"] === "number" && Number.isInteger(error["status"]) ? error["status"] : undefined;
  const failureCode = status === 429 ? "RATE_LIMIT" : status === 529 ? "OVERLOADED" : status === 413 ? "CONTEXT_WINDOW_EXCEEDED" : "PROVIDER_ERROR";
  return { type: "error", code: "ANTHROPIC_STREAM_ERROR", failureCode, retryable: status === 429 || status === 529 || (status !== undefined && status >= 500), message, ...(status === undefined ? {} : { status }), ...(providerCode === undefined ? {} : { providerCode }) };
}

function valueRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonNegativeIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AnthropicMessagesError("ANTHROPIC_STREAM_PROTOCOL_ERROR", "Anthropic stream event is missing a valid content block index");
  }
  return value;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
