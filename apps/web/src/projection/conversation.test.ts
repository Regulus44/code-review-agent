import { describe, expect, it } from "vitest";
import { brand, type AgentEvent } from "@code-review-agent/contracts";
import { projectConversation } from "./conversation.js";

const sessionId = brand<string, "SessionId">("ses_projection");
const turnId = brand<string, "TurnId">("turn_projection");

function event(sequence: number, type: AgentEvent["type"], payload: Record<string, unknown>): AgentEvent {
  return {
    eventId: `evt_${sequence}`,
    sequence,
    schemaVersion: 1,
    sessionId,
    turnId,
    type,
    createdAt: `2026-08-23T00:00:0${sequence}.000Z`,
    payload,
  };
}

describe("conversation projection", () => {
  it("merges assistant chunks into a stable message node", () => {
    const projection = projectConversation(sessionId, [
      event(1, "assistant/chunk", { text: "one " }),
      event(2, "assistant/chunk", { text: "two" }),
      event(3, "assistant/message", { content: "one two" }),
    ]);

    expect(projection.nodes.filter((node) => node.kind === "assistant")).toHaveLength(1);
    expect(projection.nodes.find((node) => node.kind === "assistant")).toMatchObject({ content: "one two", partial: false });
  });

  it("keeps tool, permission and interaction rows keyed by durable ids", () => {
    const projection = projectConversation(sessionId, [
      event(1, "tool/call", { toolCallId: "tool_1", name: "edit_file", input: { path: "a.ts" }, riskLevel: "write" }),
      event(2, "permission/requested", { permissionId: "perm_1", toolCallId: "tool_1", toolName: "edit_file", reason: "write approval", caller: "agent", workspaceRoot: "D:/workspace", expiresAt: "2026-08-23T00:15:00.000Z" }),
      event(3, "tool/progress", { toolCallId: "tool_1", message: "preparing" }),
      event(4, "interaction/requested", { interactionId: "interaction_1", toolCallId: "tool_1", question: "Continue?", allowFreeform: false, expiresAt: "2026-08-23T00:16:00.000Z" }),
      event(5, "tool/result", { toolCallId: "tool_1", status: "completed", result: { ok: true } }),
    ]);

    expect(projection.tools[0]).toMatchObject({ id: "tool_1", status: "completed", progress: ["preparing"] });
    expect(projection.nodes.find((node) => node.kind === "permission")).toMatchObject({
      caller: "agent",
      workspaceRoot: "D:/workspace",
      expiresAt: "2026-08-23T00:15:00.000Z",
      status: "pending",
    });
    expect(projection.nodes.find((node) => node.kind === "interaction")).toMatchObject({
      allowFreeform: false,
      expiresAt: "2026-08-23T00:16:00.000Z",
      status: "pending",
    });
  });

  it("retains unmapped events as inspectable generic nodes", () => {
    const projection = projectConversation(sessionId, [event(1, "mcp/resource", { uri: "resource://fixture" })]);
    expect(projection.nodes[0]).toMatchObject({ kind: "event", eventType: "mcp/resource" });
  });
});
