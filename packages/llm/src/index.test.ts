import { describe, expect, it, vi } from "vitest";
import { ANTHROPIC_MESSAGES_PROTOCOL, DEFAULT_DEEPSEEK_MODEL, DEEPSEEK_MODELS, ECHO_MODEL_PROTOCOL, EchoChatModel, ModelConfigurationError, ModelProtocolRegistry, OPENAI_CHAT_COMPLETIONS_PROTOCOL, OpenAICompatibleChatModel, createConfiguredChatModel, createConfiguredModelBootstrap } from "./index.js";

describe("EchoChatModel", () => {
  it("streams incremental text and a terminal marker", async () => {
    const parts = [];
    for await (const part of new EchoChatModel().stream({ messages: [{ role: "user", content: "hello" }] })) {
      parts.push(part);
    }
    expect(parts.at(-1)).toEqual({ type: "done" });
    expect(parts.filter((part) => part.type === "text_delta").map((part) => part.text).join("")).toBe("Echo: hello");
  });

  it("parses an OpenAI-compatible SSE response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );
    const parts = [];
    for await (const part of new OpenAICompatibleChatModel({ baseUrl: "https://example.test/v1", model: "coder" }).stream({ messages: [{ role: "user", content: "hi" }] })) {
      parts.push(part);
    }
    expect(parts).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " world" },
      { type: "done" },
    ]);
    vi.unstubAllGlobals();
  });

  it("parses usage-only SSE chunks without choices", async () => {
    const modelFetch: typeof fetch = async () => new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
        + 'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":3},"completion_tokens_details":{"reasoning_tokens":4}}}\n\n'
        + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
    const parts = [];
    for await (const part of new OpenAICompatibleChatModel({ baseUrl: "https://example.test/v1", model: "coder", fetch: modelFetch }).stream({ messages: [{ role: "user", content: "hi" }] })) {
      parts.push(part);
    }
    expect(parts).toEqual([
      { type: "text_delta", text: "ok" },
      { type: "usage", usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 3, reasoningTokens: 4 } },
      { type: "done" },
    ]);
  });

  it("retries bounded capacity responses and honors retry-after", async () => {
    let calls = 0;
    const modelFetch: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 429, headers: { "retry-after": "0", "x-request-id": "req-rate" } });
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]", { headers: { "content-type": "text/event-stream" } });
    };
    const parts = [];
    for await (const part of new OpenAICompatibleChatModel({ baseUrl: "https://example.test", model: "coder", fetch: modelFetch }).stream({ messages: [{ role: "user", content: "hi" }] })) parts.push(part);
    expect(calls).toBe(2);
    expect(parts).toEqual([{ type: "text_delta", text: "ok" }, { type: "done" }]);
  });

  it("passes provider reasoning effort through the wire request", async () => {
    let requestInit: RequestInit | undefined;
    const modelFetch: typeof fetch = async (_input, init) => {
      requestInit = init;
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]", { headers: { "content-type": "text/event-stream" } });
    };
    for await (const _part of new OpenAICompatibleChatModel({ baseUrl: "https://example.test", model: "coder", fetch: modelFetch }).stream({
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "high",
    })) {
      // consume stream
    }
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({ reasoning_effort: "high" });
  });

  it("sends the API key only as an authorization header", async () => {
    let requestInit: RequestInit | undefined;
    const modelFetch: typeof fetch = async (_input, init) => {
      requestInit = init;
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]", {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const parts = [];
    for await (const part of new OpenAICompatibleChatModel({ baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "sk-test-only", fetch: modelFetch }).stream({ messages: [{ role: "user", content: "hi" }] })) {
      parts.push(part);
    }
    expect(parts).toEqual([{ type: "text_delta", text: "ok" }, { type: "done" }]);
    expect((requestInit?.headers as Record<string, string>).authorization).toBe("Bearer sk-test-only");
    expect(JSON.stringify(requestInit?.body)).not.toContain("sk-test-only");
  });

  it("serializes tool schemas and parses streamed tool calls", async () => {
    let requestInit: RequestInit | undefined;
    const modelFetch: typeof fetch = async (_input, init) => {
      requestInit = init;
      const frames = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "src/main.ts\"}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ];
      return new Response(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const parts = [];
    for await (const part of new OpenAICompatibleChatModel({ baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", fetch: modelFetch }).stream({
      messages: [{ role: "user", content: "read the file" }],
      tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
      toolChoice: "auto",
    })) {
      parts.push(part);
    }
    const request = JSON.parse(String(requestInit?.body)) as { tools?: unknown; tool_choice?: unknown; messages?: unknown[] };
    expect(request.tools).toEqual([{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }]);
    expect(request.tool_choice).toBe("auto");
    expect(parts).toEqual([
      { type: "tool_call_start", index: 0, id: "call_1", name: "read_file" },
      { type: "tool_call_delta", index: 0, arguments: "{\"path\":\"" },
      { type: "tool_call_delta", index: 0, arguments: "src/main.ts\"}" },
      { type: "tool_call_end", index: 0 },
      { type: "done" },
    ]);
  });

  it("rejects malformed provider SSE JSON instead of silently dropping a tool call", async () => {
    const modelFetch: typeof fetch = async () => new Response("data: {not-json}\n\n", { headers: { "content-type": "text/event-stream" } });
    const stream = new OpenAICompatibleChatModel({ baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", fetch: modelFetch }).stream({ messages: [{ role: "user", content: "read" }] });
    await expect((async () => {
      for await (const _part of stream) {
        // Consume the stream to surface the parser error.
      }
    })()).rejects.toThrow(SyntaxError);
  });

  it("selects Echo without a key and DeepSeek when auto configuration has a key", () => {
    expect(createConfiguredChatModel({ MODEL_PROVIDER: "auto" }).config).toEqual({ provider: "echo", model: "echo", configured: false });
    expect(createConfiguredChatModel({ MODEL_PROVIDER: "auto", DEEPSEEK_API_KEY: "sk-test-only" }).config).toEqual({ provider: "deepseek", model: DEFAULT_DEEPSEEK_MODEL, baseUrl: "https://api.deepseek.com", configured: true });
    expect(createConfiguredChatModel({ MODEL_PROVIDER: "auto", DEEPSEEK_API_KEY: "sk-test-only", DEEPSEEK_MODEL: "deepseek-reasoner" }).config).toEqual({ provider: "deepseek", model: "deepseek-reasoner", baseUrl: "https://api.deepseek.com", configured: true });
    expect(DEEPSEEK_MODELS).toEqual(["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"]);
    expect(createConfiguredChatModel({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-test-only", DEEPSEEK_BASE_URL: "https://example.test/v1?api_key=sk-test-only" }).config.baseUrl).toBe("https://example.test/v1");
  });

  it("fails explicitly selected DeepSeek without revealing a credential", () => {
    expect(() => createConfiguredChatModel({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" })).toThrowError(ModelConfigurationError);
    expect(() => createConfiguredChatModel({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" })).toThrow("DEEPSEEK_API_KEY");
  });

  it("dispatches Echo and DeepSeek bootstrap models through registered protocols", () => {
    const registry = new ModelProtocolRegistry();
    const calls: { protocol: string; model: string; baseUrl?: string }[] = [];
    registry.register({ protocol: ECHO_MODEL_PROTOCOL, createModel: (config) => {
      calls.push({ protocol: ECHO_MODEL_PROTOCOL, model: config.model });
      return new EchoChatModel();
    } });
    registry.register({ protocol: OPENAI_CHAT_COMPLETIONS_PROTOCOL, createModel: (config) => {
      calls.push({ protocol: OPENAI_CHAT_COMPLETIONS_PROTOCOL, model: config.model, ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }) });
      return new EchoChatModel();
    } });

    const echo = createConfiguredChatModel({ MODEL_PROVIDER: "echo" }, registry);
    const bootstrap = createConfiguredModelBootstrap({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-test-only" }, registry);
    const selected = bootstrap.selectModel?.("deepseek-v4-pro");

    expect(echo.config).toEqual({ provider: "echo", model: "echo", configured: false });
    expect(bootstrap.availableModels).toEqual(DEEPSEEK_MODELS);
    expect(selected?.config.model).toBe("deepseek-v4-pro");
    expect(calls).toEqual([
      { protocol: ECHO_MODEL_PROTOCOL, model: "echo" },
      { protocol: OPENAI_CHAT_COMPLETIONS_PROTOCOL, model: DEFAULT_DEEPSEEK_MODEL, baseUrl: "https://api.deepseek.com" },
      { protocol: OPENAI_CHAT_COMPLETIONS_PROTOCOL, model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com" },
    ]);
  });

  it("selects an Anthropic Messages model from the third-party-compatible environment variables", () => {
    const registry = new ModelProtocolRegistry();
    registry.register({ protocol: ECHO_MODEL_PROTOCOL, createModel: () => new EchoChatModel() });
    const received: { protocol?: string; model?: string; baseUrl?: string; maxOutputTokens?: number } = {};
    registry.register({ protocol: OPENAI_CHAT_COMPLETIONS_PROTOCOL, createModel: () => new EchoChatModel() });
    registry.register({ protocol: ANTHROPIC_MESSAGES_PROTOCOL, createModel: (config) => {
      received.protocol = ANTHROPIC_MESSAGES_PROTOCOL;
      received.model = config.model;
      if (config.baseUrl !== undefined) received.baseUrl = config.baseUrl;
      if (config.maxOutputTokens !== undefined) received.maxOutputTokens = config.maxOutputTokens;
      return new EchoChatModel();
    } });

    const configured = createConfiguredChatModel({
      MODEL_PROVIDER: "anthropic",
      ANTHROPIC_AUTH_TOKEN: "token-test-only",
      ANTHROPIC_BASE_URL: "https://provider.example.test/v1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-fixture",
    }, registry);

    expect(configured.config).toEqual({ provider: "anthropic", model: "claude-fixture", baseUrl: "https://provider.example.test/v1", configured: true });
    expect(received).toEqual({ protocol: ANTHROPIC_MESSAGES_PROTOCOL, model: "claude-fixture", baseUrl: "https://provider.example.test/v1", maxOutputTokens: 8192 });
  });
});
