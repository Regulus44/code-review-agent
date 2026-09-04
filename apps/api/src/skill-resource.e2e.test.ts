import { describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brand } from "@coding-agent/contracts";
import { SkillRegistry } from "@coding-agent/skills";
import { FileSystemSkillProvider } from "@coding-agent/skills-filesystem";
import { createSkillResourceTool, createSkillTool } from "@coding-agent/tools";
import { InMemoryEventStore } from "@coding-agent/storage";
import { AgentHost } from "@coding-agent/runtime";
import { createApiServer } from "./server.js";

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

  it("projects resource events through API JSON/SSE without正文 or absolute provider paths", async () => {
    const { root } = await fixture();
    let server: Server | undefined;
    try {
      const store = new InMemoryEventStore();
      const skills = new SkillRegistry();
      const host = new AgentHost({ store, skills, skillResourceToolEnabled: true, skillToolEnabled: true });
      server = createApiServer({ store, host });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("M7 API fixture did not bind");
      const base = `http://127.0.0.1:${address.port}`;
      const created = await fetch(`${base}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRoot: root }) });
      const session = await created.json() as { id: string };
      await store.append({ sessionId: brand<string, "SessionId">(session.id), type: "tool/result", payload: { toolCallId: "m7-resource-api", status: "completed", result: { ok: true, output: { skill: "review", path: "references/checklist.md", sizeBytes: 21, digest: "digest-m7", artifact: { kind: "skill-resource", artifactId: "artifact_m7", skill: "review", path: "references/checklist.md", sizeBytes: 21, digest: "digest-m7", artifactAvailable: false } } } } });
      const eventsResponse = await fetch(`${base}/v1/sessions/${session.id}/events?format=json`);
      const events = await eventsResponse.json() as Array<{ type: string; payload: Record<string, unknown> }>;
      const result = events.find((event) => event.type === "tool/result");
      expect(result).toBeDefined();
      expect(JSON.stringify(result)).not.toContain("line-1");
      expect(JSON.stringify(result)).not.toContain(root);
      expect(result?.payload).toMatchObject({ result: { output: { skill: "review", path: "references/checklist.md", digest: expect.any(String) } } });
      const sse = await fetch(`${base}/v1/sessions/${session.id}/events?after_sequence=0`);
      const reader = sse.body?.getReader();
      if (reader === undefined) throw new Error("M7 SSE fixture did not expose a body");
      let text = "";
      for (let attempt = 0; attempt < 20 && !text.includes("event: tool/result"); attempt += 1) {
        const chunk = await reader.read();
        text += new TextDecoder().decode(chunk.value);
        if (chunk.done) break;
      }
      await reader.cancel();
      expect(text).toContain("event: tool/result");
      expect(text).not.toContain("line-1");
      expect(text).not.toContain(root);
    } finally {
      if (server !== undefined) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

});
