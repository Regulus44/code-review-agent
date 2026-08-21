import type { ChatMessage, ChatModel, ModelRequest, ModelStreamPart, ModelToolCall } from "@code-review-agent/contracts";

export interface OpenAICompatibleOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Injectable for contract tests; production uses the platform Fetch API. */
  readonly fetch?: typeof globalThis.fetch;
}

export type ConfiguredModelProvider = "echo" | "deepseek";

export const DEEPSEEK_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
] as const;

export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number];
export const DEFAULT_DEEPSEEK_MODEL: DeepSeekModel = "deepseek-v4-flash";

/** Safe model metadata intended for health checks and diagnostics. It never contains credentials. */
export interface ModelConfigView {
  readonly provider: ConfiguredModelProvider;
  readonly model: string;
  readonly baseUrl?: string;
  readonly configured: boolean;
}

export interface ConfiguredChatModel {
  readonly model: ChatModel;
  readonly config: ModelConfigView;
}

export class ModelConfigurationError extends Error {
  readonly code = "MODEL_CONFIGURATION_ERROR";
}

/** Deterministic model used by local smoke tests and development without an API key. */
export class EchoChatModel implements ChatModel {
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
    const last = [...request.messages].reverse().find((message) => message.role === "user");
    const text = last === undefined ? "I did not receive a user message." : `Echo: ${last.content}`;
    for (const word of text.split(/(\s+)/u).filter(Boolean)) {
      if (request.signal?.aborted) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      yield { type: "text_delta", text: word };
    }
    yield { type: "done" };
  }
}

/** Minimal OpenAI-compatible SSE adapter; provider-specific policy stays outside AgentHost. */
export class OpenAICompatibleChatModel implements ChatModel {
  constructor(private readonly options: OpenAICompatibleOptions) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
    const url = `${this.options.baseUrl.replace(/\/$/u, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(this.options.headers ?? {}),
    };
    if (this.options.apiKey !== undefined) {
      headers.authorization = `Bearer ${this.options.apiKey}`;
    }
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error("Fetch API is unavailable in this runtime");
    }
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.options.model,
        messages: request.messages.map(toWireMessage),
        stream: true,
        ...(request.tools === undefined ? {} : {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }),
        ...(request.toolChoice === undefined ? {} : {
          tool_choice: typeof request.toolChoice === "string"
            ? request.toolChoice
            : { type: "function", function: { name: request.toolChoice.name } },
        }),
      }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    if (!response.ok) {
      throw new Error(`LLM request failed with HTTP ${response.status}`);
    }
    if (response.body === null) {
      throw new Error("LLM response did not contain a body");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const openToolIndices = new Set<number>();
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseSseLine(line);
        for (const part of partsForParsedSse(parsed, openToolIndices)) yield part;
        if (parsed?.kind === "done") return;
      }
      if (chunk.done) {
        const parsed = parseSseLine(buffer);
        for (const part of partsForParsedSse(parsed, openToolIndices)) yield part;
        if (parsed?.kind === "done") return;
        break;
      }
    }
    for (const index of openToolIndices) yield { type: "tool_call_end", index };
    yield { type: "done" };
  }
}

/**
 * Selects the local model without ever returning the API key to callers.
 * `auto` uses DeepSeek only when a non-empty key is present; otherwise it is deterministic Echo.
 */
export function createConfiguredChatModel(env: NodeJS.ProcessEnv = process.env): ConfiguredChatModel {
  const requested = (env["MODEL_PROVIDER"]?.trim().toLowerCase() || "auto");
  if (requested !== "auto" && requested !== "echo" && requested !== "deepseek") {
    throw new ModelConfigurationError("MODEL_PROVIDER must be one of auto, echo, or deepseek");
  }

  const apiKey = env["DEEPSEEK_API_KEY"]?.trim();
  const provider: ConfiguredModelProvider = requested === "auto" ? (apiKey === undefined || apiKey.length === 0 ? "echo" : "deepseek") : requested;
  if (provider === "deepseek" && (apiKey === undefined || apiKey.length === 0)) {
    throw new ModelConfigurationError("MODEL_PROVIDER=deepseek requires DEEPSEEK_API_KEY");
  }
  if (provider === "echo") {
    return {
      model: new EchoChatModel(),
      config: { provider: "echo", model: "echo", configured: false },
    };
  }

  const baseUrl = env["DEEPSEEK_BASE_URL"]?.trim() || "https://api.deepseek.com";
  validateHttpUrl(baseUrl, "DEEPSEEK_BASE_URL");
  const safeBaseUrl = publicBaseUrl(baseUrl);
  const model = env["DEEPSEEK_MODEL"]?.trim() || DEFAULT_DEEPSEEK_MODEL;
  return {
    model: new OpenAICompatibleChatModel({ baseUrl: safeBaseUrl, model, ...(apiKey === undefined ? {} : { apiKey }) }),
    config: { provider: "deepseek", model, baseUrl: safeBaseUrl, configured: true },
  };
}

interface ParsedToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

interface ParsedSseDelta {
  readonly kind: "delta";
  readonly text?: string;
  readonly toolCalls: readonly ParsedToolCallDelta[];
  readonly finishReason?: string;
}

interface ParsedSseDone {
  readonly kind: "done";
}

type ParsedSse = ParsedSseDelta | ParsedSseDone | undefined;

function parseSseLine(line: string): ParsedSse {
  const data = line.trim();
  if (!data.startsWith("data:")) return undefined;
  const payload = data.slice(5).trim();
  if (payload.length === 0) return undefined;
  if (payload === "[DONE]") return { kind: "done" };
  const parsed: unknown = JSON.parse(payload);
  return extractDelta(parsed);
}

function partsForParsedSse(parsed: ParsedSse, openToolIndices: Set<number>): readonly ModelStreamPart[] {
  if (parsed === undefined) return [];
  if (parsed.kind === "done") {
    const parts: ModelStreamPart[] = [...[...openToolIndices].map((index) => ({ type: "tool_call_end", index } as const)), { type: "done" }];
    openToolIndices.clear();
    return parts;
  }
  const parts: ModelStreamPart[] = [];
  if (parsed.text !== undefined && parsed.text.length > 0) parts.push({ type: "text_delta", text: parsed.text });
  for (const toolCall of parsed.toolCalls) {
    if (!openToolIndices.has(toolCall.index)) {
      openToolIndices.add(toolCall.index);
      parts.push({ type: "tool_call_start", index: toolCall.index, ...(toolCall.id === undefined ? {} : { id: toolCall.id }), ...(toolCall.name === undefined ? {} : { name: toolCall.name }) });
    }
    if (toolCall.arguments !== undefined && toolCall.arguments.length > 0) {
      parts.push({ type: "tool_call_delta", index: toolCall.index, arguments: toolCall.arguments });
    }
  }
  if (parsed.finishReason === "tool_calls") {
    for (const index of openToolIndices) {
      parts.push({ type: "tool_call_end", index });
    }
    openToolIndices.clear();
  }
  return parts;
}

function validateHttpUrl(value: string, name: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new ModelConfigurationError(`${name} must be an http(s) URL`);
  }
}

function publicBaseUrl(value: string): string {
  const url = new URL(value);
  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${pathname}`;
}

function extractDelta(value: unknown): ParsedSseDelta {
  if (typeof value !== "object" || value === null) return { kind: "delta", toolCalls: [] };
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { kind: "delta", toolCalls: [] };
  const first = choices[0];
  if (typeof first !== "object" || first === null) return { kind: "delta", toolCalls: [] };
  const delta = (first as { delta?: unknown }).delta;
  const finishReason = (first as { finish_reason?: unknown }).finish_reason;
  const content = typeof delta === "object" && delta !== null ? (delta as { content?: unknown }).content : undefined;
  const rawToolCalls = typeof delta === "object" && delta !== null ? (delta as { tool_calls?: unknown }).tool_calls : undefined;
  const toolCalls: ParsedToolCallDelta[] = [];
  if (Array.isArray(rawToolCalls)) {
    for (const raw of rawToolCalls) {
      if (typeof raw !== "object" || raw === null) continue;
      const index = (raw as { index?: unknown }).index;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) continue;
      const id = (raw as { id?: unknown }).id;
      const functionValue = (raw as { function?: unknown }).function;
      const name = typeof functionValue === "object" && functionValue !== null ? (functionValue as { name?: unknown }).name : undefined;
      const args = typeof functionValue === "object" && functionValue !== null ? (functionValue as { arguments?: unknown }).arguments : undefined;
      toolCalls.push({ index, ...(typeof id === "string" ? { id } : {}), ...(typeof name === "string" ? { name } : {}), ...(typeof args === "string" ? { arguments: args } : {}) });
    }
  }
  return {
    kind: "delta",
    ...(typeof content === "string" ? { text: content } : {}),
    toolCalls,
    ...(typeof finishReason === "string" ? { finishReason } : {}),
  };
}

function toWireMessage(message: ChatMessage): unknown {
  if (message.role === "assistant" && message.toolCalls !== undefined) {
    return {
      role: "assistant",
      content: message.content.length === 0 ? null : message.content,
      tool_calls: message.toolCalls.map((toolCall: ModelToolCall) => ({
        id: toolCall.id,
        type: "function",
        function: { name: toolCall.name, arguments: toolCall.arguments },
      })),
    };
  }
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  return message;
}

export function userMessage(content: string): ChatMessage {
  return { role: "user", content };
}
