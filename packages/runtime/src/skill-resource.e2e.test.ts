import { describe, expect, it } from "vitest";
import { brand, type ChatModel, type ModelRequest, type ModelStreamPart } from "@coding-agent/contracts";
import { estimateContextTokens, renderSkillCatalog, renderSkillContent } from "@coding-agent/context";
import { InMemoryEventStore } from "@coding-agent/storage";
import { SkillRegistry } from "@coding-agent/skills";
import { AgentHost } from "./index.js";

describe("M7 Skill resource multi-step acceptance", () => {
  it("lets the model invoke SkillTool, then explicitly read a reference and script window", async () => {
    const store = new InMemoryEventStore();
    const skills = new SkillRegistry();
    let resourceReads = 0;
    const readPaths: string[] = [];
    const notRequestedResource = "unreferenced resource body";
    const fixtureResources = {
      "references/checklist.md": { content: "checklist item", sizeBytes: 14, mediaType: "text/plain" },
      "scripts/check.ts": { content: "line 201", sizeBytes: 512, truncated: true, mediaType: "text/plain" },
      "references/unread.md": { content: notRequestedResource, sizeBytes: notRequestedResource.length, mediaType: "text/plain" },
    } as const;
    skills.registerProvider({
      name: "m7-fixture",
      list: async () => [{ name: "review", description: "review", source: "local", provider: "m7-fixture", trust: "local", invocation: { modelInvocable: true, userInvocable: true }, rank: 1, locator: "review", resourceBase: { kind: "opaque", description: "fixture" } }],
      get: async (candidate) => ({ ...candidate, content: "Read references/checklist.md and scripts/check.ts only when needed." }),
      readResource: async (_candidate, request) => {
        resourceReads += 1;
        readPaths.push(request.path);
        const resource = fixtureResources[request.path as keyof typeof fixtureResources];
        if (resource === undefined) return { ok: false, error: { code: "SKILL_RESOURCE_NOT_FOUND" as const } };
        return { ok: true, resource: { path: request.path, ...resource } };
      },
    });
    const requests: ModelRequest[] = [];
    const model: ChatModel = {
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        requests.push(request);
        const toolMessages = request.messages.filter((message) => message.role === "tool");
        if (toolMessages.length === 0) {
          yield { type: "tool_call_start", index: 0, id: "m7-skill", name: "skill" };
          yield { type: "tool_call_delta", index: 0, arguments: JSON.stringify({ skill: "review" }) };
          yield { type: "tool_call_end", index: 0 };
        } else if (toolMessages.length === 1) {
          const skillView = toolMessages[0]?.content ?? "";
          if (!skillView.includes("read_skill_resource")) throw new Error("Skill resource hint was not visible to the model");
          yield { type: "tool_call_start", index: 0, id: "m7-reference", name: "read_skill_resource" };
          yield { type: "tool_call_delta", index: 0, arguments: JSON.stringify({ skill: "review", path: "references/checklist.md" }) };
          yield { type: "tool_call_end", index: 0 };
        } else if (toolMessages.length === 2) {
          if (!toolMessages.some((message) => message.content.includes("checklist item"))) throw new Error("Reference body was not visible in the next model step");
          yield { type: "tool_call_start", index: 0, id: "m7-script", name: "read_skill_resource" };
          yield { type: "tool_call_delta", index: 0, arguments: JSON.stringify({ skill: "review", path: "scripts/check.ts", offset: 200, limit: 64 }) };
          yield { type: "tool_call_end", index: 0 };
        } else {
          if (!toolMessages.some((message) => message.content.includes("line 201"))) throw new Error("Script window was not visible in the next model step");
          yield { type: "text_delta", text: "review complete" };
        }
        yield { type: "done" };
      },
    };
    const host = new AgentHost({ store, model, skills, skillToolEnabled: true, skillResourceToolEnabled: true });
    const session = await host.createSession(brand<string, "WorkspaceRoot">("D:/m7-runtime"));
    const turn = await host.sendMessage(session.id, "review this change");
    await host.waitForTurn(turn);
    // R4 fixed case: both expected resources reach the following model step;
    // the fixture provider also has an unreferenced body that must remain absent.
    expect(resourceReads).toBe(2);
    expect(readPaths).toEqual(["references/checklist.md", "scripts/check.ts"]);
    expect(requests).toHaveLength(4);
    expect(requests[1]?.messages.some((message) => message.role === "tool" && message.content.includes("checklist item"))).toBe(false);
    expect(requests.some((request) => request.messages.some((message) => message.content.includes(notRequestedResource)))).toBe(false);
    expect((await host.getSession(session.id))?.messages.at(-1)?.content).toBe("review complete");
    const events = await host.events(session.id);
    expect(JSON.stringify(events)).not.toContain("checklist item");
    expect(JSON.stringify(events)).not.toContain("line 201");
  });

  it("measures the R4 fixed fixture's bounded catalog against a hypothetical full preload", async () => {
    const skills = new SkillRegistry();
    const skillBody = "Read references/checklist.md and scripts/check.ts only when needed.";
    const reference = "checklist item";
    const script = Array.from({ length: 220 }, (_, index) => `export const line${index + 1} = ${index + 1};`).join("\n") + "\n";
    const unreferenced = "never preload this resource";
    skills.registerProvider({
      name: "r4-metric-fixture",
      list: async () => [{ name: "review", description: "Review changes", source: "local", provider: "r4-metric-fixture", trust: "local", invocation: { modelInvocable: true, userInvocable: true }, rank: 1, locator: "review", resourceBase: { kind: "opaque", description: "fixture" } }],
      get: async (candidate) => ({ ...candidate, content: skillBody }),
    });
    const definition = await skills.get("review");
    if (definition === undefined) throw new Error("R4 metric fixture skill was not found");
    const catalog = renderSkillCatalog(await skills.snapshot(), { maxChars: 8_000 }).rendered;
    const resourceView = (resourcePath: string, content: string): string => `<skill_resource skill="review" path=${JSON.stringify(resourcePath)}>\n${content}\n</skill_resource>`;
    // This is a counterfactual initial context: canonical SkillTool rendering
    // plus every resource body, including the one the model never requests.
    const fullPreload = [
      renderSkillContent(definition),
      resourceView("references/checklist.md", reference),
      resourceView("scripts/check.ts", script),
      resourceView("references/unread.md", unreferenced),
    ].join("\n");
    const fullTokens = estimateContextTokens({ messages: [{ role: "system", content: fullPreload }] }).value;
    const catalogTokens = estimateContextTokens({ messages: [{ role: "system", content: catalog }] }).value;

    expect(fullPreload).toHaveLength(6_660);
    expect(fullTokens).toBe(1_669);
    expect(catalog).toBe("/review: Review changes");
    expect(catalog).toHaveLength(23);
    expect(catalogTokens).toBe(10);
    expect((fullTokens - catalogTokens) / fullTokens).toBeCloseTo(0.9940083883, 9);
  });
});
