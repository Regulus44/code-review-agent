import { describe, expect, it } from "vitest";
import { presentToolCall } from "./tool-presenter.js";
import type { ToolCallView } from "../projection/conversation.js";

function call(name: string, result: unknown, input?: unknown, status: ToolCallView["status"] = "completed"): ToolCallView {
  return {
    id: "tool_1" as never,
    name,
    status,
    riskLevel: "read",
    result,
    ...(input === undefined ? {} : { input }),
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

  it("derives a compact target summary and separate IN/OUT sections", () => {
    const view = presentToolCall(call("read_file", { output: "contents" }, { path: "src/index.ts" }));
    expect(view.title).toBe("读取");
    expect(view.summary).toBe("src/index.ts");
    expect(view.filePath).toBe("src/index.ts");
    expect(view.input).toContain("path");
    expect(view.output).toContain("output");
    expect(view.state).toBe("ok");
    expect(view.statusLabel).toBe("已完成");
  });

  it("maps pending, failed and cancelled calls to DSH row states", () => {
    expect(presentToolCall(call("bash", undefined, { command: "pnpm test" }, "pending")).state).toBe("running");
    expect(presentToolCall(call("bash", { message: "boom" }, { command: "pnpm test" }, "failed")).state).toBe("error");
    expect(presentToolCall(call("bash", { message: "stopped" }, { command: "pnpm test" }, "cancelled")).state).toBe("stopped");
  });

  it("keeps established developer tool terms in English", () => {
    expect(presentToolCall(call("bash", undefined, { command: "pnpm test" })).title).toBe("Bash");
    expect(presentToolCall(call("diff_preview", {})).sourceLabel).toBe("Diff / Patch");
    expect(presentToolCall(call("terminal_session", {})).sourceLabel).toBe("Terminal / Job");
  });
});
