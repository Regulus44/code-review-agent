import { describe, expect, it } from "vitest";
import { presentToolCall } from "./tool-presenter.js";
import type { ToolCallView } from "../projection/conversation.js";

function call(name: string, result: unknown): ToolCallView {
  return {
    id: "tool_1" as never,
    name,
    status: "completed",
    riskLevel: "read",
    result,
    sequence: 1,
    lastSequence: 1,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  };
}

describe("Tool presenter", () => {
  it("classifies MCP and bounded output without exposing secrets", () => {
    const view = presentToolCall(call("mcp__browserfixture__read", { modelView: { value: "ok", apiKey: "secret" } }), { maxDetailChars: 256 });
    expect(view.kind).toBe("mcp");
    expect(view.sourceLabel).toBe("MCP · browserfixture · read");
    expect(view.details).toContain("[redacted]");
    expect(view.untrusted).toBe(true);
  });

  it("always provides a generic bounded fallback", () => {
    const view = presentToolCall(call("read_file", { output: "x".repeat(1_000) }), { maxDetailChars: 256 });
    expect(view.kind).toBe("builtin");
    expect(view.truncated).toBe(true);
    expect(view.details).toContain("output truncated");
  });
});
