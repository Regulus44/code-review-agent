import type { ChatMessage, ChatModel, ModelRequest, ModelStreamPart } from "@code-review-agent/contracts";

export interface OpenAICompatibleOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly headers?: Readonly<Record<string, string>>;
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
    const response = await fetch(url, {
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
        const data = line.trim();
        if (!data.startsWith("data:")) continue;
        const payload = data.slice(5).trim();
        if (payload === "[DONE]") {
          yield { type: "done" };
          return;
        }
        const parsed: unknown = JSON.parse(payload);
        const text = extractDeltaText(parsed);
        if (text !== undefined) {
          yield { type: "text_delta", text };
        }
      }
      if (chunk.done) break;
    }
    yield { type: "done" };
  }
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
