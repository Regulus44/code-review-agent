import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileSystemSkillProvider } from "./index.js";

async function fixture(): Promise<string> { return mkdtemp(path.join(os.tmpdir(), "skills-s1-")); }
async function skill(root: string, name: string, body = "hello"): Promise<void> {
  const dir = path.join(root, name); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\nwhen_to_use: use ${name}\nallowed-tools: read_file, list_files\n---\n${body}\n`, "utf8");
}
async function waitForWatch(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 450)); }

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
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }], limits: { maxFileBytes: 128, maxResourceBytes: 128 } });
    const result = await provider.list(); expect(result.complete).toBe(false); expect(result.candidates.map((c) => c.name)).not.toContain("hidden"); expect(result.candidates.map((c) => c.name)).not.toContain("huge");
  });

  it("maps Claude-compatible invocation flags into the stable policy", async () => {
    const root = await fixture(); const dir = path.join(root, "flags"); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "---\nname: flags\ndescription: flags\ndisable-model-invocation: true\nuser-invocable: false\n---\nbody\n", "utf8");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }] }); const listed = await provider.list();
    expect(listed.candidates[0]?.invocation).toEqual({ modelInvocable: false, userInvocable: false });
  });

  it("activates conditional paths only when a changed workspace path matches", async () => {
    const root = await fixture(); const dir = path.join(root, "conditional"); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "---\nname: conditional\ndescription: conditional\npaths: src/**/*.ts\n---\nbody\n", "utf8");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }] });
    const listed = await provider.list({ paths: ["docs/readme.md"] }); expect(listed.candidates).toHaveLength(0);
    const active = await provider.list({ paths: ["src/index.ts"] }); expect(active.candidates.map((item) => item.name)).toEqual(["conditional"]);
  });

  it("reads package resources through the winning skill directory with bounded UTF-8 windows", async () => {
    const root = await fixture(); await skill(root, "review-code");
    const dir = path.join(root, "review-code");
    await mkdir(path.join(dir, "references"), { recursive: true });
    await mkdir(path.join(dir, "scripts"), { recursive: true });
    await writeFile(path.join(dir, "references", "checklist.md"), "alpha\nβeta\ngamma", "utf8");
    await writeFile(path.join(dir, "scripts", "check.ts"), "console.log('ok')", "utf8");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }] });
    const listed = await provider.list();
    expect(listed.candidates[0]?.resourceBase).toEqual({ kind: "directory", path: dir });
    const result = await provider.readResource!(listed.candidates[0]!, { path: "references/checklist.md", offset: 0, limit: 6 });
    expect(result).toEqual({ ok: true, resource: { path: "references/checklist.md", content: "alpha\n", sizeBytes: Buffer.byteLength("alpha\nβeta\ngamma"), truncated: true, mediaType: "text/markdown; charset=utf-8" } });
  });

  it("rejects traversal, absolute, empty, NUL and overlong resource paths", async () => {
    const root = await fixture(); await skill(root, "safe");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }] });
    const candidate = (await provider.list()).candidates[0]!;
    for (const resourcePath of ["", "../secret", "a/../../secret", "/etc/passwd", "C:\\secret", "a\0b", "x".repeat(4097)]) {
      const result = await provider.readResource!(candidate, { path: resourcePath });
      expect(result).toEqual({ ok: false, error: { code: "SKILL_RESOURCE_INVALID_PATH" } });
    }
  });

  it("fails closed for missing, directory, binary and symlink escapes while allowing contained symlinks", async () => {
    const root = await fixture(); const outside = await fixture(); await skill(root, "safe");
    const dir = path.join(root, "safe");
    await mkdir(path.join(dir, "references"), { recursive: true });
    await writeFile(path.join(dir, "references", "ok.txt"), "inside", "utf8");
    await writeFile(path.join(dir, "references", "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }] });
    const candidate = (await provider.list()).candidates[0]!;
    await symlink(path.join(dir, "references"), path.join(dir, "link-in"), "junction");
    await symlink(path.join(outside), path.join(dir, "link-out"), "junction");
    expect((await provider.readResource!(candidate, { path: "references/ok.txt" })).ok).toBe(true);
    expect((await provider.readResource!(candidate, { path: "link-in/ok.txt" })).ok).toBe(true);
    expect(await provider.readResource!(candidate, { path: "link-out/secret.txt" })).toEqual({ ok: false, error: { code: "SKILL_RESOURCE_INVALID_PATH" } });
    expect(await provider.readResource!(candidate, { path: "references/binary.bin" })).toEqual({ ok: false, error: { code: "SKILL_RESOURCE_FAILED" } });
    expect(await provider.readResource!(candidate, { path: "references" })).toEqual({ ok: false, error: { code: "SKILL_RESOURCE_NOT_FOUND" } });
  });

  it("enforces bounded reads and cancellation without exposing filesystem errors", async () => {
    const root = await fixture(); await skill(root, "bounded");
    const dir = path.join(root, "bounded"); await mkdir(path.join(dir, "assets"), { recursive: true });
    await writeFile(path.join(dir, "assets", "large.txt"), "0".repeat(200), "utf8");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }], limits: { maxFileBytes: 128, maxResourceBytes: 128 } });
    const candidate = (await provider.list()).candidates[0]!;
    expect(await provider.readResource!(candidate, { path: "assets/large.txt" })).toEqual({ ok: false, error: { code: "SKILL_RESOURCE_TOO_LARGE" } });
    expect(await provider.readResource!(candidate, { path: "assets/large.txt", offset: 4, limit: 4 })).toMatchObject({ ok: true, resource: { content: "0000", sizeBytes: 200, truncated: true } });
    const controller = new AbortController(); controller.abort();
    await expect(provider.readResource!(candidate, { path: "assets/large.txt" }, { signal: controller.signal })).rejects.toBeDefined();
    await rm(path.join(dir, "assets", "large.txt"));
    expect(await provider.readResource!(candidate, { path: "assets/large.txt", limit: 2 })).toEqual({ ok: false, error: { code: "SKILL_RESOURCE_NOT_FOUND" } });
  });

  it("keeps SKILL.md and resource budgets independent", async () => {
    const root = await fixture(); await skill(root, "independent");
    const dir = path.join(root, "independent"); await mkdir(path.join(dir, "references"), { recursive: true });
    await writeFile(path.join(dir, "references", "note.txt"), "1234567890", "utf8");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }], limits: { maxFileBytes: 256, maxResourceBytes: 4, maxResourcePathBytes: 8 } });
    const listed = await provider.list();
    expect(listed.candidates).toHaveLength(1);
    expect(await provider.readResource!(listed.candidates[0]!, { path: "references/note.txt", limit: 4 })).toEqual({ ok: false, error: { code: "SKILL_RESOURCE_INVALID_PATH" } });
    expect(await provider.readResource!(listed.candidates[0]!, { path: "x.txt", limit: 5 })).toEqual({ ok: false, error: { code: "SKILL_RESOURCE_TOO_LARGE" } });
  });

  it("invalidates once for debounced SKILL.md changes while ignoring deep resource changes", async () => {
    const root = await fixture(); await skill(root, "watched");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }], watch: true });
    const invalidations = vi.fn(); const controller = new AbortController();
    provider.start({ signal: controller.signal, invalidate: invalidations });
    await provider.list(); await waitForWatch();
    await writeFile(path.join(root, "watched", "references.txt"), "resource", "utf8");
    await waitForWatch(); expect(invalidations).not.toHaveBeenCalled();
    await writeFile(path.join(root, "watched", "SKILL.md"), "\nupdated\n", "utf8");
    await writeFile(path.join(root, "watched", "SKILL.md"), "\nupdated-again\n", "utf8");
    await waitForWatch(); expect(invalidations).toHaveBeenCalledTimes(1);
    controller.abort(); provider.dispose();
  });

  it("refreshes watcher coverage after a new skill directory appears and disposes cleanly", async () => {
    const root = await fixture(); await skill(root, "first");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }], watch: true });
    const invalidations = vi.fn(); const controller = new AbortController();
    provider.start({ signal: controller.signal, invalidate: invalidations });
    await provider.list(); await waitForWatch();
    await skill(root, "second"); await waitForWatch();
    expect(invalidations).toHaveBeenCalledTimes(1);
    await provider.list(); await waitForWatch();
    provider.dispose(); const count = invalidations.mock.calls.length;
    await skill(root, "third"); await waitForWatch();
    expect(invalidations).toHaveBeenCalledTimes(count);
    controller.abort();
  });

  it("reports incomplete observation when watcher directory bounds are exceeded", async () => {
    const root = await fixture(); await skill(root, "bounded-watch");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: root }], watch: true, limits: { maxWatchDirectories: 1 } });
    const result = await provider.list();
    expect(result.complete).toBe(false);
    provider.dispose();
  });

  it("watches cwd-derived project Skill roots used by turn-scoped lookups", async () => {
    const configured = await fixture(); const workspace = await fixture();
    const workspaceSkills = path.join(workspace, ".claude", "skills"); await mkdir(workspaceSkills, { recursive: true }); await skill(workspaceSkills, "cwd-watched");
    const provider = new FileSystemSkillProvider({ roots: [{ kind: "project", path: path.join(configured, ".claude", "skills") }], watch: true });
    const invalidations = vi.fn(); const controller = new AbortController(); provider.start({ signal: controller.signal, invalidate: invalidations });
    const listed = await provider.list({ cwd: workspace }); expect(listed.candidates.map((item) => item.name)).toEqual(["cwd-watched"]); await waitForWatch();
    await writeFile(path.join(workspaceSkills, "cwd-watched", "SKILL.md"), "---\nname: cwd-watched\ndescription: changed\n---\nbody\n", "utf8"); await waitForWatch();
    expect(invalidations).toHaveBeenCalledTimes(1); controller.abort();
  });
});
