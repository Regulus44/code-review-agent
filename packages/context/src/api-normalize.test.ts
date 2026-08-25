import { describe, expect, it } from "vitest";
import { normalizeMessagesForAPI } from "./api-normalize.js";

describe("M04 API message normalization", () => {
  it("merges streaming assistant chunks and repairs bounded identifiers", () => {
    const result = normalizeMessagesForAPI([
      { role: "user", content: "request" },
      { role: "assistant", content: "hel", responseId: "r1", toolCalls: [{ id: "", name: "read", arguments: "" }] },
      { role: "assistant", content: "lo", responseId: "r1" },
    ]);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({ role: "assistant", content: "hello", responseId: "r1" });
    expect(result.messages[1]?.role === "assistant" ? result.messages[1].toolCalls?.[0]?.arguments : undefined).toBe("{}");
    expect(result.report.changed).toBe(true);
    expect(result.report.mergedAssistantMessages).toBe(1);
  });

  it("keeps strict input unchanged when normalization finds an issue", () => {
    const input = [{ role: "assistant", content: "x", toolCalls: [{ id: "", name: "tool", arguments: "{}" }] }] as const;
    const result = normalizeMessagesForAPI(input, { mode: "strict" });
    expect(result.report.valid).toBe(false);
    expect(result.messages).toBe(input);
  });
});
