import type { ChatMessage, ChatModel, ModelRequest, ModelStreamPart } from "@code-review-agent/contracts";

export interface OpenAICompatibleOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Injectable for contract tests; production uses the platform Fetch API. */
  readonly fetch?: typeof globalThis.fetch;
}

export type ConfiguredModelProvider = "echo" | "deepseek";

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
        messages: request.messages,
        stream: true,
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
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseSseLine(line);
        if (parsed === SSE_DONE) {
          yield { type: "done" };
          return;
        }
        if (parsed !== undefined) {
          yield { type: "text_delta", text: parsed };
        }
      }
      if (chunk.done) {
        const parsed = parseSseLine(buffer);
        if (parsed === SSE_DONE) {
          yield { type: "done" };
          return;
        }
        if (parsed !== undefined) {
          yield { type: "text_delta", text: parsed };
        }
        break;
      }
    }
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
  const model = env["DEEPSEEK_MODEL"]?.trim() || "deepseek-chat";
  return {
    model: new OpenAICompatibleChatModel({ baseUrl: safeBaseUrl, model, ...(apiKey === undefined ? {} : { apiKey }) }),
    config: { provider: "deepseek", model, baseUrl: safeBaseUrl, configured: true },
  };
}

const SSE_DONE = Symbol("sse_done");

function parseSseLine(line: string): string | typeof SSE_DONE | undefined {
  const data = line.trim();
  if (!data.startsWith("data:")) return undefined;
  const payload = data.slice(5).trim();
  if (payload.length === 0) return undefined;
  if (payload === "[DONE]") return SSE_DONE;
  const parsed: unknown = JSON.parse(payload);
  return extractDeltaText(parsed);
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

function extractDeltaText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const delta = (first as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) return undefined;
  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

export function userMessage(content: string): ChatMessage {
  return { role: "user", content };
}
