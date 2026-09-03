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
    expect((result.output as { content: string }).content).toContain("<skill_content name=\"demo\">");
    expect((result.output as { content: string }).content).toContain("<skill_resources>");
    expect((result.output as { content: string }).content).toContain("Use read_skill_resource with skill=\"demo\"");
    expect((result.output as { content: string }).content).toContain("world");
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("Hello world");
  });

  it("does not expand arguments for remote declarative content", async () => {
    const registry = new SkillRegistry();
    registry.register({ name: "remote", description: "remote", content: "Use $ARGUMENTS; never execute !echo", source: "mcp", trust: "remote", metadata: { disableShellExpansion: true } });
    const tool = createSkillTool(registry);
    const result = await tool.execute({ skill: "remote", args: "secret" }, {
      sessionId: brand<string, "SessionId">("s"), toolCallId: brand<string, "ToolCallId">("t"), workspaceRoot: ".", permissionPreset: "read-only", caller: "user", signal: new AbortController().signal,
      reportProgress: async () => undefined,
      appendEvent: async () => undefined,
      requestUserInput: async () => ({ interactionId: brand<string, "InteractionId">("i"), status: "answered", answer: "allow" }),
    });
    expect(result.ok).toBe(true);
    expect((result.output as { content: string }).content).toContain("<skill_instructions>");
    expect((result.output as { content: string }).content).toContain("$ARGUMENTS");
    expect((result.output as { content: string }).content).not.toContain("secret");
  });

  it("supports the explicit v1 renderer rollback", async () => {
    const registry = new SkillRegistry();
    registry.register({ name: "legacy", description: "legacy", content: "Hello $ARGUMENTS", source: "local", trust: "local" });
    const tool = createSkillTool(registry, { rendererVersion: "v1" });
    const result = await tool.execute({ skill: "legacy", args: "world" }, {
      sessionId: brand<string, "SessionId">("s"), toolCallId: brand<string, "ToolCallId">("t"), workspaceRoot: ".", permissionPreset: "read-only", caller: "user", signal: new AbortController().signal,
      reportProgress: async () => undefined,
      appendEvent: async () => undefined,
      requestUserInput: async () => ({ interactionId: brand<string, "InteractionId">("i"), status: "cancelled" }),
    });
    expect(result.ok).toBe(true);
    expect((result.output as { content: string }).content).toBe('<skill name="legacy" source="local">Hello world</skill>');
  });
});
