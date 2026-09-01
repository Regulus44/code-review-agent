import { describe, expect, it } from "vitest";
import { brand } from "@coding-agent/contracts";
import { presentLspTool } from "./lsp-presenter.js";
import type { ToolCallView } from "../projection/conversation.js";

const base: ToolCallView = {
  id: brand<string, "ToolCallId">("call_lsp"), name: "lsp_diagnostics", status: "completed", riskLevel: "read", sequence: 1, lastSequence: 2,
  createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:01.000Z",
  result: { ok: true, output: { serverId: "ts", method: "textDocument/diagnostic", path: "src/a.ts", result: { items: [{ severity: 1, message: "Type error", source: "ts", range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }] } } },
};

describe("presentLspTool", () => {
  it("projects diagnostics with source locations and bounded status", () => {
    const view = presentLspTool(base);
    expect(view).toMatchObject({ visible: true, method: "diagnostics", serverId: "ts", path: "src/a.ts", status: "completed" });
    expect(view.diagnostics[0]).toMatchObject({ severity: "错误", message: "Type error", location: { line: 1, character: 2, preview: expect.stringContaining(":2:3") } });
  });

  it("projects definition/reference locations and restart/failure states", () => {
    const definition = presentLspTool({ ...base, name: "lsp_definition", result: { ok: true, output: { method: "textDocument/definition", result: [{ uri: "file:///workspace/a.ts", range: { start: { line: 4, character: 1 } } }] } } });
    expect(definition).toMatchObject({ method: "definition", locations: [{ line: 4, character: 1 }] });
    const failed = presentLspTool({ ...base, status: "failed", progress: ["restart_requested", "LSP_SERVER_CRASHED"], result: { ok: false, error: { message: "server crashed" } } });
    expect(failed).toMatchObject({ status: "failed", restartState: "requested", error: "server crashed" });
  });
});
