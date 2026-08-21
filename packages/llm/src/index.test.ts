import { describe, expect, it, vi } from "vitest";
import { EchoChatModel, OpenAICompatibleChatModel } from "./index.js";

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
});
