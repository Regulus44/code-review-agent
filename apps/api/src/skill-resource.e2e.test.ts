import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brand } from "@coding-agent/contracts";
import { SkillRegistry } from "@coding-agent/skills";
import { FileSystemSkillProvider } from "@coding-agent/skills-filesystem";
import { createSkillResourceTool, createSkillTool } from "@coding-agent/tools";

function context(workspaceRoot: string, overrides: Partial<Parameters<ReturnType<typeof createSkillResourceTool>["execute"]>[1]> = {}): Parameters<ReturnType<typeof createSkillResourceTool>["execute"]>[1] {
  return {
    sessionId: brand<string, "SessionId">("m7-tools-session"),
    toolCallId: brand<string, "ToolCallId">("m7-tools-call"),
    workspaceRoot,
    permissionPreset: "read-only",
    caller: "agent",
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
    appendEvent: async () => undefined,
    requestUserInput: async () => ({ interactionId: brand<string, "InteractionId">("m7-tools-interaction"), status: "answered", answer: "allow" }),
    ...overrides,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-m7-skill-"));
  const skillDir = path.join(root, ".claude", "skills", "review");
  await mkdir(path.join(skillDir, "references"), { recursive: true });
  await mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: review\ndescription: Review changes\n---\nRead references/checklist.md and scripts/check.ts when needed.\n", "utf8");
  await writeFile(path.join(skillDir, "references", "checklist.md"), "line-1\nline-2\nline-3\n", "utf8");
  await writeFile(path.join(skillDir, "scripts", "check.ts"), Array.from({ length: 220 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n") + "\n", "utf8");
  return { root, skillDir };
}

describe("M7 Skill resource tool acceptance", () => {
  it("invokes SkillTool then reads references and a bounded script window without directory enumeration", async () => {
    const { root } = await fixture();
    try {
      let readCalls = 0;
      const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: path.join(root, ".claude", "skills") }] });
      const originalRead = provider.readResource.bind(provider);
      provider.readResource = async (...args) => { readCalls += 1; return originalRead(...args); };
      const skills = new SkillRegistry();
      skills.registerProvider(provider);
      const skill = createSkillTool(skills);
      const resource = createSkillResourceTool(skills);
      const first = await skill.execute({ skill: "review", args: "the diff" }, context(root) as never);
      expect(first.ok).toBe(true);
      expect(String((first.output as { content: string }).content)).toContain("read_skill_resource");
      expect(readCalls).toBe(0);
      const checklist = await resource.execute({ skill: "review", path: "references/checklist.md" }, context(root) as never);
      expect(checklist).toMatchObject({ ok: true, output: { path: "references/checklist.md", content: "line-1\nline-2\nline-3\n" } });
      const script = await resource.execute({ skill: "review", path: "scripts/check.ts", offset: 200, limit: 64 }, context(root) as never);
      expect(script).toMatchObject({ ok: true, output: { path: "scripts/check.ts", offset: 200, limit: 64, truncated: true } });
      expect(String((script.output as { content: string }).content)).not.toContain("D:/");
      expect(readCalls).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
