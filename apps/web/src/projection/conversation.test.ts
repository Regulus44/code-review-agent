import { describe, expect, it } from "vitest";
import { brand, type AgentEvent } from "@coding-agent/contracts";
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

  it("keeps assistant segments and tools in their original step order", () => {
    const projection = projectConversation(sessionId, [
      event(1, "turn/started", {}),
      event(2, "step/started", { step: 1 }),
      event(3, "assistant/chunk", { text: "before " }),
      event(4, "assistant/message", { content: "before tool" }),
      event(5, "tool/call", { toolCallId: "tool_order", name: "glob", input: { pattern: "*" }, riskLevel: "read" }),
      event(6, "tool/result", { toolCallId: "tool_order", status: "completed", result: { ok: true } }),
      event(7, "step/ended", { step: 1, status: "completed" }),
      event(8, "step/started", { step: 2 }),
      event(9, "assistant/chunk", { text: "after " }),
      event(10, "assistant/message", { content: "after tool" }),
      event(11, "turn/ended", { status: "completed" }),
    ]);

    expect(projection.nodes.map((node) => node.kind)).toEqual(["assistant", "tool", "assistant", "turn"]);
    expect(projection.nodes.filter((node) => node.kind === "assistant").map((node) => "content" in node ? node.content : "")).toEqual(["before tool", "after tool"]);
    expect(projection.nodes.at(-1)).toMatchObject({ kind: "turn", status: "completed" });
  });

  it("does not render an empty assistant node for a tool-only step", () => {
    const projection = projectConversation(sessionId, [
      event(1, "step/started", { step: 1 }),
      event(2, "assistant/message", { content: "", toolCalls: [{ id: "tool_only" }] }),
      event(3, "tool/call", { toolCallId: "tool_only", name: "read_file" }),
    ]);

    expect(projection.nodes.filter((node) => node.kind === "assistant")).toHaveLength(0);
    expect(projection.nodes.filter((node) => node.kind === "tool")).toHaveLength(1);
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

  it("projects steering as a distinct user row", () => {
    const projection = projectConversation(sessionId, [
      event(1, "user/message", { content: "original prompt" }),
      event(2, "turn/steered", { content: "additional guidance", receiptId: "steer_1", status: "accepted" }),
    ]);

    expect(projection.nodes.filter((node) => node.kind === "user").map((node) => "content" in node ? node.content : "")).toEqual(["original prompt", "additional guidance"]);
  });

  it("retains unmapped events as inspectable generic nodes", () => {
    const projection = projectConversation(sessionId, [event(1, "mcp/resource", { uri: "resource://fixture" })]);
    expect(projection.nodes[0]).toMatchObject({ kind: "event", eventType: "mcp/resource" });
  });
});
