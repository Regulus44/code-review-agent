import { describe, expect, it, vi } from "vitest";
import { EchoChatModel, ModelConfigurationError, OpenAICompatibleChatModel, createConfiguredChatModel } from "./index.js";

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

  it("selects Echo without a key and DeepSeek when auto configuration has a key", () => {
    expect(createConfiguredChatModel({ MODEL_PROVIDER: "auto" }).config).toEqual({ provider: "echo", model: "echo", configured: false });
    expect(createConfiguredChatModel({ MODEL_PROVIDER: "auto", DEEPSEEK_API_KEY: "sk-test-only", DEEPSEEK_MODEL: "deepseek-reasoner" }).config).toEqual({ provider: "deepseek", model: "deepseek-reasoner", baseUrl: "https://api.deepseek.com", configured: true });
    expect(createConfiguredChatModel({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "sk-test-only", DEEPSEEK_BASE_URL: "https://example.test/v1?api_key=sk-test-only" }).config.baseUrl).toBe("https://example.test/v1");
  });

  it("fails explicitly selected DeepSeek without revealing a credential", () => {
    expect(() => createConfiguredChatModel({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" })).toThrowError(ModelConfigurationError);
    expect(() => createConfiguredChatModel({ MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "" })).toThrow("DEEPSEEK_API_KEY");
  });
});
