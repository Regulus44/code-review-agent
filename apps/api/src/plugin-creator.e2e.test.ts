import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { brand, type ChatModel, type ModelRequest, type ModelStreamPart } from "@coding-agent/contracts";
import { InMemoryEventStore } from "@coding-agent/storage";
import { SkillRegistry } from "@coding-agent/skills";
import { defaultSkillFilesystemRoots, FileSystemSkillProvider } from "@coding-agent/skills-filesystem";
import { AgentHost } from "@coding-agent/runtime";

describe("project and host Skill loading", () => {
  it("runs a real AgentHost chain against project plugin-creator resources", async () => {
    const workspaceRoot = findWorkspaceRoot();
    const projectSkillRoot = path.join(workspaceRoot, ".claude", "skills");
    const systemSkillRoot = path.join(os.homedir(), ".codex", "skills", ".system");
    const roots = defaultSkillFilesystemRoots({ cwd: workspaceRoot });
    expect(roots.some((root) => root.kind === "project" && root.path === projectSkillRoot)).toBe(true);
    if (existsSync(systemSkillRoot)) expect(roots.some((root) => root.kind === "bundled" && root.path === systemSkillRoot)).toBe(true);

    const provider = new FileSystemSkillProvider({ roots });
    const skills = new SkillRegistry();
    skills.registerProvider(provider);
    const catalog = await skills.list({ cwd: workspaceRoot });
    const pluginCreator = catalog.find((skill) => skill.name === "plugin-creator");
    expect(pluginCreator?.source).toBe("project");
    const directCandidate = (await provider.list({ cwd: workspaceRoot })).candidates.find((skill) => skill.name === "plugin-creator");
    expect(directCandidate).toBeDefined();
    expect((await provider.readResource!(directCandidate!, { path: "references/plugin-json-spec.md", limit: 320 })).ok).toBe(true);

    const requests: ModelRequest[] = [];
    let finalText = "";
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        const toolMessages = request.messages.filter((message) => message.role === "tool");
        if (toolMessages.length === 0) {
          expect(request.messages.some((message) => message.role === "system" && message.content.includes("/plugin-creator:"))).toBe(true);
          yield { type: "tool_call_start", index: 0, id: "plugin_skill", name: "skill" };
          yield { type: "tool_call_delta", index: 0, arguments: JSON.stringify({ skill: "plugin-creator" }) };
          yield { type: "tool_call_end", index: 0 };
        } else if (toolMessages.length === 1) {
          expect(toolMessages[0]?.content).toContain("read_skill_resource");
          yield { type: "tool_call_start", index: 0, id: "plugin_reference", name: "read_skill_resource" };
          yield { type: "tool_call_delta", index: 0, arguments: JSON.stringify({ skill: "plugin-creator", path: "references/plugin-json-spec.md", limit: 320 }) };
          yield { type: "tool_call_end", index: 0 };
        } else if (toolMessages.length === 2) {
          yield { type: "tool_call_start", index: 0, id: "plugin_script", name: "read_skill_resource" };
          yield { type: "tool_call_delta", index: 0, arguments: JSON.stringify({ skill: "plugin-creator", path: "scripts/validate_plugin.py", offset: 0, limit: 320 }) };
          yield { type: "tool_call_end", index: 0 };
        } else {
          expect(toolMessages[2]?.content).toContain("validate_plugin");
          finalText = "plugin-creator resources loaded";
          yield { type: "text_delta", text: finalText };
        }
        yield { type: "done" };
      },
    };

    const host = new AgentHost({ store: new InMemoryEventStore(), model, skills, skillToolEnabled: true, skillResourceToolEnabled: true });
    const session = await host.createSession(brand<string, "WorkspaceRoot">(workspaceRoot));
    const turn = await host.sendMessage(session.id, "Use plugin-creator and inspect its reference and validation script.");
    await host.waitForTurn(turn);

    expect(requests).toHaveLength(4);
    expect(finalText).toBe("plugin-creator resources loaded");
  });
});

function findWorkspaceRoot(): string {
  let candidate = path.resolve(process.cwd());
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(path.join(candidate, ".claude", "skills", "plugin-creator", "SKILL.md"))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error("Project plugin-creator Skill fixture was not found");
}
