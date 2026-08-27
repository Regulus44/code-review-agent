import type { ModelContextCapability, ModelRequest, ModelToolDefinition, ModelUsage } from "@code-review-agent/contracts";

export interface AnthropicMessagesOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxOutputTokens?: number;
  readonly apiVersion?: string;
  readonly idleTimeoutMs?: number;
  readonly contextCapability?: ModelContextCapability;
  readonly fetch?: typeof globalThis.fetch;
}

export interface AnthropicTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface AnthropicToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

export interface AnthropicWireMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly AnthropicContentBlock[];
}

export interface AnthropicToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: ModelToolDefinition["parameters"];
}

export interface AnthropicWireRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly stream: true;
  readonly messages: readonly AnthropicWireMessage[];
  readonly system?: string;
  readonly tools?: readonly AnthropicToolDefinition[];
  readonly tool_choice?: { readonly type: "any" } | { readonly type: "tool"; readonly name: string };
}

export interface AnthropicSseEvent {
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface AnthropicOpenTextBlock {
  readonly kind: "text";
}

export interface AnthropicOpenToolBlock {
  readonly kind: "tool";
  readonly id: string;
  readonly name: string;
}

export interface AnthropicOpenThinkingBlock {
  readonly kind: "thinking";
}

export type AnthropicOpenBlock = AnthropicOpenTextBlock | AnthropicOpenToolBlock | AnthropicOpenThinkingBlock;

export type AnthropicUsage = ModelUsage;
