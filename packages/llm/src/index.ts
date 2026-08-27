import type { ChatMessage, ChatModel, ModelContextCapability, ModelRequest, ModelStreamPart, ModelToolCall, ModelUsage } from "@code-review-agent/contracts";
import { ModelProtocolRegistry, type ModelProtocolModelConfig } from "./registry.js";

export { ModelProtocolRegistry, ModelProtocolRegistryError, type ModelProtocolAdapter, type ModelProtocolModelConfig, type ModelProtocolRegistration } from "./registry.js";

export const ECHO_MODEL_PROTOCOL = "echo";
export const OPENAI_CHAT_COMPLETIONS_PROTOCOL = "openai-chat-completions";

export interface OpenAICompatibleOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly contextCapability?: ModelContextCapability;
  /** Injectable for contract tests; production uses the platform Fetch API. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Provider IDs are configuration values; protocol identity is kept separately. */
export type ConfiguredModelProvider = string;

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

/** Bootstrap used by API Hosts without embedding provider-specific environment logic. */
export interface ConfiguredModelBootstrap {
  readonly initial: ConfiguredChatModel;
  readonly availableModels: readonly string[];
  /** Present only when the configured provider exposes a selectable model catalog. */
  readonly selectModel?: (model: string, credentialEnvironment?: NodeJS.ProcessEnv) => ConfiguredChatModel;
}

export class ModelConfigurationError extends Error {
  readonly code = "MODEL_CONFIGURATION_ERROR";
}

/** Provider response failure with bounded metadata used by M09 recovery. */
export class ModelProviderError extends Error {
  readonly status: number;
  readonly providerCode?: string;

  constructor(message: string, status: number, providerCode?: string) {
    super(message);
    this.name = "ModelProviderError";
    this.status = status;
    if (providerCode !== undefined) this.providerCode = providerCode;
  }
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
  readonly contextCapability?: ModelContextCapability;

  constructor(private readonly options: OpenAICompatibleOptions) {
    if (options.contextCapability !== undefined) this.contextCapability = options.contextCapability;
  }

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
    let response: Response;
    try {
      response = await fetchWithRetry(fetchImpl, url, {
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
          ...(request.reasoningEffort === undefined || request.reasoningEffort === "default" || request.reasoningEffort === "off"
            ? {}
            : { reasoning_effort: request.reasoningEffort }),
        }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }, request.signal);
    } catch (error) {
      throw new Error(`LLM request failed before receiving a response from ${url}: ${describeNetworkError(error)}`);
    }
    if (!response.ok) {
      const detail = await readProviderErrorDetail(response);
      throw new ModelProviderError(
        "LLM request failed with HTTP " + response.status + (detail.message === undefined ? "" : ": " + detail.message),
        response.status,
        detail.code,
      );
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

/** Registers the two current protocol implementations without retaining call configuration. */
export function createBuiltInModelProtocolRegistry(): ModelProtocolRegistry {
  const registry = new ModelProtocolRegistry();
  registry.register({
    protocol: ECHO_MODEL_PROTOCOL,
    createModel: () => new EchoChatModel(),
  });
  registry.register({
    protocol: OPENAI_CHAT_COMPLETIONS_PROTOCOL,
    createModel: (config: ModelProtocolModelConfig) => {
      if (config.baseUrl === undefined || config.baseUrl.length === 0) {
        throw new ModelConfigurationError(`${OPENAI_CHAT_COMPLETIONS_PROTOCOL} requires baseUrl`);
      }
      return new OpenAICompatibleChatModel({
        baseUrl: config.baseUrl,
        model: config.model,
        ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
        ...(config.headers === undefined ? {} : { headers: config.headers }),
        ...(config.contextCapability === undefined ? {} : { contextCapability: config.contextCapability }),
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      });
    },
  });
  return registry;
}

async function readProviderErrorDetail(response: Response): Promise<{ readonly message?: string; readonly code?: string }> {
  try {
    const raw = await response.text();
    if (raw.trim().length === 0) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { message: raw.slice(0, 300) };
    const root = parsed as Record<string, unknown>;
    const nested = typeof root["error"] === "object" && root["error"] !== null ? root["error"] as Record<string, unknown> : undefined;
    const message = typeof nested?.["message"] === "string" ? nested["message"] : typeof root["message"] === "string" ? root["message"] : undefined;
    const code = typeof nested?.["code"] === "string" ? nested["code"] : typeof root["code"] === "string" ? root["code"] : undefined;
    return {
      ...(message === undefined ? {} : { message: message.slice(0, 300) }),
      ...(code === undefined ? {} : { code: code.slice(0, 120) }),
    };
  } catch {
    return {};
  }
}

async function fetchWithRetry(fetchImpl: typeof globalThis.fetch, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      lastError = error;
      if (signal?.aborted || attempt === 2) throw error;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 250);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("Request cancelled")); }, { once: true });
      });
    }
  }
  throw lastError ?? new Error("Unknown network failure");
}

function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (cause instanceof Error && cause.message !== error.message) return `${error.message}; cause: ${cause.message}`;
  return error.message;
}

/**
 * Selects the local model without ever returning the API key to callers.
 * `auto` uses DeepSeek only when a non-empty key is present; otherwise it is deterministic Echo.
 */
export function createConfiguredChatModel(
  env: NodeJS.ProcessEnv = process.env,
  registry: ModelProtocolRegistry = createBuiltInModelProtocolRegistry(),
): ConfiguredChatModel {
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
      model: registry.create(ECHO_MODEL_PROTOCOL, { model: "echo" }),
      config: { provider: "echo", model: "echo", configured: false },
    };
  }

  const baseUrl = env["DEEPSEEK_BASE_URL"]?.trim() || "https://api.deepseek.com";
  validateHttpUrl(baseUrl, "DEEPSEEK_BASE_URL");
  const safeBaseUrl = publicBaseUrl(baseUrl);
  const model = env["DEEPSEEK_MODEL"]?.trim() || DEFAULT_DEEPSEEK_MODEL;
  const contextCapability: ModelContextCapability = {
    provider: "deepseek",
    model,
    // DeepSeek's OpenAI-compatible route is treated as a host capability
    // estimate until a provider metadata endpoint is added.
    maxInputTokens: 128_000,
    maxOutputTokens: 8_000,
    supportsExactCount: false,
    supportsPromptCache: false,
    source: "provider",
  };
  return {
    model: registry.create(OPENAI_CHAT_COMPLETIONS_PROTOCOL, { baseUrl: safeBaseUrl, model, contextCapability, ...(apiKey === undefined ? {} : { apiKey }) }),
    config: { provider: "deepseek", model, baseUrl: safeBaseUrl, configured: true },
  };
}

/**
 * Converts legacy process-environment configuration into an API-neutral model
 * bootstrap. Future ProviderProfile support replaces this compatibility layer.
 */
export function createConfiguredModelBootstrap(
  env: NodeJS.ProcessEnv = process.env,
  registry: ModelProtocolRegistry = createBuiltInModelProtocolRegistry(),
): ConfiguredModelBootstrap {
  const initial = createConfiguredChatModel(env, registry);
  const selectable = configuredProviderSelection(initial.config.provider);
  return {
    initial,
    availableModels: selectable?.models ?? [],
    ...(selectable === undefined ? {} : {
      selectModel: (model: string, credentialEnvironment: NodeJS.ProcessEnv = {}) => createConfiguredChatModel({
        ...env,
        ...credentialEnvironment,
        MODEL_PROVIDER: initial.config.provider,
        [selectable.modelEnvironmentVariable]: model,
      }, registry),
    }),
  };
}

function configuredProviderSelection(provider: string): { readonly models: readonly string[]; readonly modelEnvironmentVariable: string } | undefined {
  if (provider === "deepseek") {
    return { models: DEEPSEEK_MODELS, modelEnvironmentVariable: "DEEPSEEK_MODEL" };
  }
  return undefined;
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
  readonly usage?: ModelUsage;
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
  if (parsed.usage !== undefined) parts.push({ type: "usage", usage: parsed.usage });
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
  const usage = parseUsage((value as { usage?: unknown }).usage);
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { kind: "delta", toolCalls: [], ...(usage === undefined ? {} : { usage }) };
  const first = choices[0];
  if (typeof first !== "object" || first === null) return { kind: "delta", toolCalls: [], ...(usage === undefined ? {} : { usage }) };
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
    ...(usage === undefined ? {} : { usage }),
  };
}

function parseUsage(value: unknown): ModelUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const promptDetails = typeof source.prompt_tokens_details === "object" && source.prompt_tokens_details !== null
    ? source.prompt_tokens_details as Record<string, unknown>
    : undefined;
  const completionDetails = typeof source.completion_tokens_details === "object" && source.completion_tokens_details !== null
    ? source.completion_tokens_details as Record<string, unknown>
    : undefined;
  const inputTokens = finiteNonNegativeNumber(source.prompt_tokens ?? source.input_tokens);
  const outputTokens = finiteNonNegativeNumber(source.completion_tokens ?? source.output_tokens);
  const cacheReadTokens = finiteNonNegativeNumber(
    source.prompt_cache_hit_tokens
      ?? source.cache_read_tokens
      ?? source.cached_tokens
      ?? promptDetails?.cached_tokens,
  );
  const reasoningTokens = finiteNonNegativeNumber(
    source.reasoning_tokens
      ?? completionDetails?.reasoning_tokens,
  );
  if (inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined && reasoningTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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
