import { brand, type SessionProjection } from "@coding-agent/contracts";
import { describe, expect, it } from "vitest";
import { presentMemoryInspector } from "./memory-presenter.js";

const sessionId = brand<string, "SessionId">("ses_memory");

function session(overrides: Partial<SessionProjection> = {}): SessionProjection {
  return {
    id: sessionId,
    workspaceRoot: "D:/workspace",
    permissionPreset: "ask-on-write",
    archived: false,
    deleted: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    status: "idle",
    lastSequence: 2,
    messages: [], turns: [], tasks: [], goals: [],
    plan: { content: "", status: "cleared", updatedAt: "2026-09-01T00:00:00.000Z", lastSequence: 0 },
    todos: [], interactions: [], toolCalls: [], permissions: [],
    ...overrides,
  };
}

describe("presentMemoryInspector", () => {
  it("reports unavailable without host capability metadata", () => {
    expect(presentMemoryInspector(undefined)).toMatchObject({ status: "unavailable" });
  });

  it("renders bounded incomplete/last-good metadata without正文", () => {
    const view = presentMemoryInspector(session({ contextProjectMemory: {
      version: 1, status: "incomplete", scopeKey: "pm_test", entrypointName: "MEMORY.md",
      entrypointBytes: 10, entrypointLines: 1, truncated: false, topicCount: 2,
      scanStatus: "incomplete", usingLastGood: true, recalledTopicIds: ["deploy"], ignored: false,
      updatedAt: "2026-09-01T00:00:01.000Z", lastSequence: 2,
    } }), {
      version: 1,
      session: { version: 1, configured: true, enabled: true, status: "available" },
      project: { version: 1, configured: true, enabled: true, status: "available" },
      scope: { strategy: "workspace-tenant-sha256", keyPrefix: "pm_", digestHexLength: 24 },
    });
    expect(view).toMatchObject({ status: "incomplete", project: { usingLastGood: true } });
    expect(view.detail).not.toContain("body");
  });
});
