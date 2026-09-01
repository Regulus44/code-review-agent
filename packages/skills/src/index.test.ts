import { describe, expect, it } from "vitest";
import { SkillRegistry, assessSkillPermission } from "./index.js";
import type { SkillCandidate, SkillProvider } from "@coding-agent/contracts";

function candidate(name: string, provider: string, rank: number, content = `${name} body`): SkillCandidate {
  return { name, description: `${name} description`, invocation: { modelInvocable: true, userInvocable: true }, source: "local", provider, trust: "local", rank, locator: { content } };
}

describe("SkillRegistry", () => {
  it("merges scope chain with nearest shadow and deterministic rank", async () => {
    const registry = new SkillRegistry();
    const global: SkillProvider = { name: "global", list: async () => [candidate("same", "global", 50), candidate("zeta", "global", 1)], get: async (entry) => ({ ...entry, content: String((entry.locator as { content: string }).content) }) };
    const scoped: SkillProvider = { name: "scoped", list: async () => [candidate("same", "scoped", 999), candidate("alpha", "scoped", 1)], get: async (entry) => ({ ...entry, content: String((entry.locator as { content: string }).content) }) };
    registry.registerProvider(global);
    registry.registerProvider(scoped, "project");
    const snapshot = await registry.snapshot({ cwd: "C:/workspace", scope: "project" });
    expect(snapshot.complete).toBe(true);
    expect(snapshot.skills.map((item) => item.name)).toEqual(["alpha", "same", "zeta"]);
    expect((await registry.get("same", { scope: "project" }))?.provider).toBe("scoped");
  });

  it("reports provider failures without failing the caller and supports abort", async () => {
    const registry = new SkillRegistry();
    registry.registerProvider({ name: "broken", list: async () => { throw new Error("secret provider detail"); }, get: async () => undefined });
    const snapshot = await registry.snapshot();
    expect(snapshot.complete).toBe(false);
    expect(snapshot.failures).toEqual([{ provider: "broken", code: "provider-failed" }]);
    expect(JSON.stringify(snapshot)).not.toContain("secret provider detail");
    const controller = new AbortController();
    controller.abort();
    await expect(registry.list({ signal: controller.signal })).rejects.toBeDefined();
  });

  it("emits bounded lifecycle changes and applies positive trust policy", () => {
    const registry = new SkillRegistry();
    const events: unknown[] = [];
    registry.subscribe((event) => events.push(event));
    const dispose = registry.register({ name: "demo", description: "demo", content: "body" });
    dispose();
    expect(events).toHaveLength(2);
    expect(assessSkillPermission({ trust: "local", allowedTools: ["read_file", "write_file"], baseAllowedTools: ["read_file"] })).toMatchObject({ decision: "allow", effectiveAllowedTools: ["read_file"] });
    expect(assessSkillPermission({ trust: "remote", allowedTools: ["run_command"] })).toMatchObject({ decision: "ask", reason: "untrusted-source" });
    expect(assessSkillPermission({ trust: "local", unknownProperties: ["shell"] })).toMatchObject({ decision: "ask", reason: "unknown-properties" });
  });
});
