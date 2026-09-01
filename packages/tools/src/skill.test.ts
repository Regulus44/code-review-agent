import { describe, expect, it } from "vitest";
import { brand } from "@coding-agent/contracts";
import { SkillRegistry } from "@coding-agent/skills";
import { createSkillTool } from "./skill.js";

describe("SkillTool", () => {
  it("renders inline content while keeping durable events bounded", async () => {
    const registry = new SkillRegistry();
    registry.register({ name: "demo", description: "demo", content: "Hello $ARGUMENTS", source: "local", trust: "local" });
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const tool = createSkillTool(registry);
    const result = await tool.execute({ skill: "demo", args: "world" }, {
      sessionId: brand<string, "SessionId">("s"), toolCallId: brand<string, "ToolCallId">("t"), workspaceRoot: ".", permissionPreset: "read-only", caller: "user", signal: new AbortController().signal,
      reportProgress: async () => undefined,
      appendEvent: async (type, payload) => { events.push({ type, payload: { ...payload } }); },
      requestUserInput: async () => ({ interactionId: brand<string, "InteractionId">("i"), status: "cancelled" }),
    });
    expect(result.ok).toBe(true);
    expect((result.output as { content: string }).content).toContain("world");
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("Hello world");
  });
});
