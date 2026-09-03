import { describe, expect, it } from "vitest";
import { brand, type SkillProvider } from "@coding-agent/contracts";
import { SkillRegistry } from "@coding-agent/skills";
import { createSkillResourceTool } from "./skill-resource.js";

function context(overrides: Partial<Parameters<ReturnType<typeof createSkillResourceTool>["execute"]>[1]> = {}): Parameters<ReturnType<typeof createSkillResourceTool>["execute"]>[1] {
  return {
    sessionId: brand<string, "SessionId">("s"),
    toolCallId: brand<string, "ToolCallId">("t"),
    workspaceRoot: "D:/workspace",
    permissionPreset: "read-only",
    caller: "agent",
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
    appendEvent: async () => undefined,
    requestUserInput: async () => ({ interactionId: brand<string, "InteractionId">("i"), status: "answered", answer: "allow" }),
    ...overrides,
  };
}

function registry(readResource?: SkillProvider["readResource"]): SkillRegistry {
  const skills = new SkillRegistry();
  skills.registerProvider({
    name: "fixture",
    list: async () => [{ name: "review", description: "review", source: "local", provider: "fixture", trust: "local", invocation: { modelInvocable: true, userInvocable: true }, rank: 1, locator: { id: "review" }, resourceBase: { kind: "opaque", description: "fixture" } }],
    get: async (candidate) => ({ ...candidate, content: "instructions", resourceBase: { kind: "opaque", description: "fixture" } }),
    ...(readResource === undefined ? {} : { readResource }),
  });
  return skills;
}

describe("Skill resource tool", () => {
  it("exposes a bounded Skill-relative schema and model-safe result", async () => {
    const tool = createSkillResourceTool(registry(async (_candidate, request) => ({ ok: true, resource: { path: request.path, content: "alpha\nbeta", sizeBytes: 10, truncated: true, mediaType: "text/plain" } })));
    expect(tool.inputSchema).toMatchObject({ required: ["skill", "path"], additionalProperties: false });
    const result = await tool.execute({ skill: "/review", path: "references/checklist.md", offset: 0, limit: 32 }, context());
    expect(result.ok).toBe(true);
    expect(result.modelView).toContain('<skill_resource skill="review" path="references/checklist.md">');
    expect(result.modelView).not.toContain("D:/");
    expect((result.output as { content: string }).content).toBe("alpha\nbeta");
    expect(result.output).toMatchObject({ provider: "fixture" });
  });

  it("rejects unknown, non-model-invocable, unsupported, and unsafe resources", async () => {
    const unsupported = await createSkillResourceTool(registry()).execute({ skill: "review", path: "scripts/check.ts" }, context());
    expect(unsupported).toMatchObject({ ok: false, error: { code: "SKILL_RESOURCE_UNSUPPORTED" } });
    const unknown = await createSkillResourceTool(registry(async () => ({ ok: true, resource: { path: "x", content: "", sizeBytes: 0 } }))).execute({ skill: "missing", path: "x" }, context());
    expect(unknown).toMatchObject({ ok: false, error: { code: "SKILL_RESOURCE_NOT_FOUND" } });
    const unsafe = await createSkillResourceTool(registry(async () => ({ ok: true, resource: { path: "x", content: "", sizeBytes: 0 } }))).execute({ skill: "review", path: "../secret" }, context());
    expect(unsafe).toMatchObject({ ok: false, error: { code: "SKILL_RESOURCE_INVALID_PATH" } });
  });

  it("requires approval for remote/untrusted Skills and honors cancellation", async () => {
    const remote = new SkillRegistry();
    remote.registerProvider({
      name: "remote",
      list: async () => [{ name: "remote", description: "remote", source: "mcp", provider: "remote", trust: "remote", invocation: { modelInvocable: true, userInvocable: true }, rank: 1, locator: "r" }],
      get: async (candidate) => ({ ...candidate, content: "x" }),
      readResource: async (_candidate, request) => ({ ok: true, resource: { path: request.path, content: "x", sizeBytes: 1 } }),
    });
    const denied = await createSkillResourceTool(remote).execute({ skill: "remote", path: "x" }, context({ requestUserInput: async () => ({ interactionId: brand<string, "InteractionId">("i"), status: "cancelled" }) }));
    expect(denied).toMatchObject({ ok: false, error: { code: "SKILL_APPROVAL_DENIED" } });
    const controller = new AbortController(); controller.abort();
    const cancelled = await createSkillResourceTool(registry(async () => ({ ok: true, resource: { path: "x", content: "", sizeBytes: 0 } }))).execute({ skill: "review", path: "x" }, context({ signal: controller.signal }));
    expect(cancelled).toMatchObject({ ok: false, error: { code: "TOOL_CANCELLED" } });
  });
});
