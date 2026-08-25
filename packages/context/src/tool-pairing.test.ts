import { describe, expect, it } from "vitest";
import { ensureToolResultPairing } from "./tool-pairing.js";

describe("M04 tool pairing", () => {
  it("repairs missing and orphan results with a deterministic synthetic result", () => {
    const result = ensureToolResultPairing([
      { role: "assistant", content: "call", toolCalls: [
        { id: "call_1", name: "read", arguments: "{}" },
        { id: "call_2", name: "grep", arguments: "{}" },
      ] },
      { role: "tool", toolCallId: "call_1", content: "ok" },
      { role: "tool", toolCallId: "orphan", content: "unexpected" },
    ]);
    expect(result.report.valid).toBe(false);
    expect(result.report.repaired).toBe(true);
    expect(result.report.syntheticResultCount).toBe(1);
    expect(result.report.removedOrphanResultCount).toBe(1);
    expect(result.messages.map((message) => message.role)).toEqual(["assistant", "tool", "tool"]);
    expect(result.messages[2]?.role === "tool" ? result.messages[2].toolCallId : undefined).toBe("call_2");
  });

  it("reports duplicate calls and refuses to repair in strict mode", () => {
    const input = [
      { role: "assistant", content: "call", toolCalls: [{ id: "same", name: "read", arguments: "{}" }] },
      { role: "assistant", content: "duplicate", toolCalls: [{ id: "same", name: "read", arguments: "{}" }] },
    ] as const;
    const result = ensureToolResultPairing(input, { mode: "strict" });
    expect(result.report.valid).toBe(false);
    expect(result.messages).toBe(input);
    expect(result.report.issues.some((issue) => issue.code === "DUPLICATE_TOOL_CALL_ID")).toBe(true);
  });
});
