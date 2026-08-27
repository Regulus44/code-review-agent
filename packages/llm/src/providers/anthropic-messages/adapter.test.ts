import { describe, expect, it } from "vitest";
import type { ModelStreamPart } from "@code-review-agent/contracts";
import { AnthropicMessagesChatModel } from "./adapter.js";
import { serializeAnthropicRequest } from "./serialize.js";

describe("AnthropicMessagesChatModel", () => {
  it("serializes system, tool use, tool result, and tool choice without placing credentials in the body", () => {
    const request = serializeAnthropicRequest({
      messages: [
        { role: "system", content: "Follow repository rules." },
        { role: "user", content: "Inspect the file." },
        { role: "assistant", content: "", toolCalls: [{ id: "tool_1", name: "read_file", arguments: '{"path":"README.md"}' }] },
        { role: "tool", toolCallId: "tool_1", content: "contents" },
      ],
      tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
      toolChoice: { type: "function", name: "read_file" },
    }, "claude-fixture", 1234);

    expect(request).toEqual({
      model: "claude-fixture",
      max_tokens: 1234,
      stream: true,
      system: "Follow repository rules.",
      tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "read_file" },
      messages: [
        { role: "user", content: [{ type: "text", text: "Inspect the file." }] },
        { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "read_file", input: { path: "README.md" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: "contents" }] },
      ],
    });
  });

  it("maps text, tool JSON deltas, usage, and message_stop in order", async () => {
    let init: RequestInit | undefined;
    const model = new AnthropicMessagesChatModel({
      baseUrl: "https://provider.example.test/v1",
      model: "claude-fixture",
      apiKey: "token-test-only",
      fetch: async (_input, requestInit) => {
        init = requestInit;
        return new Response([
          frame("message_start", { message: { usage: { input_tokens: 12, cache_read_input_tokens: 3 } } }),
          frame("content_block_start", { index: 0, content_block: { type: "text" } }),
          frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } }),
          frame("content_block_stop", { index: 0 }),
          frame("content_block_start", { index: 1, content_block: { type: "tool_use", id: "call_1", name: "read_file" } }),
          frame("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' } }),
          frame("content_block_stop", { index: 1 }),
          frame("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
          frame("message_stop", {}),
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });

    const parts = await collect(model);
    expect(parts).toEqual([
      { type: "usage", usage: { inputTokens: 12, cacheReadTokens: 3 } },
      { type: "text_delta", text: "Hello" },
      { type: "tool_call_start", index: 1, id: "call_1", name: "read_file" },
      { type: "tool_call_delta", index: 1, arguments: '{"path":"README.md"}' },
      { type: "tool_call_end", index: 1 },
      { type: "usage", usage: { outputTokens: 7 } },
      { type: "done" },
    ]);
    expect(new Headers(init?.headers).get("x-api-key")).toBe("token-test-only");
    expect(new Headers(init?.headers).get("anthropic-version")).toBe("2023-06-01");
    expect(String(init?.body)).not.toContain("token-test-only");
    expect(String(init?.body)).toContain('"max_tokens":8192');
  });

  it("uses the standard /v1/messages suffix when a gateway base URL is root-scoped", async () => {
    let requestedUrl = "";
    const model = new AnthropicMessagesChatModel({
      baseUrl: "https://provider.example.test",
      model: "claude-fixture",
      fetch: async (input) => {
        requestedUrl = String(input);
        return new Response(frame("message_stop", {}), { headers: { "content-type": "text/event-stream" } });
      },
    });
    await expect(collect(model)).resolves.toEqual([{ type: "done" }]);
    expect(requestedUrl).toBe("https://provider.example.test/v1/messages");
  });

  it("consumes provider thinking blocks without leaking reasoning text into the neutral stream", async () => {
    const model = new AnthropicMessagesChatModel({
      baseUrl: "https://provider.example.test/v1",
      model: "claude-fixture",
      fetch: async () => new Response([
        frame("content_block_start", { index: 0, content_block: { type: "thinking" } }),
        frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "internal" } }),
        frame("content_block_stop", { index: 0 }),
        frame("message_stop", {}),
      ].join(""), { headers: { "content-type": "text/event-stream" } }),
    });
    await expect(collect(model)).resolves.toEqual([{ type: "done" }]);
  });

  it("classifies provider HTTP failures without copying provider bodies into a stable code", async () => {
    const expected = new Map([[401, "ANTHROPIC_AUTHENTICATION_FAILED"], [413, "ANTHROPIC_CONTEXT_TOO_LARGE"], [429, "ANTHROPIC_RATE_LIMITED"], [529, "ANTHROPIC_OVERLOADED"]]);
    for (const [status, code] of expected) {
      const model = new AnthropicMessagesChatModel({
        baseUrl: "https://provider.example.test/v1",
        model: "claude-fixture",
        fetch: async () => new Response(JSON.stringify({ error: { type: "provider_fixture", message: "bounded fixture failure" } }), { status }),
      });
      await expect(collect(model)).rejects.toMatchObject({ code, status, providerCode: "provider_fixture" });
    }
  });

  it("fails closed for max_tokens and a stream that closes without message_stop", async () => {
    const capped = new AnthropicMessagesChatModel({
      baseUrl: "https://provider.example.test/v1",
      model: "claude-fixture",
      fetch: async () => new Response(frame("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 8 } }), { headers: { "content-type": "text/event-stream" } }),
    });
    await expect(collect(capped)).resolves.toEqual([{ type: "error", code: "ANTHROPIC_MAX_TOKENS", message: "Anthropic Messages stopped because max_tokens was reached" }]);

    const closed = new AnthropicMessagesChatModel({
      baseUrl: "https://provider.example.test/v1",
      model: "claude-fixture",
      fetch: async () => new Response(frame("message_start", { message: { usage: { input_tokens: 1 } } }), { headers: { "content-type": "text/event-stream" } }),
    });
    await expect(collect(closed)).rejects.toMatchObject({ code: "ANTHROPIC_STREAM_CLOSED" });
  });

  it("aborts an idle reader with a stable timeout error", async () => {
    const model = new AnthropicMessagesChatModel({
      baseUrl: "https://provider.example.test/v1",
      model: "claude-fixture",
      idleTimeoutMs: 10,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { headers: { "content-type": "text/event-stream" } }),
    });
    await expect(collect(model)).rejects.toMatchObject({ code: "ANTHROPIC_IDLE_TIMEOUT" });
  });
});

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function collect(model: AnthropicMessagesChatModel): Promise<ModelStreamPart[]> {
  const parts: ModelStreamPart[] = [];
  for await (const part of model.stream({ messages: [{ role: "user", content: "hello" }] })) parts.push(part);
  return parts;
}
