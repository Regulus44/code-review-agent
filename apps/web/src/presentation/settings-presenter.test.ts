import { describe, expect, it } from "vitest";
import type { SessionProjection } from "@code-review-agent/contracts";
import { presentSettings } from "./settings-presenter.js";

const session = {
  id: "ses_settings" as SessionProjection["id"],
  title: "Settings fixture",
  workspaceRoot: "D:/workspace",
  permissionPreset: "ask-on-write",
  archived: false,
  deleted: false,
  status: "idle",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
  lastSequence: 4,
  messages: [],
  turns: [],
  toolCalls: [],
  permissions: [],
  interactions: [],
  tasks: [],
  goals: [],
  plan: { content: "", status: "draft", updatedAt: "2026-08-23T00:00:00.000Z", lastSequence: 4 },
  todos: [],
} satisfies SessionProjection;

describe("presentSettings", () => {
  it("summarizes host-backed model, tools, MCP and capability state", () => {
    const view = presentSettings(session, {
      provider: "deepseek",
      current: "deepseek-v4-flash",
      configured: true,
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
    }, [
      { name: "read_file", description: "read", inputSchema: {}, executionMode: "parallel", riskLevel: "read", approvalMode: "auto", interruptBehavior: "cancel", source: { kind: "builtin" } },
      { name: "run_tests", description: "test", inputSchema: {}, executionMode: "exclusive", riskLevel: "execute", approvalMode: "ask", interruptBehavior: "cancel", source: { kind: "builtin" } },
      { name: "search", description: "search", inputSchema: {}, executionMode: "parallel", riskLevel: "network", approvalMode: "ask", interruptBehavior: "block", source: { kind: "mcp", serverName: "docs", rawName: "search" } },
    ], [{ name: "docs", status: "connected" }, { name: "broken", status: "failed" }], { hasSubagentRuntime: true, attachmentCapability: { enabled: true, maxBytes: 524288, allowedMediaTypes: ["text/plain"], imagesEnabled: false }, contextCapability: { enabled: true, configured: true, budget: { maxTokens: 12000 } }, codeModeCapability: { configured: true, enabled: true, limits: { maxRuntimeMs: 5000 } }, lspCapability: { configured: true, servers: ["typescript"] } });

    expect(view.permissionLabel).toBe("Ask on write");
    expect(view.tools).toMatchObject({ total: 3, builtin: 2, mcp: 1, riskCounts: { read: 1, execute: 1, network: 1 } });
    expect(view.mcp).toEqual({ configured: 2, connected: 1, attention: 1 });
    expect(view.capabilities.find((capability) => capability.key === "a2a")).toMatchObject({ status: "deferred" });
    expect(view.capabilities.find((capability) => capability.key === "attachments")).toMatchObject({ status: "available" });
    expect(view.capabilities.find((capability) => capability.key === "context-compaction")).toMatchObject({ status: "configured", detail: expect.stringContaining("12000") });
    expect(view.capabilities.find((capability) => capability.key === "code-mode")).toMatchObject({ status: "configured" });
    expect(view.capabilities.find((capability) => capability.key === "lsp")).toMatchObject({ status: "configured", detail: expect.stringContaining("typescript") });
  });

  it("uses safe defaults when optional host data is unavailable", () => {
    const view = presentSettings(undefined, undefined, [], [], { hasSubagentRuntime: false, a2aStatus: "unavailable" });
    expect(view.workspaceRoot).toBe(".");
    expect(view.permissionPreset).toBe("ask-on-write");
    expect(view.model.available).toEqual([]);
    expect(view.capabilities.find((capability) => capability.key === "subagent")).toMatchObject({ status: "unavailable" });
    expect(view.capabilities.find((capability) => capability.key === "a2a")).toMatchObject({ status: "unavailable" });
    expect(view.capabilities.find((capability) => capability.key === "context-compaction")).toMatchObject({ status: "unavailable" });
  });
});
