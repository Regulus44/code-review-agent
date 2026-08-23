import { describe, expect, it } from "vitest";
import type { McpServerView } from "../client/api.js";
import { presentMcpServer } from "./mcp-presenter.js";

function server(overrides: Record<string, unknown> = {}): McpServerView {
  return {
    name: "fixture",
    status: "connected",
    revision: 3,
    generation: 7,
    config: { name: "fixture", scope: "project", transport: "stdio", credentialRef: { id: "oauth_1", kind: "oauth" } },
    catalog: [
      { name: "read", rawName: "read", enabled: true, riskLevel: "read", approvalMode: "auto" },
      { name: "write", rawName: "write", enabled: false, riskLevel: "write", approvalMode: "ask", disabledReason: "tool-policy-disabled" },
    ],
    ...overrides,
  };
}

describe("MCP presenter", () => {
  it("summarizes scope, generation, auth and catalog policy", () => {
    const view = presentMcpServer(server());
    expect(view).toMatchObject({ name: "fixture", scope: "project", transport: "stdio", revision: 3, generation: 7, auth: "credential reference configured", activeCount: 1, disabledCount: 1 });
    expect(view.catalog[1]).toMatchObject({ name: "write", enabled: false, disabledReason: "tool-policy-disabled" });
  });

  it("shows retry/error and bounds untrusted details", () => {
    const view = presentMcpServer(server({ status: "failed", lastError: "token=secret", retry: { nextAttemptAt: "2026-08-23T01:00:00Z" } }), { maxDetailChars: 512 });
    expect(view.retryAt).toBe("2026-08-23T01:00:00Z");
    expect(view.lastError).toContain("token");
    expect(view.details.text).toContain("[redacted]");
    expect(view.details.untrusted).toBe(true);
  });

  it("does not claim authorization when no credential reference exists", () => {
    const view = presentMcpServer(server({ config: { name: "fixture", scope: "session", transport: "sse" } }));
    expect(view.auth).toBe("no credential reference");
  });
});
