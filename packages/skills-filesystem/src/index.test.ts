import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileSystemSkillProvider } from "./index.js";

async function fixture(): Promise<string> { return mkdtemp(path.join(os.tmpdir(), "skills-s1-")); }
async function skill(root: string, name: string, body = "hello"): Promise<void> {
  const dir = path.join(root, name); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\nwhen_to_use: use ${name}\nallowed-tools: read_file, list_files\n---\n${body}\n`, "utf8");
}

describe("FileSystemSkillProvider", () => {
  it("discovers bounded local skills and loads body on demand", async () => {
    const root = await fixture(); await skill(root, "review-code", "# body");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }] });
    const listed = await provider.list({ cwd: root });
    expect(listed.complete).toBe(true); expect(listed.candidates[0]?.name).toBe("review-code");
    expect(listed.candidates[0]).not.toHaveProperty("content");
    const loaded = await provider.get(listed.candidates[0]!, { cwd: root });
    expect(loaded?.content).toContain("# body"); expect(loaded?.metadata).toMatchObject({ allowedTools: ["read_file", "list_files"] });
  });

  it("keeps the higher-priority (lower rank) root when names collide", async () => {
    const project = await fixture(); const user = await fixture();
    await skill(project, "same", "project body"); await skill(user, "same", "user body");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "user", path: user }, { kind: "project", path: project }] });
    const listed = await provider.list(); expect(listed.candidates).toHaveLength(1);
    expect((await provider.get(listed.candidates[0]!))?.content).toContain("project body");
  });

  it("deduplicates realpaths and keeps last-good results on an incomplete refresh", async () => {
    const root = await fixture(); await skill(root, "one");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }, { kind: "custom", path: root }], limits: { maxSkills: 10 } });
    const first = await provider.list(); expect(first.candidates).toHaveLength(1);
    await symlink(path.join(root, "missing"), path.join(root, "broken"), "junction");
    const second = await provider.refresh(); expect(second.complete).toBe(false); expect(second.candidates.map((c) => c.name)).toEqual(["one"]);
  });

  it("does not reuse a last-good snapshot across workspace cwd contexts", async () => {
    const a = await fixture(); const b = await fixture();
    const aSkills = path.join(a, ".claude", "skills"); await mkdir(aSkills, { recursive: true }); await skill(aSkills, "only-a");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: aSkills }] });
    const first = await provider.list({ cwd: a }); expect(first.candidates.map((item) => item.name)).toEqual(["only-a"]);
    const second = await provider.refresh({ cwd: b }); expect(second.complete).toBe(false); expect(second.candidates).toHaveLength(0);
  });

  it("fails closed for malformed frontmatter, gitignored directories, and size/depth limits", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "ignored"), { recursive: true }); await writeFile(path.join(root, ".gitignore"), "ignored\n", "utf8"); await skill(path.join(root, "ignored"), "hidden");
    await mkdir(path.join(root, "bad"), { recursive: true }); await writeFile(path.join(root, "bad", "SKILL.md"), "no frontmatter", "utf8");
    await skill(root, "huge", "x".repeat(300));
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }], limits: { maxFileBytes: 128 } });
    const result = await provider.list(); expect(result.complete).toBe(false); expect(result.candidates.map((c) => c.name)).not.toContain("hidden"); expect(result.candidates.map((c) => c.name)).not.toContain("huge");
  });

  it("maps Claude-compatible invocation flags into the stable policy", async () => {
    const root = await fixture(); const dir = path.join(root, "flags"); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "---\nname: flags\ndescription: flags\ndisable-model-invocation: true\nuser-invocable: false\n---\nbody\n", "utf8");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }] }); const listed = await provider.list();
    expect(listed.candidates[0]?.invocation).toEqual({ modelInvocable: false, userInvocable: false });
  });
});
